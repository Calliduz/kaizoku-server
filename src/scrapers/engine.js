const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const { searchAniList, normalizeAniListData } = require("./anilist");
const { findBestMatch } = require("./matcher");
const { fetchEpisodeMetadata } = require("../utils/metadataFetcher");
const logger = require("../utils/logger");
const fanart = require("../utils/fanart");
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

// Track ongoing scrapes to prevent redundant work and inform UI
const activeScrapes = new Set();
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
    // Remove episode markers
    .replace(/episode\s+\d+/gi, "")
    .replace(/eps\s+\d+/gi, "")
    // Remove year markers like (2024)
    .replace(/\(\d{4}\)/g, "")
    // Remove release quality/subs
    .replace(
      /\b(?:Subbed|Dubbed|Sub|Dub|English|Italiano|Español|Português|Multi-Sub)\b/gi,
      "",
    )
    .replace(/[\[\]\(\)]/g, " ") // Preserved colons/hyphens to avoid smashing valid short titles together
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
            ...(slug.length >= 6 ? [{ slug: slug }] : []),
            { title: cleanedTitle },
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

      const baseTime = Date.now();
      let index = 0;

      for (const item of catalogItems) {
        let anilistResults = [];
        try {
          anilistResults = await searchAniList(item.title);
        } catch (e) {
          logger.error(
            `[Engine] AniList search failed for ${item.title}: ${e.message}`,
          );
        }

        const { match } = findBestMatch(item.title, anilistResults);

        const cleanedTitle = cleanTitle(item.title);
        const slug = toSlug(cleanedTitle);

        // 1. Prepare Core Source Data (Always update these for tracking)
        const updateDoc = {
          $set: {
            sourceId: item.sourceId,
            scrapeSource: source.name,
            catalogUpdatedAt: new Date(baseTime - index * 1000), // Force catalog list bump
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
            ...(slug.length >= 6 ? [{ slug: slug }] : []),
            { title: cleanedTitle },
            { sourceId: item.sourceId, scrapeSource: source.name },
          ],
        };

        let anime = await Anime.findOneAndUpdate(filter, updateDoc, {
          upsert: true,
          new: true,
          runValidators: true,
        });

        // Background Enrichment for missing high-quality data and Logos
        setTimeout(
          async () => {
            try {
              let currentAnimeId = anime.anilistId || (match ? match.id : null);

              if (!currentAnimeId || !anime.description) {
                const fallbackResults = await searchAniList(anime.title, 3);
                if (fallbackResults && fallbackResults.length > 0) {
                  const enrichedData = normalizeAniListData(fallbackResults[0]);
                  await Anime.findByIdAndUpdate(anime._id, {
                    $set: enrichedData,
                  });
                  currentAnimeId =
                    enrichedData.anilistId || fallbackResults[0].id;
                  logger.info(
                    `[Engine] Background enriched metadata for "${anime.title}"`,
                  );
                }
              }

              // Fetch high-res logo from Fanart/Anify if we now have anilistId but no logo
              if (currentAnimeId && !anime.logo) {
                const logoUrl =
                  await require("../utils/fanart").fetchLogo(currentAnimeId);
                if (logoUrl) {
                  await Anime.findByIdAndUpdate(anime._id, {
                    $set: { logo: logoUrl },
                  });
                }
              }
            } catch (e) {
              // Ignore background failure
            }
          },
          5000 + index * 500,
        ); // Delay staggered by 500ms per item to prevent hammering Anify API

        if (fetchEpisodes && item.url) {
          await scrapeEpisodes(anime._id, item.url, source);
        }

        index++;
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
    const anime = await Anime.findById(animeId);
    if (!anime) throw new Error("Anime not found");

    const [scrapedEpisodes, metaEpisodes] = await Promise.all([
      sourceLimiter.run(() => source.getEpisodes(animeUrl)),
      anime.anilistId ? fetchEpisodeMetadata(anime.anilistId) : Promise.resolve([]),
    ]);

    // Simple Season Extractor Fallback
    const titleSeasonMatch = anime.title.match(/Season\s+(\d+)/i);
    const fallbackSeason = titleSeasonMatch ? parseInt(titleSeasonMatch[1]) : null;

    for (const ep of scrapedEpisodes) {
      // Find matching metadata (usually by number)
      const meta = metaEpisodes.find((m) => m.number === ep.number);

      await Episode.findOneAndUpdate(
        { animeId, number: ep.number },
        {
          $set: {
            animeId,
            number: ep.number,
            title: ep.title || meta?.title || `Episode ${ep.number}`,
            sourceEpisodeId: ep.sourceEpisodeId || "",
            description: meta?.description || "",
            thumbnail: ep.thumbnail || meta?.thumbnail || "",
            seasonNumber: meta?.seasonNumber || fallbackSeason,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
    }

    logger.info(
      `[Engine] Upserted ${scrapedEpisodes.length} episodes for anime ${animeId}`,
    );

    // Update the last scrape timestamp to enable intelligent caching
    await Anime.findByIdAndUpdate(animeId, {
      $set: { episodesUpdatedAt: new Date() }
    });
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
  logger.info(`[Engine] Hunting sources for "${anime.title}" (Force: ${forceRefresh})...`);

  // 0) If force refresh, re-fetch metadata (titles, descriptions, thumbnails)
  if (forceRefresh && anime.anilistId) {
    try {
      const metaEpisodes = await fetchEpisodeMetadata(anime.anilistId);
      const meta = metaEpisodes.find((m) => m.number === episode.number);
      if (meta) {
        const titleSeasonMatch = anime.title.match(/Season\s+(\d+)/i);
        const fallbackSeason = titleSeasonMatch ? parseInt(titleSeasonMatch[1]) : null;

        await Episode.findByIdAndUpdate(episode._id, {
          $set: {
            description: meta.description || "",
            thumbnail: meta.thumbnail || "",
            title: meta.title || `Episode ${episode.number}`,
            seasonNumber: meta.seasonNumber || fallbackSeason,
          },
        });
        logger.info(`[Engine] Refreshed metadata for episode ${episode._id}`);
      }
    } catch (err) {
      logger.error(`[Engine] Metadata refresh failed during source hunt: ${err.message}`);
    }
  }

  // 1) Executor helper for a single source
  const aggregationStart = Date.now();
  const executeSource = async (source) => {
    const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`[${source.name}] Timeout reached`)), 18000)
    );

    const task = (async () => {
        try {
          let sourceResults = [];
          const isRecordedPrimary = source.name === anime.scrapeSource;

          // Scenario A: Fast Resolve
          if (isRecordedPrimary && anime.sourceId) {
            sourceResults = await trySourceWithFallbacks(source, anime, episode);
          }

          // Scenario B: Deep Discovery
          if (sourceResults.length === 0) {
            logger.debug(`[Engine] Deep Discovery for ${source.name}...`);
            const searchResults = await sourceLimiter.run(() =>
              source.searchAnime(anime.title)
            );
            const { bestItem, score } = getHeuristicBestMatch(anime, searchResults);

            if (bestItem && score > 75) {
              const altEpisodes = await sourceLimiter.run(() =>
                source.getEpisodes(bestItem.url)
              );
              const matchedEp = altEpisodes.find(
                (e) => e.number === episode.number
              );

              if (matchedEp) {
                sourceResults = await sourceLimiter.run(() =>
                  source.getStreamingSources(matchedEp.url)
                );

                if (sourceResults.length > 0 && !anime.sourceId) {
                  await Anime.findByIdAndUpdate(anime._id, {
                    $set: { scrapeSource: source.name, sourceId: bestItem.sourceId },
                  });
                }
              }
            }
          }

          if (!sourceResults || sourceResults.length === 0) return [];

          return sourceResults.map((s) => ({
            ...s,
            server: `${source.name.charAt(0).toUpperCase() + source.name.slice(1)} - ${s.server || "Stream"}`,
            provider: source.name,
          }));
        } catch (err) {
          logger.error(`[Engine] Aggregator task for ${source.name} failed: ${err.message}`);
          return [];
        }
    })();

    return Promise.race([task, timeout]).catch(err => {
        logger.warn(`[Engine] ${err.message}`);
        return [];
    });
  };

  // 2) Fast-Path: Always try AnimePahe first, then the recorded DB source
  let allSources = [];
  const preferredSource = SOURCES.find(s => s.name === 'animepahe');
  const recordedSource = SOURCES.find(s => s.name === anime.scrapeSource);
  
  // Use Set to remove duplicates if animepahe is already the recorded source
  const sourcesToTryFirst = [...new Set([preferredSource, recordedSource].filter(Boolean))];
  
  for (const src of sourcesToTryFirst) {
    if (allSources.length > 0) break;
    
    logger.info(`[Engine] Fast-Path: Executing "${src.name}"...`);
    const results = await executeSource(src);
    
    if (results && results.length > 0) {
      logger.info(`[Engine] Fast-Path succeeded on ${src.name}! Skipping parallel aggregation.`);
      allSources = results;
    }
  }

  // 3) Aggregation Fallback: If Fast-Path failed, run everything else in parallel
  if (allSources.length === 0) {
    logger.info(`[Engine] Secondary fallback: running remaining sources in parallel...`);
    // Filter out the ones we already tried
    const triedNames = new Set(sourcesToTryFirst.map(s => s.name));
    const fallbackSources = SOURCES.filter(s => !triedNames.has(s.name));
    const sourceTasks = fallbackSources.map(source => executeSource(source));
    
    const results = await Promise.allSettled(sourceTasks);
    results.forEach((res) => {
      if (res.status === "fulfilled" && Array.isArray(res.value)) {
        res.value.forEach(src => allSources.push(src));
      }
    });
  }

  // 4) Filter out duplicate URLs
  const seenUrls = new Set();
  allSources = allSources.filter(src => {
    if (seenUrls.has(src.url)) return false;
    seenUrls.add(src.url);
    return true;
  });

  const duration = Date.now() - aggregationStart;
  logger.info(`[Engine] Aggregation complete in ${duration}ms. Found ${allSources.length} total sources.`);

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
      const fullScore = fuzzball.ratio(item.title.toLowerCase(), target.toLowerCase());
      const partialScore = fuzzball.partial_ratio(item.title.toLowerCase(), target.toLowerCase());
      // Weight partial ratio heavily, but use full ratio as a tie-breaker to prefer exact length matches
      const score = (partialScore * 0.8) + (fullScore * 0.2);
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
  if (activeScrapes.has(animeId)) return;

  const anime = await Anime.findById(animeId);
  if (!anime) return;
  
  if (anime.sourceId && anime.scrapeSource) {
    // ── Intelligent Cache Check ──
    const now = new Date();
    const lastUpdate = anime.episodesUpdatedAt || new Date(0);
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

    // 1. If finished and we have episodes, don't re-scrape
    if (anime.status === "FINISHED") {
      logger.debug(`[Engine] Skipping re-scrape for FINISHED anime: ${anime.title}`);
      return;
    }

    // 2. If airing, only re-scrape every 24 hours to prevent hammering sources
    if (hoursSinceUpdate < 24) {
      logger.debug(`[Engine] Skipping re-scrape for ${anime.title} (Recently updated ${hoursSinceUpdate.toFixed(1)}h ago)`);
      return;
    }

    // Otherwise, trigger background refresh
    activeScrapes.add(animeId);
    scrapeEpisodes(anime._id, anime.sourceId, SOURCES.find(s => s.name === anime.scrapeSource))
      .catch((err) => logger.error(`[Engine] Background scrape failed: ${err.message}`))
      .finally(() => activeScrapes.delete(animeId));
    return;
  }

  activeScrapes.add(animeId);

  logger.info(
    `[Engine] Lazy-loading episodes for ${anime.title} (Anilist ID: ${anime.anilistId})`,
  );

  // Try all sources in parallel with a strict timeout per source
  const searchPromises = SOURCES.map(async (source) => {
    try {
      const sourceTask = (async () => {
        const searchResults = await sourceLimiter.run(() =>
          source.searchAnime(anime.title),
        );
        if (!searchResults || searchResults.length === 0) return null;

        let bestItem = null;
        let highestScore = 0;
        const targetTitles = [anime.title, ...(anime.altTitles || [])].filter(Boolean);

        for (const item of searchResults) {
          for (const target of targetTitles) {
            const fullScore = fuzzball.ratio(item.title.toLowerCase(), target.toLowerCase());
            const partialScore = fuzzball.partial_ratio(item.title.toLowerCase(), target.toLowerCase());
            const score = (partialScore * 0.8) + (fullScore * 0.2);
            if (score > highestScore) {
              highestScore = score;
              bestItem = item;
            }
          }
        }

        if (bestItem && highestScore > 70) {
          return { source, bestItem, highestScore };
        }
        return null;
      })();

      // 15 second timeout per source
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Source request timed out")), 15000)
      );

      return await Promise.race([sourceTask, timeout]);
    } catch (error) {
      logger.error(`[Engine] Search failed or timed out for source ${source.name}: ${error.message}`);
      return null;
    }
  });

  const results = await Promise.allSettled(searchPromises);
  
  // Find successful matches and sort by score
  const matches = results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value)
    .sort((a, b) => b.highestScore - a.highestScore);

  if (matches.length === 0) {
    logger.warn(`[Engine] No matches found across all sources for "${anime.title}"`);
    activeScrapes.delete(animeId);
    return;
  }

  // Fallback Logic: Try each match in order until we find one that actually has episodes
  for (const match of matches) {
    const { source, bestItem, highestScore } = match;
    
    try {
      logger.info(`[Engine] Trying match "${bestItem.title}" (${source.name}) with score ${highestScore}`);
      
      // Attempt to scrape episodes for this specific match
      const episodesFound = await scrapeEpisodes(anime._id, bestItem.url, source);
      
      if (episodesFound && episodesFound.length > 0) {
        logger.info(`[Engine] Successfully linked "${anime.title}" to ${source.name} with ${episodesFound.length} episodes`);
        
        await Anime.findByIdAndUpdate(anime._id, {
          $set: {
            sourceId: bestItem.sourceId,
            scrapeSource: source.name,
          },
        });
        
        activeScrapes.delete(animeId);
        return; // Success!
      } else {
        logger.warn(`[Engine] Match "${bestItem.title}" (${source.name}) returned 0 episodes. Trying next match...`);
      }
    } catch (err) {
      logger.error(`[Engine] Error during fallback scrape for ${source.name}: ${err.message}`);
    }
  }

  logger.error(`[Engine] All ${matches.length} matches for "${anime.title}" failed to yield episodes.`);
  activeScrapes.delete(animeId);
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

