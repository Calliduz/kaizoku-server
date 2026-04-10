const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const { searchAniList, normalizeAniListData } = require("./anilist");
const { findBestMatch } = require("./matcher");
const logger = require("../utils/logger");
const fuzzball = require("fuzzball");

// ── Registered source modules ──────────────────────────────
// Add new sources here after creating them in ./sources/
const gogoanime = require("./sources/gogoanime");

const SOURCES = [gogoanime];
// ────────────────────────────────────────────────────────────

function toSlug(value = "") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
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
      const searchResults = await source.searchAnime(query);

      for (const item of searchResults) {
        // Step 2: Fuzzy-match with AniList
        const anilistResults = await searchAniList(item.title);
        const { match } = findBestMatch(item.title, anilistResults);

        // Step 3: Build the anime document
        const animeData = {
          title: item.title,
          slug: toSlug(item.title),
          sourceId: item.sourceId,
          scrapeSource: source.name,
          coverImage: item.image || "",
          ...(match ? normalizeAniListData(match) : {}),
        };

        // Step 4: Upsert into MongoDB (prefer anilistId lookup to merge with Offline DB)
        const filter = match && match.id 
          ? { anilistId: match.id } 
          : { sourceId: item.sourceId, scrapeSource: source.name };

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
      const catalogItems = await source.getCatalogAnime(maxPages);

      for (const item of catalogItems) {
        const anilistResults = await searchAniList(item.title);
        const { match } = findBestMatch(item.title, anilistResults);

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
          // We use $setOnInsert so these fields only apply if the record is created now.
          // This prevents overwriting existing HQ data from previous manual scrapes.
          updateDoc.$setOnInsert = {
            title: item.title,
            slug: toSlug(item.title),
            coverImage: item.image || "",
          };
        }

        const filter = match && match.id 
          ? { anilistId: match.id } 
          : { sourceId: item.sourceId, scrapeSource: source.name };

        const anime = await Anime.findOneAndUpdate(
          filter,
          updateDoc,
          { upsert: true, new: true, runValidators: true },
        );

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
    const episodes = await source.getEpisodes(animeUrl);

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
        { upsert: true, new: true },
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
 * Called when a user clicks "play" — sources are fetched in real-time
 * and cached in the episode document.
 *
 * @param {string} episodeId - MongoDB Episode _id
 * @returns {Promise<Array>} Array of streaming sources
 */
async function fetchEpisodeSources(episodeId) {
  const episode = await Episode.findById(episodeId).populate("animeId");
  if (!episode) throw new Error("Episode not found");

  // If we already have cached sources, return them
  if (episode.streamingSources.length > 0) {
    logger.debug(`[Engine] Returning cached sources for episode ${episodeId}`);
    return episode.streamingSources;
  }

  // Find the right source module
  const anime = episode.animeId;
  const source = SOURCES.find((s) => s.name === anime.scrapeSource);
  if (!source) throw new Error(`Source "${anime.scrapeSource}" not found`);

  const fallbackUrl = `${source.BASE_URL || ""}/${anime.sourceId}-episode-${episode.number}`;
  const candidateUrls =
    typeof source.buildEpisodeUrls === "function"
      ? source.buildEpisodeUrls({ anime, episode, fallbackUrl })
      : [fallbackUrl];

  let sources = [];
  for (const url of candidateUrls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      sources = await source.getStreamingSources(url);
      if (sources.length > 0) break;
    } catch (error) {
      logger.warn(`[Engine] Source fetch failed for URL ${url}: ${error.message}`);
    }
  }

  if (sources.length === 0) {
    logger.warn(`[Engine] No streaming sources found for episode ${episodeId}`);
  }

  // Cache the sources
  episode.streamingSources = sources;
  await episode.save();

  logger.info(
    `[Engine] Fetched and cached ${sources.length} sources for episode ${episodeId}`,
  );
  return sources;
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

  logger.info(`[Engine] Lazy-loading episodes for ${anime.title} (Anilist ID: ${anime.anilistId})`);
  
  // Try all sources
  for (const source of SOURCES) {
    try {
      const searchResults = await source.searchAnime(anime.title);
      if (!searchResults || searchResults.length === 0) continue;

      let bestItem = null;
      let highestScore = 0;
      
      const targetTitles = [anime.title, ...(anime.altTitles || [])].filter(Boolean);

      // Local heuristic fuzzy match: avoids 15 seconds of AniList GraphQL requests
      for (const item of searchResults) {
        for (const target of targetTitles) {
          const score = Math.max(
            fuzzball.ratio(item.title.toLowerCase(), target.toLowerCase()),
            fuzzball.partial_ratio(item.title.toLowerCase(), target.toLowerCase())
          );
          if (score > highestScore) {
            highestScore = score;
            bestItem = item;
          }
        }
      }

      if (bestItem && highestScore > 70) {
        logger.info(`[Engine] Matched "${anime.title}" to source "${bestItem.title}" with score ${highestScore}`);
        anime.sourceId = bestItem.sourceId;
        anime.scrapeSource = source.name;
        await anime.save();
        await scrapeEpisodes(anime._id, bestItem.url, source);
        return;
      }
    } catch (error) {
      logger.error(`[Engine] Lazy load failed for source ${source.name}: ${error.message}`);
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
