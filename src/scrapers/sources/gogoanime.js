const { fetchHtml } = require("../../utils/fetcher");
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
  try {
    const searchUrl = `${BASE_URL}${SEARCH_PATH}${encodeURIComponent(query)}`;
    logger.info(`[${SOURCE_NAME}] Searching: ${searchUrl}`);

    const { $ } = await fetchHtml(searchUrl);
    
    // Check if we got results
    const items = $(SELECTORS.searchResultItem);
    if (!items.length) {
      logger.warn(`[${SOURCE_NAME}] No search results found for "${query}"`);
      return [];
    }

    // Extract search results
    const results = items.map((i, el) => {
      const linkEl = $(el).find(SELECTORS.searchResultLink);
      const imageEl = $(el).find(SELECTORS.searchResultImage);

      const href = linkEl.attr("href") || "";
      const title =
        linkEl.attr("oldtitle") ||
        $(el).find('h2[itemprop="headline"]').text().trim() ||
        "";
      
      const image =
        imageEl.attr("data-src") ||
        imageEl.attr("src") ||
        "";
        
      const slug = href.replace(/\/+$/, "").split("/").pop() || "";

      return {
        sourceId: slug,
        title,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        image,
      };
    }).get();

    logger.info(`[${SOURCE_NAME}] Found ${results.length} results for "${query}"`);
    return results;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  }
}

/**
 * Get episode list for an anime.
 *
 * @param {string} animeUrl - Full URL to the anime detail page
 * @returns {Promise<Array<{ number: number, sourceEpisodeId: string, url: string }>>}
 */
async function getEpisodes(animeUrl) {
  try {
    logger.info(`[${SOURCE_NAME}] Fetching episodes: ${animeUrl}`);
    const { $ } = await fetchHtml(animeUrl);

    const episodeLinks = [];
    $(SELECTORS.episodeItem).each((_, el) => {
      const link = $(el);
      const parent = link.closest(".episode-item");
      const numParse = parent.attr("data-episode-number") || link.text().replace(/\D/g, "");
      const number = parseInt(numParse, 10);

      const href = link.attr("href") || "";
      const sourceEpisodeId = href.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";

      episodeLinks.push({
        number: isNaN(number) ? episodeLinks.length + 1 : number,
        title: link.text().trim() || `Episode ${number}`,
        sourceEpisodeId,
        url: href.startsWith("http") ? href : BASE_URL + href,
      });
    });

    episodeLinks.sort((a, b) => a.number - b.number);
    logger.info(`[${SOURCE_NAME}] Found ${episodeLinks.length} episodes`);
    return episodeLinks;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Episode list error: ${error.message}`);
    return [];
  }
}

/**
 * Get streaming sources for a specific episode.
 *
 * @param {string} episodeUrl - Full URL to the episode page
 * @returns {Promise<Array<{ url: string, quality: string, server: string, type: string }>>}
 */
async function getStreamingSources(episodeUrl) {
  try {
    logger.info(`[${SOURCE_NAME}] Fetching sources: ${episodeUrl}`);
    const { $ } = await fetchHtml(episodeUrl);

    const normalize = (raw) => {
      if (!raw) return "";
      if (raw.startsWith("//")) return `https:${raw}`;
      if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
      return raw;
    };

    const inferType = (url) => {
      if (/\.m3u8(\?|$)/i.test(url)) return "hls";
      if (/\.mp4(\?|$)/i.test(url)) return "mp4";
      if (/\.webm(\?|$)/i.test(url)) return "webm";
      return "iframe";
    };

    const sourcesFromServerList = [];
    $(SELECTORS.serverListItem).each((_, el) => {
      const item = $(el);
      const plainUrl = normalize(item.attr("data-plain-url") || "");
      if (!plainUrl) return;

      const serverLabel = item.text().trim() || "unknown";
      sourcesFromServerList.push({
        url: plainUrl,
        quality: "default",
        server: serverLabel,
        type: inferType(plainUrl),
      });
    });

    // Extract the video iframe src
    const iframeSrc = $(SELECTORS.videoIframe).attr("src") || "";
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

    const candidates = [...sourcesFromServerList, ...(iframeSource ? [iframeSource] : [])];
    
    for (const src of candidates) {
      const key = `${src.type}|${src.url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let proxyTarget = src.url;
      if (src.type === "iframe" && src.url.includes("megavid")) {
        const apiBase = "/api/scraper";
        proxyTarget = `${apiBase}/proxy?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(BASE_URL)}`;
      }

      const lowerUrl = src.url.toLowerCase();
      const lowerEpUrl = episodeUrl.toLowerCase();
      const isDub = lowerUrl.includes("-dub") || lowerEpUrl.includes("-dub");

      deduped.push({
        ...src,
        url: proxyTarget,
        audio: isDub ? "dub" : "sub",
        quality: src.quality === "default" ? "HD" : src.quality,
      });
    }

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
  }
}

/**
 * Crawl catalog pages to fetch many anime series, not just a single search query.
 *
 * @param {number} maxPages
 * @returns {Promise<Array<{ sourceId: string, title: string, url: string, image: string }>>}
 */
async function getCatalogAnime(maxPages = 25) {
  try {
    const all = [];
    const seen = new Set();
    let nextUrl = `${BASE_URL}${CATALOG_PATH}`;
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      pageCount += 1;
      logger.info(`[${SOURCE_NAME}] Catalog page ${pageCount}: ${nextUrl}`);

      const { $ } = await fetchHtml(nextUrl);

      const items = [];
      $(SELECTORS.catalogItem).each((_, el) => {
        const card = $(el);
        const linkEl = card.find(SELECTORS.catalogLink);
        const imageEl = card.find(SELECTORS.catalogImage);

        const href = linkEl.attr("href") || "";
        const title =
          linkEl.attr("oldtitle") ||
          card.find('h2[itemprop="headline"]').text().trim() ||
          "";

        const url = href
          ? href.startsWith("http")
            ? href
            : `${BASE_URL}${href}`
          : "";

        const image =
          imageEl.attr("data-src") ||
          imageEl.attr("src") ||
          "";

        const extractSeriesId = (h) => {
          const cleaned = h.replace(/\/+$/, "");
          return cleaned.split("/").pop() || "";
        };

        const sourceId = href ? extractSeriesId(href) : "";

        if (sourceId && title && url) {
          items.push({ sourceId, title, url, image });
        }
      });

      const nextLink = $(SELECTORS.catalogNextPage).attr("href") || "";
      const nextHref = nextLink
        ? nextLink.startsWith("http")
          ? nextLink
          : `${BASE_URL}${nextLink}`
        : "";

      for (const item of items) {
        if (!seen.has(item.sourceId)) {
          seen.add(item.sourceId);
          all.push(item);
        }
      }

      nextUrl = nextHref;
    }

    logger.info(`[${SOURCE_NAME}] Catalog scrape yielded ${all.length} unique series`);
    return all;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Catalog scrape error: ${error.message}`);
    return [];
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
