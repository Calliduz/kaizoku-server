const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const puppeteerPool = require('./puppeteerPool');
const logger = require('./logger');

// Global axios instance with persistent connection pooling
const client = axios.create({
    httpsAgent: new https.Agent({ 
        keepAlive: true, 
        rejectUnauthorized: false // Allow insecure certs like the Python urllib3 fallback
    }),
    timeout: 15000,
});

/**
 * Singleton Session Store to bridge Puppeteer sessions to Axios
 */
class SessionStore {
    constructor() {
        this.sessionPath = path.join(process.cwd(), 'data', 'session.cache');
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
        this.cookies = '';
        this.saveTimeout = null;
        
        // Ensure data directory exists
        const dataDir = path.dirname(this.sessionPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.load();
        
        if (!this.cookies) {
            this.cookies = this.generateBypassCookie();
            logger.debug(`[SessionStore] Initialized with Zero-Browser bypass cookie.`);
        }
    }

    generateBypassCookie() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let str = '';
        for (let i = 0; i < 16; i++) {
            str += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `__ddg2_=${str}`;
    }

    update(cookies, ua) {
        let changed = false;
        if (cookies && cookies !== this.cookies) {
            this.cookies = cookies;
            changed = true;
        }
        if (ua && ua !== this.userAgent) {
            this.userAgent = ua;
            changed = true;
        }
        if (changed) this.save();
    }

    save() {
        // Debounce disk writes to prevent spamming/I/O overhead
        if (this.saveTimeout) return;
        
        this.saveTimeout = setTimeout(() => {
            try {
                fs.writeFileSync(this.sessionPath, JSON.stringify({ 
                    cookies: this.cookies, 
                    userAgent: this.userAgent 
                }), 'utf8');
                logger.debug('[SessionStore] Session persisted to disk.');
            } catch (e) {
                logger.error(`[SessionStore] Save failed: ${e.message}`);
            } finally {
                this.saveTimeout = null;
            }
        }, 2000); // Only save once every 2 seconds max
    }

    load() {
        try {
            if (fs.existsSync(this.sessionPath)) {
                const data = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
                this.cookies = data.cookies || '';
                this.userAgent = data.userAgent || this.userAgent;
            }
        } catch (e) {}
    }

    getHeaders(referer = '') {
        const headers = {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Cache-Control': 'max-age=0',
            'Upgrade-Insecure-Requests': '1',
        };
        if (this.cookies) headers['Cookie'] = this.cookies;
        if (referer) headers['Referer'] = referer;
        return headers;
    }
}

const sessionStore = new SessionStore();

async function fetchHtml(url, options = {}) {
  const { referer = '', timeout = 12000, fallbackTimeout = 30000, forceBrowser = false } = options;

  if (!forceBrowser) {
    try {
      const response = await client.get(url, {
        headers: sessionStore.getHeaders(referer),
        timeout,
        validateStatus: status => status < 400
      });
      return { html: response.data, $: cheerio.load(response.data) };
    } catch (error) {
       logger.debug(`[Fetcher] Axios failed for ${url}: ${error.message}. Falling back...`);
    }
  }

  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(sessionStore.userAgent);
    
    // Inject current cookies to help Puppeteer bypass existing sessions
    if (sessionStore.cookies) {
        const cookies = sessionStore.cookies.split('; ').map(c => {
            const [name, value] = c.split('=');
            return { name, value: value || '', domain: new URL(url).hostname.replace(/^www\./, '.') };
        });
        await page.setCookie(...cookies).catch(() => {});
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: fallbackTimeout });
    
    // Wait for clearance
    await page.waitForFunction(() => {
        const title = document.title.toLowerCase();
        return !title.includes('just a moment') && !title.includes('cloudflare') && !title.includes('ddos-guard');
    }, { timeout: 15000 }).catch(() => {});

    // Sync Fresh Cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionStore.update(cookieString, await page.evaluate(() => navigator.userAgent));

    const html = await page.content();
    return { html, $: cheerio.load(html) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchJson(url, options = {}) {
  const { referer = '', timeout = 10000, forceBrowser = false } = options;
  
  if (!forceBrowser) {
    try {
      const headers = sessionStore.getHeaders(referer);
      headers['Accept'] = 'application/json, text/plain, */*';
      
      const response = await client.get(url, { headers, timeout });
      return response.data;
    } catch (error) {
       // Fall through
    }
  }

  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(sessionStore.userAgent);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForFunction(() => {
        const text = document.body.innerText.trim();
        return text.startsWith('{') || text.startsWith('[');
    }, { timeout: 15000 }).catch(() => {});

    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sessionStore.update(cookieString, await page.evaluate(() => navigator.userAgent));

    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  fetchHtml,
  fetchJson,
  sessionStore
};
