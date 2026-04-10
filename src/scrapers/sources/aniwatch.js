const axios = require("axios");
const logger = require("../../utils/logger");
const env = require("../../config/env");

/**
 * Aniwatch (HiAnime) Scraper Module
 * Uses the 'aniwatch' library for robust extraction.
 */

const SOURCE_NAME = "aniwatch";
const BASE_URL = "https://hianime.to"; // Updated base for aniwatch

let scraperPromise = null;

async function getScraper() {
  if (!scraperPromise) {
    // Dynamic import for the aniwatch library
    // We use require because we're in CJS, but if 'aniwatch' is ESM only, 
    // we'd need to handle that. Assuming standard CJS/Hybrid support.
    try {
      const mod = require("aniwatch");
      scraperPromise = new mod.HiAnime.Scraper();
    } catch (e) {
      logger.error(`[${SOURCE_NAME}] Failed to initialize library: ${e.message}`);
      throw e;
    }
  }
  return scraperPromise;
}

/**
 * Proxy helper for subtitles
 */
function getProxiedUrl(targetUrl, referer = "https://megacloud.blog/") {
  // Use the internal proxy route we just created
  const apiBase = "/api/scraper";
  return `${apiBase}/proxy?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}`;
}

async function searchAnime(query) {
  try {
    const scraper = await getScraper();
    const res = await scraper.search(query, 1);
    return (res.animes || []).map((item) => ({
      sourceId: item.id,
      title: item.name,
      url: `${BASE_URL}/anime/${item.id}`,
      image: item.poster,
      type: item.type,
      // Metadata enrichment
      sub: item.episodes?.sub,
      dub: item.episodes?.dub,
    }));
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  }
}

async function getEpisodes(animeUrl) {
  const animeId = animeUrl.split("/").pop();
  try {
    const scraper = await getScraper();
    const res = await scraper.getEpisodes(animeId);
    return (res.episodes || []).map((ep) => ({
      number: ep.number,
      title: ep.title || `Episode ${ep.number}`,
      sourceEpisodeId: ep.episodeId,
      url: `${BASE_URL}/watch/${animeId}?ep=${ep.episodeId}`,
      isFiller: ep.isFiller,
    }));
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Episode list error: ${error.message}`);
    return [];
  }
}

async function getStreamingSources(episodeUrl) {
  // Extract episode ID from URL (e.g. ...?ep=EP_ID or just ending in EP_ID)
  let episodeId = episodeUrl.split("ep=").pop();
  if (!episodeId || episodeId === episodeUrl) {
    episodeId = episodeUrl.split("/").pop();
  }

  try {
    const scraper = await getScraper();
    const candidates = [
      { server: "hd-1", category: "sub" },
      { server: "hd-2", category: "sub" },
      { server: "hd-1", category: "dub" },
      { server: "hd-2", category: "dub" },
    ];

    const links = [];
    let fallbackSubtitles = [];

    for (const cand of candidates) {
      try {
        const payload = await scraper.getEpisodeSources(episodeId, cand.server, cand.category);
        if (!payload?.sources || payload.sources.length === 0) continue;

        const referer = payload.headers?.Referer || "https://megacloud.blog/";
        
        // Process subtitles
        const subtitles = (payload.subtitles || [])
          .filter(s => s.url)
          .map(s => ({
            url: getProxiedUrl(s.url, referer),
            lang: s.lang || s.language || "Unknown",
            default: !!s.default
          }));

        if (cand.category === "sub" && subtitles.length > 0) {
          fallbackSubtitles = subtitles;
        }

        const sourceLinks = payload.sources.map(src => ({
          url: src.url.includes(".m3u8") ? getProxiedUrl(src.url, referer) : src.url,
          quality: src.quality || "default",
          server: `${cand.server} (${cand.category})`,
          type: src.isM3U8 || src.url.includes(".m3u8") ? "hls" : "iframe",
          audio: cand.category,
          subtitles: subtitles.length > 0 ? subtitles : (cand.category === "dub" ? fallbackSubtitles : [])
        }));

        links.push(...sourceLinks);
      } catch (e) {
        // quiet fail for individual servers
      }
    }

    return links;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Source extraction error: ${error.message}`);
    return [];
  }
}

/**
 * Catalog (Latest Updates)
 */
async function getCatalogAnime(maxPages = 2) {
  try {
    const scraper = await getScraper();
    // Use 'recently-updated' or similar from the library
    const res = await scraper.getRecentlyUpdated(1);
    return (res.animes || []).map(item => ({
      sourceId: item.id,
      title: item.name,
      url: `${BASE_URL}/anime/${item.id}`,
      image: item.poster
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Custom URL builder for Aniwatch
 */
function buildEpisodeUrls({ anime, episode }) {
  // Aniwatch IDs are already in the format 'name-id'
  // But they need 'ep=' parameter for the specific episode if available.
  const baseUrl = `${BASE_URL}/watch/${anime.sourceId}`;
  if (episode.sourceEpisodeId && episode.sourceEpisodeId.includes("?ep=")) {
    // If it's a full ID already
    const id = episode.sourceEpisodeId.split("ep=").pop();
    return [`${baseUrl}?ep=${id}`, baseUrl];
  }
  return [`${baseUrl}?ep=${episode.sourceEpisodeId || ""}`, baseUrl];
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
