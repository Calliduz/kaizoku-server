const axios = require("axios");
const cheerio = require("cheerio");
const puppeteerPool = require("../../utils/puppeteerPool");
const logger = require("../../utils/logger");

/**
 * AnimePahe Scraper Module
 * Ported from User's TypeScript implementation.
 */

const SOURCE_NAME = "animepahe";
const BASE_URL = "https://animepahe.pw";
const API_URL = "https://animepahe.pw/api";

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};

let cachedCookies = "";

/**
 * Wait for DDOS-GUARD or similar challenge bypass
 */
async function waitForChallengeBypass(page, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const challengeState = await page.evaluate(() => {
        const title = String(document.title || "");
        const bodyText = String(document.body?.innerText || "");
        const normalized = `${title}\n${bodyText}`.toLowerCase();
        const blocked =
          normalized.includes(
            "checking your browser before accessing animepahe.com",
          ) || normalized.includes("ddos-guard");
        return { blocked, title };
      });

      if (!challengeState.blocked) return true;
    } catch (e) {
      // ignore eval error
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Search anime on AnimePahe
 */
async function searchAnime(query) {
  const searchUrl = `${API_URL}?m=search&q=${encodeURIComponent(query)}`;

  try {
    // Fast path: direct API
    const response = await axios.get(searchUrl, {
      headers: requestHeaders,
      timeout: 10000,
    });

    // Safety Check: Verify response is actually JSON before parsing
    // DDoS-guard often returns HTML here
    if (typeof response.data !== "object" || response.data === null) {
      if (
        typeof response.data === "string" &&
        response.data.toLowerCase().includes("checking your browser")
      ) {
        logger.warn(
          `[${SOURCE_NAME}] API returned DDoS-guard challenge. Falling back to browser...`,
        );
        throw new Error("DDoS Challenge Detected");
      }
    }

    if (response.data && Array.isArray(response.data.data)) {
      return response.data.data.map((item) => ({
        sourceId: item.session, // Use session as unique sourceId
        title: item.title,
        url: `${BASE_URL}/anime/${item.session}`,
        image: item.poster,
      }));
    }
  } catch (error) {
    // Fall back to browser path
  }

  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(requestHeaders["User-Agent"]);
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait for JSON
    await page
      .waitForFunction(() => document.body.innerText.trim().startsWith("{"), {
        timeout: 8000,
      })
      .catch(() => {});
    const cookies = await page.cookies();
    if (cookies.length > 0)
      cachedCookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const responseText = await page.evaluate(() => document.body.innerText);
    const response = JSON.parse(responseText);

    if (response && response.data) {
      return response.data.map((item) => ({
        sourceId: item.session,
        title: item.title,
        url: `${BASE_URL}/anime/${item.session}`,
        image: item.poster,
      }));
    }
    return [];
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Get episode list
 */
async function getEpisodes(animeUrl) {
  const session = animeUrl.split("/").pop();
  const episodesApiUrl = `${API_URL}?m=release&id=${session}&sort=episode_asc&page=1`;

  const mapApiEpisodes = (items) =>
    items.map((item) => ({
      number: item.episode,
      title: item.title || `Episode ${item.episode}`,
      sourceEpisodeId: item.session, // Crucial: AnimePahe uses episode session for play links
      url: `${BASE_URL}/play/${session}/${item.session}`,
    }));

  try {
    const headers = { ...requestHeaders };
    if (cachedCookies) headers.Cookie = cachedCookies;

    const response = await axios.get(episodesApiUrl, { headers });
    if (response.data && Array.isArray(response.data.data)) {
      let eps = [...response.data.data];
      const lastPage = response.data.last_page || 1;

      for (let p = 2; p <= lastPage; p++) {
        try {
          const nextResp = await axios.get(
            episodesApiUrl.replace("page=1", `page=${p}`),
            { headers },
          );
          if (nextResp.data?.data) {
            eps = eps.concat(nextResp.data.data);
          }
        } catch (e) {
          logger.warn(
            `[${SOURCE_NAME}] Failed to fetch page ${p} with axios: ${e.message}`,
          );
        }
      }
      return mapApiEpisodes(eps);
    }
  } catch (err) {
    logger.warn(
      `[${SOURCE_NAME}] API getEpisodes failed, trying browser fallback: ${err.message}`,
    );
  }

  // Browser Fallback for DDOS guard
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(requestHeaders["User-Agent"]);

    let allData = [];
    let currentPage = 1;
    let lastPage = 1;

    do {
      const pagedUrl = episodesApiUrl.replace("page=1", `page=${currentPage}`);
      await page.goto(pagedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await page
        .waitForFunction(() => document.body.innerText.trim().startsWith("{"), {
          timeout: 8000,
        })
        .catch(() => {});
      const cookies = await page.cookies();
      if (cookies.length > 0)
        cachedCookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const responseText = await page.evaluate(() => document.body.innerText);
      try {
        const responseJson = JSON.parse(responseText);
        if (responseJson && Array.isArray(responseJson.data)) {
          allData = allData.concat(responseJson.data);
          lastPage = responseJson.last_page || 1;
        }
      } catch (parseErr) {
        logger.error(
          `[${SOURCE_NAME}] Failed to parse JSON from browser on page ${currentPage}`,
        );
        break; // Stop paginating on error
      }

      currentPage++;
    } while (currentPage <= lastPage);

    return mapApiEpisodes(allData);
  } catch (error) {
    logger.error(
      `[${SOURCE_NAME}] getEpisodes Browser fallback failed: ${error.message}`,
    );
  } finally {
    await page.close().catch(() => {});
  }

  return [];
}

/**
 * Extract streaming sources
 */
async function getStreamingSources(episodeUrl) {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(requestHeaders["User-Agent"]);
    await page.goto(episodeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await waitForChallengeBypass(page);

    await page.waitForSelector("#resolutionMenu button", { timeout: 10000 });

    const links = await page.evaluate(() => {
      const buttons = document.querySelectorAll("#resolutionMenu button");
      return Array.from(buttons).map((btn) => ({
        url: btn.getAttribute("data-src"),
        quality: btn.getAttribute("data-resolution") || "720",
        audio: btn.getAttribute("data-audio") || "jpn",
      }));
    });

    return links.map((link) => ({
      url: link.url, // Kwik.cx link
      quality: link.quality.includes("p") ? link.quality : `${link.quality}p`,
      audio: "sub",
      server: "kwik",
      type: "iframe",
    }));
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Source extraction error: ${error.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Crawl catalog (Latest Releases)
 */
async function getCatalogAnime(maxPages = 5) {
  // Use AnimePahe API for latest releases
  const all = [];
  const seen = new Set();

  try {
    for (let p = 1; p <= maxPages; p++) {
      const resp = await axios.get(
        `${API_URL}?m=release&sort=episode_desc&page=${p}`,
        { headers: requestHeaders },
      );
      if (resp.data?.data) {
        for (const item of resp.data.data) {
          // Since it's a list of episodes, we need the anime session
          // The API for latest releases might not provide the anime session directly.
          // Let's use the search fallback if not available, or crawl the homepage.
        }
      }
    }
  } catch (e) {}

  // Real world fallback: Scrape homepage
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(requestHeaders["User-Agent"]);
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await waitForChallengeBypass(page);

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll(".latest-release .box");
      return Array.from(cards).map((card) => {
        const link = card.querySelector("a");
        const img = card.querySelector("img");
        const animeUrl = link?.getAttribute("href") || "";
        const session = animeUrl.split("/").pop();
        return {
          sourceId: session,
          title: link?.getAttribute("title") || "",
          url: animeUrl.startsWith("http")
            ? animeUrl
            : `https://animepahe.pw${animeUrl}`,
          image:
            img?.getAttribute("src") || img?.getAttribute("data-src") || "",
        };
      });
    });

    return items.filter((i) => i.sourceId && i.title);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  name: SOURCE_NAME,
  BASE_URL,
  searchAnime,
  getEpisodes,
  getStreamingSources,
  getCatalogAnime,
  async buildEpisodeUrls({ anime, episode }) {
    if (!anime.sourceId) return [];
    try {
      // Since anime.sourceId is the Animepahe session ID, we can fetch its episodes directly
      const eps = await getEpisodes(`${BASE_URL}/anime/${anime.sourceId}`);
      const matched = eps.find((e) => e.number === episode.number);
      if (matched) return [matched.url];
    } catch (error) {
      logger.warn(
        `[${SOURCE_NAME}] Failed to build episode URL for ${anime.title} Ep ${episode.number}: ${error.message}`,
      );
    }
    return [];
  },
};
