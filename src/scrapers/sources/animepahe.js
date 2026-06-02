require('dotenv').config();
const axios = require('axios');
const logger = require('../../utils/logger');
const Kwik = require('../../utils/extractors/kwik');
const puppeteerPool = require('../../utils/puppeteerPool');

const SOURCE_NAME = 'animepahe';
const BASE_URL = 'https://animepahe.pw';
const kwikExtractor = new Kwik();

// ── Cookie Store ──────────────────────────────────────────────────────────────
// DDoS-Guard validates __ddg1_ (a JS challenge token). Axios can't solve it.
// We use real browser cookies either from:
//   A) ANIMEPAHE_COOKIES env var (manual paste — good for hours)
//   B) Puppeteer fallback (auto-refreshes when A expires)

const cookieStore = {
    cookies: process.env.ANIMEPAHE_COOKIES || '',
    lastRefresh: process.env.ANIMEPAHE_COOKIES ? Date.now() : 0,
    refreshing: null,
    TTL: 90 * 60 * 1000, // 90 minutes

    isStale() {
        return !this.cookies || (Date.now() - this.lastRefresh > this.TTL);
    },

    set(cookieString) {
        this.cookies = cookieString;
        this.lastRefresh = Date.now();
        logger.info(`[${SOURCE_NAME}] Cookie store updated.`);
    },

    /** Refresh via Puppeteer — acquires a real browser to solve the DDoS-Guard challenge */
    async refresh() {
        if (this.refreshing) return this.refreshing;

        this.refreshing = (async () => {
            logger.warn(`[${SOURCE_NAME}] Cookie store stale — launching browser to refresh...`);
            const browser = await puppeteerPool.acquire();
            const page = await browser.newPage();
            try {
                await page.setUserAgent(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
                );
                await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

                // Wait for DDoS-Guard challenge to resolve (title won't say "DDoS")
                await page.waitForFunction(
                    () => !document.title.toLowerCase().includes('ddos') && document.body.innerText.length > 100,
                    { timeout: 20000 }
                ).catch(() => {});

                const raw = await page.cookies();
                const cookieString = raw.map(c => `${c.name}=${c.value}`).join('; ');
                this.set(cookieString);
            } finally {
                await page.close().catch(() => {});
                this.refreshing = null;
            }
        })();

        return this.refreshing;
    },

    /** Ensure cookies are fresh before any request */
    async ensure() {
        if (this.isStale()) await this.refresh();
    },
};

// ── Shared Axios Client ───────────────────────────────────────────────────────
const client = axios.create({
    baseURL: BASE_URL,
    timeout: 12000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.8',
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'upgrade-insecure-requests': '1',
    },
});

/**
 * Make an API GET request with DDoS-Guard session cookies.
 * Auto-refreshes cookies on 403 and retries once.
 */
async function apiGet(path, isJson = true) {
    await cookieStore.ensure();

    const headers = {
        'Cookie': cookieStore.cookies,
        'Referer': BASE_URL,
        'Accept': isJson
            ? 'application/json, text/plain, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    try {
        const { data } = await client.get(path, { headers });
        return data;
    } catch (err) {
        if (err.response?.status === 403 || err.response?.status === 401) {
            logger.warn(`[${SOURCE_NAME}] ${err.response.status} on "${path}" — refreshing cookies and retrying...`);
            cookieStore.lastRefresh = 0; // Force stale
            await cookieStore.ensure();
            const { data } = await client.get(path, {
                headers: {
                    ...headers,
                    'Cookie': cookieStore.cookies,
                },
            });
            return data;
        }
        throw err;
    }
}

