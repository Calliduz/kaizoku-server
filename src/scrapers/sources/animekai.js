const axios = require("axios");
const cheerio = require("cheerio");
const { ANIME } = require("@consumet/extensions");
const logger = require("../../utils/logger");

/**
 * AnimeKai Scraper Module
 * Hybrid implementation using Consumet + Manual Encryption Bypass.
 */

const SOURCE_NAME = "animekai";
const BASE_URL = "https://anikai.to";
const ENC_DEC_BASE = "https://enc-dec.app/api";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Instantiate the specialized extension
const client = new ANIME.AnimeKai();

/**
 * Custom Encryption helpers
 */
async function encKai(text) {
  const { data } = await axios.get(`${ENC_DEC_BASE}/enc-kai`, {
    params: { text },
    headers: { "User-Agent": BROWSER_UA },
  });
  return data?.result;
}

async function decKai(text) {
  const { data } = await axios.post(`${ENC_DEC_BASE}/dec-kai`, { text }, {
    headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/json" },
  });
  return data?.result;
}

async function searchAnime(query) {
  try {
    const results = await client.search(query);
    return (results.results || []).map((item) => ({
      sourceId: item.id,
      title: item.title,
      url: `${BASE_URL}/anime/${item.id}`,
      image: item.image,
    }));
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  }
}

async function getEpisodes(animeUrl) {
  const animeId = animeUrl.split("/").pop();
  try {
    const info = await client.fetchAnimeInfo(animeId);
    return (info.episodes || []).map((ep) => ({
      number: ep.number,
      title: ep.title || `Episode ${ep.number}`,
      sourceEpisodeId: ep.id,
      url: `${BASE_URL}/watch/${ep.id}`,
    }));
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Episode list error: ${error.message}`);
    return [];
  }
}

/**
 * Manual Resolve fallback for AnimeKai
 */
async function resolveEmbedManual(animeId, episodeId) {
  const token = episodeId.match(/\$token=([^$]+)/)?.[1] || episodeId;
  const referer = `${BASE_URL}/watch/${episodeId}`;
  
  try {
    const listKey = await encKai(token);
    const { data: listPayload } = await axios.get(`${BASE_URL}/ajax/links/list`, {
      params: { token, _: listKey },
      headers: { "User-Agent": BROWSER_UA, "X-Requested-With": "XMLHttpRequest", Referer: referer },
    });

    const $ = cheerio.load(listPayload?.result || "");
    const lid = $(".server").first().attr("data-lid");
    if (!lid) return null;

    const viewKey = await encKai(lid);
    const { data: viewPayload } = await axios.get(`${BASE_URL}/ajax/links/view`, {
      params: { id: lid, _: viewKey },
      headers: { "User-Agent": BROWSER_UA, "X-Requested-With": "XMLHttpRequest", Referer: referer },
    });

    const decrypted = await decKai(viewPayload?.result || "");
    return decrypted?.url;
  } catch (e) {
    return null;
  }
}

async function getStreamingSources(episodeUrl) {
  const episodeId = episodeUrl.split("/").pop();
  
  try {
    // Try the extension first
    const payload = await client.fetchEpisodeSources(episodeId);
    const sources = payload.sources || [];
    const referer = payload.headers?.Referer || "https://megaup.nl/";

    if (sources.length > 0) {
      return sources.map((src) => ({
        url: src.url.includes(".m3u8") ? `/api/scraper/proxy?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(referer)}` : src.url,
        quality: src.quality || "720",
        server: "animekai",
        type: src.isM3U8 || src.url.includes(".m3u8") ? "hls" : "iframe",
      }));
    }
  } catch (error) {
    // Fall back to manual resolution
    const manualUrl = await resolveEmbedManual("", episodeId);
    if (manualUrl) {
      return [{
        url: manualUrl,
        quality: "default",
        server: "animekai-manual",
        type: "iframe",
      }];
    }
  }

  return [];
}

async function getCatalogAnime(maxPages = 2) {
  // Consumet extensions usually have a fetchRecentEpisodes or similar
  try {
    const results = await client.search(""); // Empty search for catalog
    return (results.results || []).slice(0, 30).map(item => ({
      sourceId: item.id,
      title: item.title,
      url: `${BASE_URL}/anime/${item.id}`,
      image: item.image
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Custom URL builder for AnimeKai
 */
function buildEpisodeUrls({ anime, episode }) {
  const id = episode.sourceEpisodeId || anime.sourceId || "";
  const baseUrl = `${BASE_URL}/watch/${id}`;
  return [baseUrl, episode.url].filter(Boolean);
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
