const axios = require('axios');

/**
 * Kwik Extractor
 *
 * AnimePahe embeds video via kwik.cx. The Kwik page contains a packed
 * JavaScript blob that, when unpacked, contains the .m3u8 source URL.
 *
 * Critical: Kwik validates the `Referer` header. Requests must come from
 * an allowed referrer — animepahe.com works reliably.
 */
class Kwik {
    constructor() {
        this.serverName = 'kwik';
        this.referer = 'https://animepahe.pw/';
        this.client = axios.create({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            },
        });
    }

    /**
     * Extract the direct video stream URL from a Kwik embed page.
     *
     * @param {string|URL} videoUrl - The kwik.cx embed URL
     * @returns {Promise<Array<{url: string, isM3U8: boolean}>>}
     */
    async extract(videoUrl) {
        const urlStr = typeof videoUrl === 'string' ? videoUrl : videoUrl.href;

        try {
            const { data } = await this.client.get(urlStr, {
                headers: { Referer: this.referer },
            });

            const source = this.decodeKwikPage(data);

            if (!source) {
                throw new Error('Failed to decode stream from Kwik page');
            }

            return [{
                url: source,
                isM3U8: source.includes('.m3u8'),
            }];
        } catch (err) {
            // If it's a 403, the referer was rejected. Try kwik.cx itself as referer.
            if (err.response?.status === 403) {
                return this.extractWithAltReferer(urlStr);
            }
            throw err;
        }
    }

    /**
     * Fallback extraction with kwik.cx as its own referer
     */
    async extractWithAltReferer(urlStr) {
        const { data } = await this.client.get(urlStr, {
            headers: { Referer: 'https://kwik.cx/' },
        });

        const source = this.decodeKwikPage(data);
        if (!source) throw new Error('Failed to decode stream from Kwik page (alt referer)');

        return [{
            url: source,
            isM3U8: source.includes('.m3u8'),
        }];
    }

    /**
     * Decode the Kwik page HTML to extract the packed stream URL.
     * Kwik uses a standard p,a,c,k,e,d packer. The result contains:
     *   source='https://...m3u8...'
     */
    decodeKwikPage(html) {
        // Strategy 1: Consumet-proven regex — matches the packed JS block
        // Format: (function(p,a,c,k,e,d){ ... }('...','...'))
        // The `(?<=p}).*((?<=kwik).*)` variant from consumet.ts
        const consumetMatch = html.match(/(?<=p}).*((?<=kwik).*})/g);
        if (consumetMatch) {
            for (const block of consumetMatch) {
                try {
                    const source = this.unpackConsumet(block);
                    if (source) return source;
                } catch (_) {}
            }
        }

        // Strategy 2: Generic packed JS block extraction
        const genericMatches = html.match(/\(function\(p,a,c,k,e,[dr]\)[\s\S]*?\)\s*(?:;|\))/g);
        if (genericMatches) {
            for (const packed of genericMatches) {
                try {
                    const source = this.extractSourceFromPacked(packed);
                    if (source) return source;
                } catch (_) {}
            }
        }

        // Strategy 3: Direct URL pattern (fallback for partially unobfuscated pages)
        const directPatterns = [
            /source=\\?['"]([^'"\\]+\.m3u8[^'"\\]*)\\?['"]/,
            /file:\s*\\?['"]([^'"\\]+\.m3u8[^'"\\]*)\\?['"]/,
            /"(https:\/\/[^"]+\.m3u8[^"]*)"/,
        ];

        for (const pattern of directPatterns) {
            const match = html.match(pattern);
            if (match?.[1]) return match[1];
        }

        return null;
    }

    /**
     * Consumet-style unpacker. Mirrors the logic in consumet.ts's Kwik util.
     * The packed block is split at `return p}(` and the args extracted.
     */
    unpackConsumet(block) {
        // block looks like: ...return p}('...','...' | content of the outer args)
        let arr = block.split('return p}(')[1]?.split(',');
        if (!arr) return null;

        const l = arr.slice(0, arr.length - 5).join('');
        arr = arr.slice(arr.length - 5, -1);
        arr.unshift(l);

        const [p, a, c, k] = arr.map(x => x.split('.sp')[0]);
        const unpacked = this.unpack(p, parseInt(a), parseInt(c), k.replace(/'/g, '').split('|'), 0, {});

        const sourceMatch = unpacked.match(/source=\\?['"]([^'"\\]+)\\?['"]/);
        return sourceMatch?.[1] || null;
    }

    /**
     * Extract stream URL from a packed JS string using p,a,c,k,e,d unpacker.
     */
    extractSourceFromPacked(packed) {
        // Pull out the p,a,c,k,e,d arguments
        // The structure is: (function(p,a,c,k,e,d){ ... }('...', radix, count, '...'.split('|'), 0, {}))
        const argsMatch = packed.match(/\}\s*\(\s*'([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('[\|]'\)/);
        if (!argsMatch) return null;

        const [, p, a, c, k] = argsMatch;
        const unpacked = this.unpack(p, parseInt(a), parseInt(c), k.split('|'), 0, {});

        // Extract source from the unpacked code
        const sourceMatch = unpacked.match(/source=\\?['"]([^'"\\]+)\\?['"]/);
        return sourceMatch?.[1] || null;
    }

    /**
     * Standard p,a,c,k,e,d JavaScript deobfuscator.
     */
    unpack(p, a, c, k) {
        function e(c) {
            return (c < a ? '' : e(Math.floor(c / a))) +
                ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        }

        const d = {};
        while (c--) {
            if (k[c]) d[e(c)] = k[c];
        }

        return p.replace(/\b\w+\b/g, (match) => d[match] || match);
    }
}

module.exports = Kwik;
