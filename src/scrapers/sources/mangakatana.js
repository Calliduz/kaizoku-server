const axios = require("axios");
const cheerio = require("cheerio");
const logger = require("../../utils/logger");

/**
 * MangaKatana Scraper Module
 * Prepared for future use as requested by the user.
 */

const SOURCE_NAME = "mangakatana";
const BASE_URL = "https://mangakatana.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: BASE_URL,
  },
  timeout: 15000,
});

const toAbsoluteUrl = (url) => {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
};

/**
 * Search manga
 */
async function searchAnime(query) {
  try {
    const searchUrl = `${BASE_URL}/?search=${encodeURIComponent(query)}&search_by=m_name`;
    const response = await axiosInstance.get(searchUrl);
    const $ = cheerio.load(response.data);
    
    const results = [];
    $("#book_list .item, .item").each((_, element) => {
      const $el = $(element);
      const linkEl = $el.find("h3.title a, .title a").first();
      const title = linkEl.text().trim();
      const url = linkEl.attr("href") || "";
      if (!title || !url.includes("/manga/")) return;

      const imgEl = $el.find("img");
      const thumbnail = toAbsoluteUrl(imgEl.attr("data-src") || imgEl.attr("src") || "");
      const id = url.replace(`${BASE_URL}/manga/`, "").replace(/\/$/, "");

      results.push({
        sourceId: id,
        title,
        url,
        image: thumbnail,
      });
    });
    return results;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  }
}

/**
 * Placeholder for future manga-to-anime interface mapping
 */
async function getEpisodes() { return []; }
async function getStreamingSources() { return []; }
async function getCatalogAnime() { return []; }

module.exports = {
  name: SOURCE_NAME,
  BASE_URL,
  searchAnime,
  getEpisodes,
  getStreamingSources,
  getCatalogAnime,
};
