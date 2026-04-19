const axios = require('axios');
const { sessionStore } = require('../fetcher');
const puppeteerPool = require('../puppeteerPool');
const logger = require('../logger');

class VidCloud {
  constructor() {
    this.serverName = 'VidCloud';
  }

  async extract(videoUrl) {
    const result = { sources: [], subtitles: [] };
    try {
      const url = new URL(videoUrl);
      const host = url.origin;
      const pathParts = url.pathname.split('/').filter(Boolean);
      const id = pathParts.pop();
      
      const ajaxCandidates = [
          `${host}/ajax/v2/embed-2/getSources?id=${id}`,
          `${host}/ajax/v2/embed-6/getSources?id=${id}`,
          `${host}/v2/ajax/e-1/getSources?id=${id}`,
          `${host}/v2/ajax/e-2/getSources?id=${id}`,
          `${host}/ajax/embed-6/getSources?id=${id}`,
          `${host}/ajax/embed-2/getSources?id=${id}`,
          `${host}/ajax/v2/getSources?id=${id}`
      ];

      // 1. Fast Path: Try AJAX Discovery
      for (const ajaxUrl of ajaxCandidates) {
          try {
              const headers = sessionStore.getHeaders(videoUrl);
              headers['X-Requested-With'] = 'XMLHttpRequest';
              const res = await axios.get(ajaxUrl, { headers, timeout: 5000 });
              if (res.data?.sources || res.data?.link) {
                  return this.processPayload(res.data, videoUrl);
              }
          } catch (err) {}
      }

      // 2. Robust Path: Network Sniffing (Yorumi Protocol)
      logger.warn(`[VidCloud] AJAX failed for ${id}. Falling back to Network Sniffing...`);
      return await this.extractViaSniffing(videoUrl);

    } catch (err) {
      logger.error(`[VidCloud] Extraction Global Error: ${err.message}`);
      return result;
    }
  }

  async extractViaSniffing(embedUrl) {
    const browser = await puppeteerPool.acquire();
    const page = await browser.newPage();
    const result = { sources: [], subtitles: [] };

    try {
      await page.setUserAgent(sessionStore.userAgent);
      await page.setExtraHTTPHeaders({ 'Referer': 'https://aniwatchtv.to/' });

      // Intelligent arrival detection
      const sourceFound = new Promise((resolve) => {
          page.on('response', async res => {
              const url = res.url();
              if (url.includes('.m3u8')) {
                  result.sources.push({ url, isM3U8: true });
                  resolve(true);
              }
              if (url.includes('getSources') && res.status() === 200) {
                  try {
                      const data = await res.json();
                      if (data?.sources) {
                          const processed = this.processPayload(data, embedUrl);
                          processed.sources.forEach(s => result.sources.push(s));
                          processed.subtitles.forEach(s => result.subtitles.push(s));
                          if (result.sources.length > 0) resolve(true);
                      }
                  } catch (e) {}
              }
          });
      });

      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Wait for player interaction if no direct source seen yet
      await page.mouse.click(500, 450).catch(() => {});

      // Race: wait for detection or a shorter fallback timeout
      await Promise.race([
          sourceFound,
          new Promise(r => setTimeout(r, 8000)) // Max 8s wait for sniff
      ]);

      return result;
    } catch (err) {
      logger.error(`[VidCloud] Sniffing failed: ${err.message}`);
      return result;
    } finally {
      await page.close().catch(() => {});
    }
  }

  processPayload(data, referer) {
    const result = { sources: [], subtitles: [] };
    const { sources, tracks } = data;
    if (sources) {
      result.sources = sources.map(s => ({
        url: s.file.includes('.m3u8') 
            ? `/api/scraper/proxy?url=${encodeURIComponent(s.file)}&referer=${encodeURIComponent(referer)}`
            : s.file,
        isM3U8: s.file.includes('.m3u8'),
      })).filter(s => s.url);
    }
    if (tracks) {
      result.subtitles = tracks.map(s => ({
        url: s.file,
        lang: s.label || s.language,
        type: s.kind
      })).filter(s => s.url);
    }
    return result;
  }
}

module.exports = VidCloud;