// ── Source Cache (5 min TTL) ──────────────────────────────────────────────────
const sourceCache = new Map();
const SOURCE_CACHE_TTL = 5 * 60 * 1000;
function getCached(key) {
    const h = sourceCache.get(key);
    return h && Date.now() - h.ts < SOURCE_CACHE_TTL ? h.data : null;
}
function setCache(key, data) { sourceCache.set(key, { data, ts: Date.now() }); }

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────────────────
async function searchAnime(query) {
    try {
        const cleanedQuery = query.replace(/cour\s*(\d+)/i, 'Part $1').replace(/season\s*(\d+)/i, 'Season $1').trim();
        let data = await apiGet(`/api?m=search&q=${encodeURIComponent(cleanedQuery)}`);
        
        if (!data?.data || data.data.length === 0) {
            const broaderQuery = query.replace(/(cour|season|part)\s*\d+/i, '').trim();
            if (broaderQuery && broaderQuery !== query) {
                data = await apiGet(`/api?m=search&q=${encodeURIComponent(broaderQuery)}`);
            }
        }
        return data?.data?.map((item) => ({
            sourceId: item.session,
            title: item.title,
            url: `${BASE_URL}/anime/${item.session}`,
            image: item.poster,
            type: item.type,
        })) || [];
    } catch (err) {
        logger.error(`[${SOURCE_NAME}] searchAnime error: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPISODES  (parallel page fetch)
// ─────────────────────────────────────────────────────────────────────────────
async function getEpisodes(animeUrlOrId) {
    try {
        const id = animeUrlOrId.includes('/anime/')
            ? animeUrlOrId.split('/').pop()
            : animeUrlOrId;

        const first = await apiGet(`/api?m=release&id=${id}&sort=episode_asc&page=1`);
        if (!first?.data) return [];

        let eps = [...first.data];
        const lastPage = first.last_page || 1;

        if (lastPage > 1) {
            const pages = await Promise.all(
                Array.from({ length: lastPage - 1 }, (_, i) =>
                    apiGet(`/api?m=release&id=${id}&sort=episode_asc&page=${i + 2}`)
                        .then(d => d?.data || [])
                        .catch(() => [])
                )
            );
            for (const p of pages) eps = eps.concat(p);
        }

        return eps.map((item) => ({
            number: item.episode,
            title: item.title || `Episode ${item.episode}`,
            sourceEpisodeId: item.session,
            url: `${BASE_URL}/play/${id}/${item.session}`,
            thumbnail: item.snapshot,
        }));
    } catch (err) {
        logger.error(`[${SOURCE_NAME}] getEpisodes error: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAMING SOURCES  — parse #resolutionMenu from the play page
//
//  The /api?m=links endpoint is unavailable on .pw. Instead we load the
//  play page with Axios (cookies bypass DDoS-Guard instantly) and parse
//  the Kwik URLs from the <button data-src> elements (~300ms total).
//  All Kwik decoding runs in PARALLEL → sub-second stream list.
// ─────────────────────────────────────────────────────────────────────────────
async function getStreamingSources(episodeUrlOrSession) {
    const playUrl = buildPlayUrl(episodeUrlOrSession);
    if (!playUrl) {
        logger.error(`[${SOURCE_NAME}] Cannot build play URL from: ${episodeUrlOrSession}`);
        return [];
    }

    const cacheKey = extractSession(episodeUrlOrSession) || playUrl;
    const cached = getCached(cacheKey);
    if (cached) {
        logger.debug(`[${SOURCE_NAME}] Cache hit for: ${cacheKey}`);
        return cached;
    }

    try {
        logger.debug(`[${SOURCE_NAME}] Loading play page: ${playUrl}`);
        const html = await apiGet(playUrl, false /* want HTML, not JSON */);

        const cheerio = require('cheerio');
        const $ = cheerio.load(html);

        const links = [];
        $('#resolutionMenu button[data-src]').each((_, el) => {
            const kwikUrl = $(el).attr('data-src');
            const resolution = $(el).attr('data-resolution') || '720';
            const audio = $(el).attr('data-audio') || 'jpn';
            if (kwikUrl && kwikUrl.includes('kwik')) links.push({ quality: resolution, kwikUrl, audio, referer: playUrl });
        });

        if (links.length === 0) {
            logger.warn(`[${SOURCE_NAME}] No Kwik links found in play page: ${playUrl}`);
            return [];
        }

        logger.info(`[${SOURCE_NAME}] Found ${links.length} Kwik links. Resolving streams in parallel...`);
        const sources = await resolveKwikLinks(links);

        if (sources.length > 0) setCache(cacheKey, sources);
        return sources;
    } catch (err) {
        logger.error(`[${SOURCE_NAME}] getStreamingSources error: ${err.message}`);
        return [];
    }
}

async function resolveKwikLinks(links) {
    const settled = await Promise.allSettled(
        links.map(async (link) => {
            try {
                const extracted = await kwikExtractor.extract(link.kwikUrl);
                if (!extracted?.length) throw new Error('Empty extraction');

                const { url: directUrl, isM3U8 } = extracted[0];
                const qualityLabel = link.quality.includes('p') ? link.quality : `${link.quality}p`;

                return {
                    url: isM3U8
                        ? `/api/scraper/proxy?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(link.kwikUrl)}`
                        : directUrl,
                    quality: qualityLabel,
                    server: 'kwik',
                    type: isM3U8 ? 'hls' : 'mp4',
                    audio: link.audio === 'jpn' ? 'sub' : 'dub',
                };
            } catch (err) {
                // Graceful fallback: expose the iframe URL — the client can render it
                logger.warn(`[${SOURCE_NAME}] Kwik extract failed (${link.kwikUrl}): ${err.message}`);
                return {
                    url: link.kwikUrl,
                    quality: link.quality.includes('p') ? link.quality : `${link.quality}p`,
                    server: 'kwik',
                    type: 'iframe',
                    audio: link.audio === 'jpn' ? 'sub' : 'dub',
                };
            }
        })
    );

    return settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG
// ─────────────────────────────────────────────────────────────────────────────
async function getCatalogAnime(page = 1) {
    try {
        const data = await apiGet(`/api?m=release&sort=episode_desc&page=${page}`);
        return data?.data?.map(item => ({
            sourceId: item.anime_session || item.session,
            title: item.anime_title || item.title,
            url: `${BASE_URL}/anime/${item.anime_session || item.session}`,
            image: item.snapshot || item.poster,
        })) || [];
    } catch (err) {
        logger.error(`[${SOURCE_NAME}] getCatalogAnime error: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────
function buildEpisodeUrls({ episode, anime }) {
    const urls = [];
    // Prefer the stored play URL
    if (episode.url) {
        urls.push(episode.url);
    }
    // Deep fallback: Reconstruct URL from old database entries
    else if (episode.sourceEpisodeId && anime && anime.sourceId) {
        urls.push(`${BASE_URL}/play/${anime.sourceId}/${episode.sourceEpisodeId}`);
    }
    return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If input is already a full play URL, return it.
 * If it's a bare session ID we can't build the URL (need both anime+episode),
 * so we return null and let the engine fall through to deep discovery.
 */
function buildPlayUrl(input) {
    if (!input) return null;
    if (input.startsWith('http')) return input; // already a full URL
    // Can't reconstruct play URL from session alone — return null
    return null;
}

function extractSession(input) {
    if (!input) return null;
    if (input.startsWith('http')) return input.replace(/\/$/, '').split('/').pop() || null;
    return input; // already a session ID
}

module.exports = {
    name: SOURCE_NAME,
    BASE_URL,
    searchAnime,
    getEpisodes,
    getStreamingSources,
    getCatalogAnime,
    buildEpisodeUrls,
};
