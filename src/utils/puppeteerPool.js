const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./logger');

puppeteer.use(StealthPlugin());

/**
 * Manages a reusable Puppeteer browser instance.
 * Avoids the cold-start overhead of launching a new browser for every scrape.
 *
 * Usage:
 *   const browser = await pool.acquire();
 *   const page = await browser.newPage();
 *   // ... scrape ...
 *   await page.close();
 *   // Browser stays alive for reuse.
 *   // Call pool.shutdown() when the server exits.
 */
class PuppeteerPool {
  constructor() {
    this._browser = null;
    this._launching = null;
  }

  /**
   * Get (or launch) the shared browser instance.
   * @returns {Promise<import('puppeteer').Browser>}
   */
  async acquire() {
    if (this._browser && this._browser.connected) {
      return this._browser;
    }

    // Prevent multiple simultaneous launches
    if (this._launching) {
      return this._launching;
    }

    this._launching = this._launch();
    this._browser = await this._launching;
    this._launching = null;

    return this._browser;
  }

  async _launch() {
    logger.info('Launching Puppeteer browser (stealth mode)...');

    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    });

    browser.on('disconnected', () => {
      logger.warn('Puppeteer browser disconnected. Will relaunch on next acquire().');
      this._browser = null;
    });

    logger.info('Puppeteer browser launched successfully.');
    return browser;
  }

  /**
   * Close the shared browser instance.
   */
  async shutdown() {
    if (this._browser) {
      logger.info('Shutting down Puppeteer browser...');
      await this._browser.close();
      this._browser = null;
    }
  }
}

// Singleton instance
const pool = new PuppeteerPool();

module.exports = pool;
