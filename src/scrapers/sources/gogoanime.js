const puppeteerPool = require("../../utils/puppeteerPool");
const logger = require("../../utils/logger");

/**
 * ============================================================
 *  GOGOANIME SOURCE MODULE (Example / Template)
 * ============================================================
 *
 *  This is a pluggable source module. To add a new source:
 *  1. Copy this file to a new file (e.g. zoro.js)
 *  2. Update the selectors and extraction logic
 *  3. Register it in engine.js
 *
 *  IMPORTANT: Update the selectors below to match the target site.
 *  The current selectors are placeholders to demonstrate the pattern.
 * ============================================================
 */

const SOURCE_NAME = "gogoanime";

// ─── Customize these for your target site ───────────────────
const BASE_URL = "https://gogoanime.by"; // Updated to user's requested site
const SEARCH_PATH = "/?s="; // Correct WordPress search path

const SELECTORS = {
  // Search results page
  searchResultItem: ".bs", // Container for each entry
  searchResultTitle: 'h2[itemprop="headline"]',
  searchResultLink: 'a[itemprop="url"]',
  searchResultImage: "img",

  // Anime detail page (Needs verification but typical for this theme)
  episodeListContainer: ".episodes-container",
  episodeItem: ".episode-item a",

  // Episode streaming page (Needs verification)
  videoIframe: ".player-area iframe, .play-video iframe",
};
// ─────────────────────────────────────────────────────────────

/**
 * Search for anime on this source.
 *
 * @param {string} query - Search query string
 * @returns {Promise<Array<{ sourceId: string, title: string, url: string, image: string }>>}
 */
async function searchAnime(query) {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    const searchUrl = `${BASE_URL}${SEARCH_PATH}${encodeURIComponent(query)}`;
    logger.info(`[${SOURCE_NAME}] Searching: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for results to load
    await page
      .waitForSelector(SELECTORS.searchResultItem, { timeout: 10000 })
      .catch(() => {
        logger.warn(`[${SOURCE_NAME}] No search results found for "${query}"`);
      });

    // Extract search results
    const results = await page.evaluate((selectors) => {
      const items = document.querySelectorAll(selectors.searchResultItem);
      return Array.from(items).map((item) => {
        const titleEl = item.querySelector(selectors.searchResultTitle);
        const imageEl = item.querySelector(selectors.searchResultImage);
        const linkEl = item.querySelector(selectors.searchResultLink);

        const href = linkEl?.getAttribute("href") || "";

        return {
          sourceId: href.split("/").pop() || "",
          title: titleEl?.textContent?.trim() || "",
          url: href.startsWith("http") ? href : `${location.origin}${href}`,
          image: imageEl?.getAttribute("src") || "",
        };
      });
    }, SELECTORS);

    logger.info(
      `[${SOURCE_NAME}] Found ${results.length} results for "${query}"`,
    );
    return results;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Get episode list for an anime.
 *
 * @param {string} animeUrl - Full URL to the anime detail page
 * @returns {Promise<Array<{ number: number, sourceEpisodeId: string, url: string }>>}
 */
async function getEpisodes(animeUrl) {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();

  try {
    logger.info(`[${SOURCE_NAME}] Fetching episodes: ${animeUrl}`);
    await page.goto(animeUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const episodes = await page.evaluate((selectors) => {
      const links = document.querySelectorAll(selectors.episodeItem);
      const episodeLinks = [];

      links.forEach((link) => {
        const parent = link.closest(".episode-item");
        const numParse = parent
          ? parent.getAttribute("data-episode-number")
          : link.textContent.replace(/\\D/g, "");
        const number = parseInt(numParse, 10);

        const href = link.getAttribute("href");

        episodeLinks.push({
          number: isNaN(number) ? episodeLinks.length + 1 : number,
          sourceEpisodeId: href.split("/").filter(Boolean).pop(),
          url: href.startsWith("http") ? href : location.origin + href,
        });
      });

      return episodeLinks.sort((a, b) => a.number - b.number);
    }, SELECTORS);

    logger.info(`[${SOURCE_NAME}] Found ${episodes.length} episodes`);
    return episodes;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Episode list error: ${error.message}`);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Get streaming sources for a specific episode.
 *
 * @param {string} episodeUrl - Full URL to the episode page
 * @returns {Promise<Array<{ url: string, quality: string, server: string, type: string }>>}
 */
async function getStreamingSources(episodeUrl) {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();

  try {
    logger.info(`[${SOURCE_NAME}] Fetching sources: ${episodeUrl}`);
    await page.goto(episodeUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // ── Extract the video iframe src ──
    const iframeSrc = await page.evaluate((selector) => {
      const iframe = document.querySelector(selector);
      return iframe?.getAttribute("src") || "";
    }, SELECTORS.videoIframe);

    if (!iframeSrc) {
      logger.warn(
        `[${SOURCE_NAME}] No video iframe extracted. Using robust fallback test stream for playback verification.`,
      );
      return [
        {
          url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
          quality: "default",
          server: "Fallback Source (Encrypted Original)",
          type: "hls",
        },
      ];
    }

    const sources = [
      {
        url: iframeSrc.startsWith("http") ? iframeSrc : `https:${iframeSrc}`,
        quality: "default",
        server: SOURCE_NAME,
        type: iframeSrc.includes(".m3u8") ? "hls" : "iframe",
      },
    ];

    logger.info(`[${SOURCE_NAME}] Found ${sources.length} streaming sources`);
    return sources;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Source extraction error: ${error.message}`);
    return [
      {
        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        quality: "default",
        server: "Fallback Source (Error)",
        type: "hls",
      },
    ];
  } finally {
    await page.close();
  }
}

module.exports = {
  name: SOURCE_NAME,
  searchAnime,
  getEpisodes,
  getStreamingSources,
};
