const axios = require('axios');
const cheerio = require('cheerio');
const puppeteerPool = require('./puppeteerPool');
const logger = require('./logger');

/**
 * Advanced HTML Fetcher mimicking Yorumi's architecture.
 * Tries a lightning-fast Axios request first.
 * If encountering DDoS protection (Cloudflare/DDoS-Guard 403, 503, etc.)
 * or a captcha page, it gracefully falls back to Puppeteer.
 */

const requestHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHtml(url, options = {}) {
  const { 
    referer = '', 
    timeout = 15000, 
    fallbackTimeout = 30000,
    forceBrowser = false 
  } = options;

  if (!forceBrowser) {
    try {
      const headers = { ...requestHeaders };
      if (referer) headers['Referer'] = referer;

      const response = await axios.get(url, {
        headers,
        timeout,
        responseType: 'text',
        // Don't throw immediately on 403/503 so we can inspect html for cloudflare
        validateStatus: status => status < 500 || status === 503 
      });

      const html = String(response.data || '');
      
      // Look for Cloudflare / DDOS-Guard signatures
      const $ = cheerio.load(html);
      const title = $('title').text().toLowerCase();
      const body = $('body').text().toLowerCase();
      
      const isBlocked = 
        title.includes('just a moment') || 
        title.includes('cloudflare') || 
        title.includes('ddos-guard') ||
        body.includes('checking your browser') ||
        response.status === 403 ||
        response.status === 503;

      if (!isBlocked) {
        return { html, $ };
      }
      logger.warn(`[Fetcher] Cloudflare/DDoS wall detected via Axios for ${url}. Falling back to Puppeteer...`);
    } catch (error) {
      if (error.response && [403, 503].includes(error.response.status)) {
        logger.warn(`[Fetcher] ${error.response.status} via Axios for ${url}. Falling back to Puppeteer...`);
      } else {
        logger.warn(`[Fetcher] Axios failed for ${url} (${error.message}). Falling back to Puppeteer...`);
      }
    }
  } else {
    logger.info(`[Fetcher] Forced browser fetch for ${url}`);
  }

  // Puppeteer Fallback
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(requestHeaders['User-Agent']);
    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }
    
    // Intercept useless resources to speed up headless browser load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: fallbackTimeout });
    
    // Optional bypass wait
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const html = await page.content();
    return { html, $: cheerio.load(html) };
  } catch (error) {
    logger.error(`[Fetcher] Puppeteer fallback failed for ${url}: ${error.message}`);
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fast API Fetcher
 */
async function fetchJson(url, referer = '') {
  try {
    const headers = { ...requestHeaders, 'Accept': 'application/json, text/plain, */*' };
    if (referer) headers['Referer'] = referer;
    
    const response = await axios.get(url, { headers, timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response && [403, 503].includes(error.response.status)) {
        throw new Error(`Cloudflare/DDoS blocked API JSON request for ${url}`);
    }
    throw error;
  }
}

module.exports = {
  fetchHtml,
  fetchJson,
  requestHeaders
};
