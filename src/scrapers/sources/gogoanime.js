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
const CATALOG_PATH = "/series/?order=update";

const SELECTORS = {
  // Search results page
  searchResultItem: ".bs", // Container for each entry
  // Title: use oldtitle attribute on a.tip (clean, no whitespace noise)
  searchResultLink: "a.tip, a[itemprop='url']",
  searchResultImage: "img",

  // Catalog pages
  catalogItem: ".listupd article.bs, .listupd .bsx, article.bs",
  catalogLink: "a.tip, a[itemprop='url']",
  catalogImage: "img",
  catalogNextPage: ".hpage a.r, .hpage a.next, a.next.page-numbers",

  // Anime detail page — confirmed selectors from live DOM inspection
  episodeListContainer: ".episodes-container",
  episodeItem: ".episode-item a",
  episodeNumber: ".episode-item", // has data-episode-number attribute

  // Episode streaming page — confirmed selectors from live DOM inspection
  // Active server iframe is inside .player-embed; other servers have data-plain-url
  videoIframe: ".player-embed iframe",
  serverListItem: ".player-type-link",
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
        const linkEl = item.querySelector(selectors.searchResultLink);
        const imageEl = item.querySelector(selectors.searchResultImage);

        const href = linkEl?.getAttribute("href") || "";
        // Prefer oldtitle attribute (clean title, no whitespace noise)
        const title =
          linkEl?.getAttribute("oldtitle") ||
          item.querySelector('h2[itemprop="headline"]')?.textContent?.trim() ||
          "";
        // Support lazy-loaded images via data-src
        const image =
          imageEl?.getAttribute("data-src") ||
          imageEl?.getAttribute("src") ||
          "";
        // Extract series slug from URL: /series/one-piece-1/ → one-piece-1
        const slug = href.replace(/\/+$/, "").split("/").pop() || "";

        return {
          sourceId: slug,
          title,
          url: href.startsWith("http") ? href : `${location.origin}${href}`,
          image,
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
    await page.close().catch(() => {});
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
        // data-episode-number is the most reliable source
        const numParse = parent?.getAttribute("data-episode-number") ||
          link.textContent.replace(/\D/g, "");
        const number = parseInt(numParse, 10);

        const href = link.getAttribute("href") || "";
        // sourceEpisodeId = full slug like "one-piece-episode-1156-english-subbed"
        const sourceEpisodeId = href.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";

        episodeLinks.push({
          number: isNaN(number) ? episodeLinks.length + 1 : number,
          title: link.textContent?.trim() || `Episode ${number}`,
          sourceEpisodeId,
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
    await page.close().catch(() => {});
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

    // Give dynamic player nav a moment to mount data attributes.
    await page.waitForSelector("body", { timeout: 5000 }).catch(() => {});

    const sourcesFromServerList = await page.evaluate((selectors) => {
      const normalize = (raw) => {
        if (!raw) return "";
        if (raw.startsWith("//")) return `https:${raw}`;
        if (raw.startsWith("/")) return `${location.origin}${raw}`;
        return raw;
      };

      const inferType = (url) => {
        if (/\.m3u8(\?|$)/i.test(url)) return "hls";
        if (/\.mp4(\?|$)/i.test(url)) return "mp4";
        if (/\.webm(\?|$)/i.test(url)) return "webm";
        return "iframe";
      };

      const items = Array.from(
        document.querySelectorAll(selectors.serverListItem),
      );
      const out = [];

      items.forEach((item) => {
        const plainUrl = normalize(item.getAttribute("data-plain-url") || "");
        // Skip items with no direct URL (active server uses iframe instead)
        if (!plainUrl) return;

        const serverLabel = (item.textContent || "").trim() || "unknown";
        out.push({
          url: plainUrl,
          quality: "default",
          server: serverLabel,
          type: inferType(plainUrl),
        });
      });

      return out;
    }, SELECTORS);

    // ── Extract the video iframe src ──
    const iframeSrc = await page.evaluate((selector) => {
      const iframe = document.querySelector(selector);
      return iframe?.getAttribute("src") || "";
    }, SELECTORS.videoIframe);

    const normalizedIframe = iframeSrc
      ? iframeSrc.startsWith("http")
        ? iframeSrc
        : iframeSrc.startsWith("//")
          ? `https:${iframeSrc}`
          : `${BASE_URL}${iframeSrc}`
      : "";

    const iframeSource = normalizedIframe
      ? {
          url: normalizedIframe,
          quality: "default",
          server: SOURCE_NAME,
          type: normalizedIframe.includes(".m3u8") ? "hls" : "iframe",
        }
      : null;

    const deduped = [];
    const seen = new Set();

    for (const src of [
      ...sourcesFromServerList,
      ...(iframeSource ? [iframeSource] : []),
    ]) {
      const key = `${src.type}|${src.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      
      // Smart Audio Detection: Gogoanime usually has "-dub" or "-english-dub" in the URL
      const lowerUrl = src.url.toLowerCase();
      const lowerEpUrl = episodeUrl.toLowerCase();
      const isDub = lowerUrl.includes("-dub") || lowerEpUrl.includes("-dub");
      
      deduped.push({
        ...src,
        audio: isDub ? "dub" : "sub",
        quality: src.quality === "default" ? "HD" : src.quality
      });
    }

    // Prefer direct streams before iframe embeds.
    deduped.sort((a, b) => {
      const rank = (type) =>
        type === "hls" || type === "mp4" || type === "webm" ? 0 : 1;
      return rank(a.type) - rank(b.type);
    });

    logger.info(`[${SOURCE_NAME}] Found ${deduped.length} streaming sources`);
    return deduped;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Source extraction error: ${error.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Crawl catalog pages to fetch many anime series, not just a single search query.
 *
 * @param {number} maxPages
 * @returns {Promise<Array<{ sourceId: string, title: string, url: string, image: string }>>}
 */
async function getCatalogAnime(maxPages = 25) {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();

  try {
    const all = [];
    const seen = new Set();

    let nextUrl = `${BASE_URL}${CATALOG_PATH}`;
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      pageCount += 1;
      logger.info(`[${SOURCE_NAME}] Catalog page ${pageCount}: ${nextUrl}`);

      await page.goto(nextUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await page
        .waitForSelector(SELECTORS.catalogItem, { timeout: 10000 })
        .catch(() => {});

      const { items, next } = await page.evaluate((selectors) => {
        const extractSeriesId = (href) => {
          const cleaned = href.replace(/\/+$/, "");
          return cleaned.split("/").pop() || "";
        };

        const cards = Array.from(
          document.querySelectorAll(selectors.catalogItem),
        );
        const mapped = cards
          .map((card) => {
            const linkEl = card.querySelector(selectors.catalogLink);
            const imageEl = card.querySelector(selectors.catalogImage);
            const href = linkEl?.getAttribute("href") || "";
            // Use oldtitle for clean title (no whitespace noise from child elements)
            const title =
              linkEl?.getAttribute("oldtitle") ||
              card.querySelector('h2[itemprop="headline"]')?.textContent?.trim() ||
              "";
            const url = href
              ? href.startsWith("http")
                ? href
                : `${location.origin}${href}`
              : "";
            // Support lazy-loaded images
            const image =
              imageEl?.getAttribute("data-src") ||
              imageEl?.getAttribute("src") ||
              "";
            return {
              sourceId: href ? extractSeriesId(href) : "",
              title,
              url,
              image,
            };
          })
          .filter((item) => item.sourceId && item.title && item.url);

        const nextLink = document.querySelector(selectors.catalogNextPage);
        const nextHref = nextLink?.getAttribute("href") || "";
        const nextUrl = nextHref
          ? nextHref.startsWith("http")
            ? nextHref
            : `${location.origin}${nextHref}`
          : "";

        return { items: mapped, next: nextUrl };
      }, SELECTORS);

      for (const item of items) {
        if (seen.has(item.sourceId)) continue;
        seen.add(item.sourceId);
        all.push(item);
      }

      nextUrl = next;
    }

    logger.info(
      `[${SOURCE_NAME}] Catalog scrape yielded ${all.length} unique series`,
    );
    return all;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Catalog scrape error: ${error.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Build candidate episode URLs for this source.
 *
 * @param {{ anime: any, episode: any, fallbackUrl: string }} params
 * @returns {string[]}
 */
function buildEpisodeUrls({ anime, episode, fallbackUrl }) {
  const urls = [];

  // Primary: use the stored sourceEpisodeId (full slug like one-piece-episode-1-english-subbed)
  if (episode?.sourceEpisodeId) {
    const directUrl = `${BASE_URL}/${episode.sourceEpisodeId}`;
    urls.push(directUrl);
    // If it doesn't already have -english-subbed variant, try that too
    if (!episode.sourceEpisodeId.includes("english-subbed")) {
      urls.push(`${directUrl}-english-subbed`);
    }
  }

  // Secondary: derive slug from anime.sourceId by stripping trailing -N suffix
  // e.g. "one-piece-1" → "one-piece", "naruto" → "naruto"
  if (anime?.sourceId) {
    const baseSlug = anime.sourceId.replace(/-\d+$/, "");
    const derivedUrl = `${BASE_URL}/${baseSlug}-episode-${episode.number}-english-subbed`;
    urls.push(derivedUrl);
    urls.push(`${BASE_URL}/${baseSlug}-episode-${episode.number}`);
  }

  // Tertiary: use explicit fallbackUrl if provided
  if (fallbackUrl) {
    if (!fallbackUrl.includes("english-subbed")) {
      urls.push(`${fallbackUrl}-english-subbed`);
    }
    urls.push(fallbackUrl);
  }

  return [...new Set(urls)];
}

module.exports = {
  name: SOURCE_NAME,
  BASE_URL,
  searchAnime,
  getCatalogAnime,
  buildEpisodeUrls,
  getEpisodes,
  getStreamingSources,
};