/**
 * Lazily enrich all episodes for a specific anime in batches.
 * Fetches high-quality metadata from external providers (AniList/TMDB).
 */
async function enrichAllEpisodesMetadata(animeId) {
  const cacheKey = `enrichment-lock:${animeId}`;
  if (getCache(cacheKey)) return; // Already recently enriched or in-progress
  
  setCache(cacheKey, true); // Lock for 1 hour default

  try {
    const anime = await Anime.findById(animeId);
    if (!anime || !anime.anilistId) return;

    logger.info(`[Engine] Running batch enrichment for "${anime.title}"...`);
    const metaEpisodes = await fetchEpisodeMetadata(anime.anilistId);
    
    if (metaEpisodes.length === 0) return;

    // Process in batches of 50 to avoid blocking the event loop or slamming the DB
    const BATCH_SIZE = 50;
    for (let i = 0; i < metaEpisodes.length; i += BATCH_SIZE) {
      const batch = metaEpisodes.slice(i, i + BATCH_SIZE);
      
      const updatePromises = batch.map(meta => {
        return Episode.findOneAndUpdate(
          { animeId, number: meta.number },
          { 
            $set: { 
              description: meta.description,
              thumbnail: meta.thumbnail,
              title: meta.title,
              seasonNumber: meta.seasonNumber
            } 
          },
          { new: true }
        );
      });

      await Promise.allSettled(updatePromises);
    }

    logger.info(`[Engine] Batch enrichment complete for "${anime.title}".`);
    
    // Also fetch and store logo/background assets if missing
    if (!anime.logo || !anime.fanartBackground) {
      try {
        logger.info(`[Engine] Pre-fetching assets for "${anime.title}"...`);
        const { logoUrl, bgUrl } = await fanart.getFanartAssetsByAnilistId(anime.anilistId, anime.tvdbId);
        if (logoUrl || bgUrl) {
          await Anime.findByIdAndUpdate(animeId, { 
            $set: { 
              logo: logoUrl || anime.logo, 
              fanartBackground: bgUrl || anime.fanartBackground 
            } 
          });
          logger.info(`[Engine] Assets stored for "${anime.title}".`);
        }
      } catch (assetErr) {
        logger.warn(`[Engine] Asset pre-fetch failed: ${assetErr.message}`);
      }
    }

    // Mark as enriched to avoid redundant full-syncs
    await Anime.findByIdAndUpdate(animeId, { $set: { metaEnriched: true } });
  } catch (err) {
    logger.error(`[Engine] Batch enrichment failed: ${err.message}`);
  }
}

module.exports = {
  scrape,
  scrapeCatalog,
  scrapeEpisodes,
  fetchEpisodeSources,
  linkAndFetchEpisodes,
  enrichAllEpisodesMetadata,
  runScrape,
  activeScrapes,
};
