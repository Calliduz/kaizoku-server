const url = 'https://vault-02.uwucdn.top/stream/02/07/06066df423b4e62d11f7f51cbf665dfc4b1f948f00e95cb20acb64ca89325e60/uwu.m3u8';
const referer = 'https://kwik.cx/e/tv2fKFRR06cC';

function rewriteM3U8(content, baseUrl, referer) {
  const lines = content.split('\n');
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
          try {
            const absoluteUrl = new URL(uri, baseUrl).href;
            const t = Date.now();
            const proxiedUrl = \/api/scraper/proxy?url=\&referer=\&t=\\;
            return \URI="\"\;
          } catch (e) {
            return match;
          }
        });
      }
      return line;
    }

    let absoluteUrl;
    try { absoluteUrl = new URL(trimmed, baseUrl).href; } catch (e) { return line; }

    const t = Date.now();
    return \/api/scraper/proxy?url=\&referer=\&t=\\;
  });
  return rewritten.join('\n');
}

const orig = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="mon.key"\nseg-1.ts\n';
console.log(rewriteM3U8(orig, url, referer));
