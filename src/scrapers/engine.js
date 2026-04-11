const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const { searchAniList, normalizeAniListData } = require("./anilist");
const { findBestMatch } = require("./matcher");
const logger = require("../utils/logger");
const fuzzball = require("fuzzball");

// ── Simple In-Memory TTL Cache ──
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return hit.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── Simple Concurrency Limiter ──
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.running >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

const sourceLimiter = new ConcurrencyLimiter(5); // Limit concurrent source requests

// ── Registered source modules ──────────────────────────────
// Add new sources here after creating them in ./sources/
const gogoanime = require("./sources/gogoanime");
const animepahe = require("./sources/animepahe");
const aniwatch = require("./sources/aniwatch");
const animekai = require("./sources/animekai");

const SOURCES = [animepahe, animekai, gogoanime, aniwatch];
// ────────────────────────────────────────────────────────────

function toSlug(value = "") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Clean a scraped title to extract the series name.
 * Removes "Episode X", "Sub", "Dub", "1080p", etc.
 */
function cleanTitle(title = "") {
  return title
    .replace(/\s+/g, " ")
    .replace(/episode\s+\d+/gi, "")
    .replace(/eps\s+\d+/gi, "")
    .replace(/\s+0\d+\s+/g, " ")
    .replace(/\s+0\d+$/g, " ")
    .replace(/\b(?:Season|S)\s*\d+\b/gi, "")
    .replace(/\d+(?:st|nd|rd|th)\s+Season/gi, "")
    .replace(/\s+(?:Part|Pt)\s*\d+/gi, "")
    .replace(/\s+Cour\s*\d+/gi, "")
    .replace(
      /\b(?:Subbed|Dubbed|Sub|Dub|English|Italiano|Español|Português)\b/gi,
      "",
    )
    .replace(/\[\d+p\]/gi, "")
    .replace(/[\[\]\(\)\-:]/g, " ") // Replace brackets, parens, hyphens, colons with space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scraper Engine — Orchestrator
 *
 * Flow:
 *  1. Search each registered source for the query
 *  2. For each result, fuzzy-match against AniList to enrich metadata
 *  3. Upsert the anime into MongoDB
 *  4. Optionally fetch episode lists
 */

/**
 * Run a full scrape cycle for a given search query.
 *
 * @param {string} query - Search query
 * @param {object} [options]
 * @param {boolean} [options.fetchEpisodes=false] - Also scrape the episode list
 * @param {string[]} [options.sourceFilter] - Only use these source names
 * @returns {Promise<Array>} Array of upserted anime documents
 */
async function scrape(query, options = {}) {
  const { fetchEpisodes = false, sourceFilter } = options;

  const activeSources = sourceFilter
    ? SOURCES.filter((s) => sourceFilter.includes(s.name))
    : SOURCES;

  logger.info(
    `[Engine] Scraping "${query}" across ${activeSources.length} source(s)...`,
  );

  const results = [];

  for (const source of activeSources) {
    try {
      // Step 1: Search the source
      const searchResults = await sourceLimiter.run(() =>
        source.searchAnime(query),
      );
      for (const item of searchResults) {
        // Step 2: Fuzzy-match with AniList
        const anilistResults = await searchAniList(item.title);
        const { match } = findBestMatch(item.title, anilistResults);

        // Step 3: Build the anime document
        const cleanedTitle = cleanTitle(item.title);
        const slug = toSlug(cleanedTitle);

        const animeData = {
          title: cleanedTitle,
          slug: slug,
          sourceId: item.sourceId,
          scrapeSource: source.name,
          coverImage: item.image || "",
          ...(match ? normalizeAniListData(match) : {}),
        };

        // Step 4: Upsert into MongoDB (prefer anilistId lookup to merge with Offline DB)
        // Ensure slug is also part of the query to prevent duplicates if anilistId is missing
        const filter = {
          $or: [
            ...(match && match.id ? [{ anilistId: match.id }] : []),
            { slug: slug },
            { sourceId: item.sourceId, scrapeSource: source.name },
          ],
        };

        const anime = await Anime.findOneAndUpdate(
          filter,
          { $set: animeData },
          { upsert: true, new: true, runValidators: true },
        );

        logger.info(`[Engine] Upserted: ${anime.title} (${anime._id})`);

        // Step 5 (optional): Fetch episodes
        if (fetchEpisodes && item.url) {
          await scrapeEpisodes(anime._id, item.url, source);
        }

        results.push(anime);
      }
    } catch (error) {
      logger.error(`[Engine] Source "${source.name}" failed: ${error.message}`);
    }
  }

  logger.info(`[Engine] Scrape complete. ${results.length} anime processed.`);
  return results;
}

/**
 * Scrape catalog pages from each source to ingest many anime at once.
 *
 * @param {object} [options]
 * @param {boolean} [options.fetchEpisodes=false] - Also scrape episode lists
 * @param {string[]} [options.sourceFilter] - Only use these source names
 * @param {number} [options.maxPages=25] - Max catalog pages per source
 * @returns {Promise<Array>} Array of upserted anime documents
 */
async function scrapeCatalog(options = {}) {
  const { fetchEpisodes = false, sourceFilter, maxPages = 25 } = options;

  const activeSources = sourceFilter
    ? SOURCES.filter((s) => sourceFilter.includes(s.name))
    : SOURCES;

  logger.info(
    `[Engine] Catalog scrape across ${activeSources.length} source(s), maxPages=${maxPages}`,
  );

  const results = [];

  for (const source of activeSources) {
    if (typeof source.getCatalogAnime !== "function") {
      logger.warn(
        `[Engine] Source "${source.name}" has no getCatalogAnime(); skipping.`,
      );
      continue;
    }

    try {
      const catalogItems = await sourceLimiter.run(() =>
        source.getCatalogAnime(maxPages),
      );

      for (const item of catalogItems) {
        const anilistResults = await searchAniList(item.title);
        const { match } = findBestMatch(item.title, anilistResults);

        const cleanedTitle = cleanTitle(item.title);
        const slug = toSlug(cleanedTitle);

        // 1. Prepare Core Source Data (Always update these for tracking)
        const updateDoc = {
          $set: {
            sourceId: item.sourceId,
            scrapeSource: source.name,
            updatedAt: new Date(), // Force updatedAt bump for listing
          },
        };

        // 2. Prepare High-Quality Metadata (If AniList match found)
        if (match) {
          const enrichedData = normalizeAniListData(match);
          updateDoc.$set = { ...updateDoc.$set, ...enrichedData };
        } else {
          // 3. Prepare Low-Quality Fallback (Only useful for NEW records)
          updateDoc.$setOnInsert = {
            title: cleanedTitle,
            slug: slug,
            coverImage: item.image || "",
          };
        }

        const filter = {
          $or: [
            ...(match && match.id ? [{ anilistId: match.id }] : []),
            { slug: slug },
            { sourceId: item.sourceId, scrapeSource: source.name },
          ],
        };

        const anime = await Anime.findOneAndUpdate(filter, updateDoc, {
          upsert: true,
          new: true,
          runValidators: true,
        });

        if (fetchEpisodes && item.url) {
          await scrapeEpisodes(anime._id, item.url, source);
        }

        results.push(anime);
      }
    } catch (error) {
      logger.error(
        `[Engine] Catalog scrape failed for "${source.name}": ${error.message}`,
      );
    }
  }

  logger.info(
    `[Engine] Catalog scrape complete. ${results.length} anime processed.`,
  );
  return results;
}

/**
 * Scrape and upsert episodes for a specific anime.
 *
 * @param {string} animeId - Mongoose ObjectId of the parent anime
 * @param {string} animeUrl - URL to the anime detail page on the source
 * @param {object} source - Source module
 */
async function scrapeEpisodes(animeId, animeUrl, source) {
  try {
    const episodes = await sourceLimiter.run(() =>
      source.getEpisodes(animeUrl),
    );

    for (const ep of episodes) {
      await Episode.findOneAndUpdate(
        { animeId, number: ep.number },
        {
          $set: {
            animeId,
            number: ep.number,
            title: ep.title || `Episode ${ep.number}`,
            sourceEpisodeId: ep.sourceEpisodeId || "",
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
    }

    logger.info(
      `[Engine] Upserted ${episodes.length} episodes for anime ${animeId}`,
    );
  } catch (error) {
    logger.error(
      `[Engine] Episode scrape failed for ${animeId}: ${error.message}`,
    );
  }
}

/**
 * Fetch streaming sources for an episode on-demand.
 * Now parallelized to aggregate results from ALL providers.
 *
 * @param {string} episodeId - MongoDB Episode _id
 * @param {boolean} [forceRefresh=false] - If true, ignore cache and re-scrape
 * @returns {Promise<Array>} Array of streaming sources
 */
async function fetchEpisodeSources(episodeId, forceRefresh = false) {
  const episode = await Episode.findById(episodeId).populate("animeId");
  if (!episode) throw new Error("Episode not found");

  // If we already have cached sources in memory and not forcing refresh, return them
  if (!forceRefresh) {
    const memCache = getCache(`sources:${episodeId}`);
    if (memCache) {
      logger.debug(
        `[Engine] Returning IN-MEMORY cached sources for episode ${episodeId}`,
      );
      return memCache;
    }
  }

  // If we already have cached sources in DB and not forcing refresh, return them
  if (!forceRefresh && episode.streamingSources.length > 0) {
    logger.debug(
      `[Engine] Returning DB cached sources for episode ${episodeId}`,
    );
    setCache(`sources:${episodeId}`, episode.streamingSources); // Warm up memory cache
    return episode.streamingSources;
  }

  const anime = episode.animeId;
  logger.info(`[Engine] Hunting sources for "${anime.title}"...`);

  // 1) Execute sources in priority order to favor the default array setting
  //    and return as early as possible if we get hits, avoiding long Puppeteer hang-ups.
  let allSources = [];
  const seenUrls = new Set();

  for (const source of SOURCES) {
    try {
      let sourceResults = [];
      const isRecordedPrimary = source.name === anime.scrapeSource;
      const isDefault = source.name === SOURCES[0].name;

      // Only attempt to run if it's the requested default, the recorded primary, or if we force refresh
      if (
        !isRecordedPrimary &&
        !isDefault &&
        !forceRefresh &&
        allSources.length > 0
      ) {
        continue; // Skip secondary sources if we already found something and aren't forcing a deep refresh
      }

      // Scenario A: This source is already the recorded primary
      if (isRecordedPrimary && anime.sourceId) {
        sourceResults = await trySourceWithFallbacks(source, anime, episode);
      }

      // Scenario B: Search and match this source (Deep Discovery)
      // Only do deep discovery if Scenario A failed (or didn't run)
      if (
        sourceResults.length === 0 &&
        (isDefault || isRecordedPrimary || forceRefresh)
      ) {
        logger.info(`[Engine] Deep Discovery for ${source.name}...`);
        const searchResults = await sourceLimiter.run(() =>
          source.searchAnime(anime.title),
        );
        const { bestItem, score } = getHeuristicBestMatch(anime, searchResults);

        if (bestItem && score > 75) {
          const altEpisodes = await sourceLimiter.run(() =>
            source.getEpisodes(bestItem.url),
          );
          const matchedEp = altEpisodes.find(
            (e) => e.number === episode.number,
          );

          if (matchedEp) {
            sourceResults = await sourceLimiter.run(() =>
              source.getStreamingSources(matchedEp.url),
            );

            // If Deep Discovery succeeded, update the primary source binding
            // so future episodes of this anime can use the fast Scenario A
            if (
              sourceResults.length > 0 &&
              source.name !== anime.scrapeSource
            ) {
              logger.info(
                `[Engine] Updating primary source for ${anime.title} to ${source.name} (${bestItem.sourceId})`,
              );
              try {
                await Anime.findByIdAndUpdate(anime._id, {
                  $set: {
                    scrapeSource: source.name,
                    sourceId: bestItem.sourceId,
                  },
                });
                anime.scrapeSource = source.name;
                anime.sourceId = bestItem.sourceId;
              } catch (updateErr) {
                logger.error(
                  `[Engine] Failed to update primary source: ${updateErr.message}`,
                );
              }
            }
          }
        }
      }

      if (sourceResults.length > 0) {
        // Tag sources
        const tagged = sourceResults.map((s) => ({
          ...s,
          server: `${source.name.charAt(0).toUpperCase() + source.name.slice(1)} - ${s.server || "Stream"}`,
        }));

        tagged.forEach((src) => {
          if (!seenUrls.has(src.url)) {
            seenUrls.add(src.url);
            allSources.push(src);
          }
        });

        // If we found sources, break early!
        // This makes it INSTANT if the first provider works.
        if (allSources.length > 0) {
          logger.info(
            `[Engine] Found ${allSources.length} sources from ${source.name}, skipping others for speed.`,
          );
          break;
        }
      }
    } catch (err) {
      logger.error(
        `[Engine] Aggregator task for ${source.name} failed: ${err.message}`,
      );
    }
  }

  // Sort: High quality first, then Dub last (usually Sub is preferred)
  allSources.sort((a, b) => {
    const qA = parseInt(a.quality) || 0;
    const qB = parseInt(b.quality) || 0;
    if (qB !== qA) return qB - qA;
    return (a.audio === "dub" ? 1 : 0) - (b.audio === "dub" ? 1 : 0);
  });

  // Cache the sources using atomic update in DB
  const updatedEpisode = await Episode.findByIdAndUpdate(
    episode._id,
    { $set: { streamingSources: allSources } },
    { new: true },
  );

  // Set memory cache
  if (allSources.length > 0) {
    setCache(`sources:${episodeId}`, updatedEpisode.streamingSources);
  }

  logger.info(
    `[Engine] Aggregated ${allSources.length} unique sources for episode ${episodeId}`,
  );
  return updatedEpisode.streamingSources;
}

/**
 * Helper to try fetching sources with internal source-specific URL fallbacks
 */
async function trySourceWithFallbacks(source, anime, episode) {
  const fallbackUrl = `${source.BASE_URL || ""}/${anime.sourceId}-episode-${episode.number}`;
  let candidateUrls = [];

  if (typeof source.buildEpisodeUrls === "function") {
    // If it's an async function, await it
    const builtUrls = source.buildEpisodeUrls({ anime, episode, fallbackUrl });
    candidateUrls = builtUrls instanceof Promise ? await builtUrls : builtUrls;
  } else {
    candidateUrls = [fallbackUrl, episode.url].filter(Boolean);
  }

  for (const url of candidateUrls) {
    try {
      const sources = await sourceLimiter.run(() =>
        source.getStreamingSources(url),
      );
      if (sources.length > 0) return sources;
    } catch (error) {
      logger.warn(`[Engine] Fetch failed for URL ${url}: ${error.message}`);
    }
  }
  return [];
}

/**
 * Heuristic fuzzy match helper
 */
function getHeuristicBestMatch(anime, searchResults) {
  let bestItem = null;
  let highestScore = 0;
  const targetTitles = [anime.title, ...(anime.altTitles || [])].filter(
    Boolean,
  );

  for (const item of searchResults) {
    for (const target of targetTitles) {
      const score = Math.max(
        fuzzball.ratio(item.title.toLowerCase(), target.toLowerCase()),
        fuzzball.partial_ratio(item.title.toLowerCase(), target.toLowerCase()),
      );
      if (score > highestScore) {
        highestScore = score;
        bestItem = item;
      }
    }
  }
  return { bestItem, score: highestScore };
}

/**
 * Lazy load / cross-reference an anime that has no scraping source.
 * Called when an anime is clicked but has no episodes (seeded from AOD).
 *
 * @param {string} animeId - MongoDB Anime _id
 */
async function linkAndFetchEpisodes(animeId) {
  const anime = await Anime.findById(animeId);
  if (!anime || (anime.sourceId && anime.scrapeSource)) return;

  logger.info(
    `[Engine] Lazy-loading episodes for ${anime.title} (Anilist ID: ${anime.anilistId})`,
  );

  // Try all sources
  for (const source of SOURCES) {
    try {
      const searchResults = await sourceLimiter.run(() =>
        source.searchAnime(anime.title),
      );
      if (!searchResults || searchResults.length === 0) continue;

      let bestItem = null;
      let highestScore = 0;

      const targetTitles = [anime.title, ...(anime.altTitles || [])].filter(
        Boolean,
      );

      // Local heuristic fuzzy match: avoids 15 seconds of AniList GraphQL requests
      for (const item of searchResults) {
        for (const target of targetTitles) {
          const score = Math.max(
            fuzzball.ratio(item.title.toLowerCase(), target.toLowerCase()),
            fuzzball.partial_ratio(
              item.title.toLowerCase(),
              target.toLowerCase(),
            ),
          );
          if (score > highestScore) {
            highestScore = score;
            bestItem = item;
          }
        }
      }

      if (bestItem && highestScore > 70) {
        logger.info(
          `[Engine] Matched "${anime.title}" to source "${bestItem.title}" with score ${highestScore}`,
        );

        // Atomic update to prevent VersionError during concurrent source discovery
        await Anime.findByIdAndUpdate(anime._id, {
          $set: {
            sourceId: bestItem.sourceId,
            scrapeSource: source.name,
          },
        });

        await scrapeEpisodes(anime._id, bestItem.url, source);
        return;
      }
    } catch (error) {
      logger.error(
        `[Engine] Lazy load failed for source ${source.name}: ${error.message}`,
      );
    }
  }
}

/**
 * CLI entry point — run directly via `npm run scrape`
 */
async function runScrape() {
  const mongoose = require("mongoose");
  const env = require("../config/env");

  await mongoose.connect(env.MONGODB_URI);
  logger.info("[Engine] Connected to MongoDB for scrape run");

  const query = process.argv[2];

  if (query && query.trim()) {
    await scrape(query.trim(), { fetchEpisodes: true });
  } else {
    // Default behavior: ingest the catalog instead of a single hardcoded title.
    await scrapeCatalog({ fetchEpisodes: true, maxPages: 25 });
  }

  const puppeteerPool = require("../utils/puppeteerPool");
  await puppeteerPool.shutdown();
  await mongoose.disconnect();

  logger.info("[Engine] Scrape run finished. Exiting.");
  process.exit(0);
}

module.exports = {
  scrape,
  scrapeCatalog,
  scrapeEpisodes,
  fetchEpisodeSources,
  linkAndFetchEpisodes,
  runScrape,
};
