const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const { searchAniList, normalizeAniListData } = require('./anilist');
const { findBestMatch } = require('./matcher');
const logger = require('../utils/logger');

// ── Registered source modules ──────────────────────────────
// Add new sources here after creating them in ./sources/
const gogoanime = require('./sources/gogoanime');

const SOURCES = [gogoanime];
// ────────────────────────────────────────────────────────────

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

  logger.info(`[Engine] Scraping "${query}" across ${activeSources.length} source(s)...`);

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
          sourceId: item.sourceId,
          source: source.name,
          coverImage: item.image || '',
          ...(match ? normalizeAniListData(match) : {}),
        };

        // Step 4: Upsert into MongoDB (by sourceId + source)
        const anime = await Anime.findOneAndUpdate(
          { sourceId: item.sourceId, source: source.name },
          { $set: animeData },
          { upsert: true, new: true, runValidators: true }
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
            sourceEpisodeId: ep.sourceEpisodeId || '',
          },
        },
        { upsert: true, new: true }
      );
    }

    logger.info(`[Engine] Upserted ${episodes.length} episodes for anime ${animeId}`);
  } catch (error) {
    logger.error(`[Engine] Episode scrape failed for ${animeId}: ${error.message}`);
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
  const episode = await Episode.findById(episodeId).populate('animeId');
  if (!episode) throw new Error('Episode not found');

  // If we already have cached sources, return them
  if (episode.streamingSources.length > 0) {
    logger.debug(`[Engine] Returning cached sources for episode ${episodeId}`);
    return episode.streamingSources;
  }

  // Find the right source module
  const anime = episode.animeId;
  const source = SOURCES.find((s) => s.name === anime.source);
  if (!source) throw new Error(`Source "${anime.source}" not found`);

  // Build episode URL — customize this pattern per source
  const episodeUrl = `${source.BASE_URL || ''}/${anime.sourceId}-episode-${episode.number}`;

  const sources = await source.getStreamingSources(episodeUrl);

  // Cache the sources
  episode.streamingSources = sources;
  await episode.save();

  logger.info(`[Engine] Fetched and cached ${sources.length} sources for episode ${episodeId}`);
  return sources;
}

/**
 * CLI entry point — run directly via `npm run scrape`
 */
async function runScrape() {
  const mongoose = require('mongoose');
  const env = require('../config/env');

  await mongoose.connect(env.MONGODB_URI);
  logger.info('[Engine] Connected to MongoDB for scrape run');

  const query = process.argv[2] || 'One Piece';
  await scrape(query, { fetchEpisodes: true });

  const puppeteerPool = require('../utils/puppeteerPool');
  await puppeteerPool.shutdown();
  await mongoose.disconnect();

  logger.info('[Engine] Scrape run finished. Exiting.');
  process.exit(0);
}

module.exports = { scrape, scrapeEpisodes, fetchEpisodeSources, runScrape };
