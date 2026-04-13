const mongoose = require("mongoose");
const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const { searchAniList, normalizeAniListData } = require("../scrapers/anilist");
const { findBestMatch } = require("../scrapers/matcher");
const env = require("../config/env");
const logger = require("../utils/logger");

function toSlug(value = "") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function cleanTitle(title = "") {
  return title
    .replace(/\s+/g, " ")
    .replace(/episode\s+\d+/gi, "")
    .replace(/eps\s+\d+/gi, "")
    .replace(/\b(?:Season|S)\s*\d+\b/gi, "")
    .replace(/\d+(?:st|nd|rd|th)\s+Season/gi, "")
    .replace(
      /\b(?:Subbed|Dubbed|Sub|Dub|English|Italiano|Español|Português)\b/gi,
      "",
    )
    .replace(/[\[\]\(\)]/g, " ") // Preserved colons/hyphens to avoid smashing valid short titles together
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Core Deduplication Logic
 * Groups anime by AniList ID or Slug and merges duplicate entries.
 */
async function runDeduplication() {
  try {
    const start = Date.now();
    logger.info("[Deduplication] Starting deep cleanup pass...");

    // 1. First Pass: Re-link missing AniList IDs
    const missingMetadata = await Anime.find({ anilistId: { $exists: false } });
    if (missingMetadata.length > 0) {
      logger.info(
        `[Deduplication] Attempting to link ${missingMetadata.length} records to AniList...`,
      );
      for (const anime of missingMetadata) {
        try {
          const results = await searchAniList(anime.title);
          const { match } = findBestMatch(anime.title, results);
          if (match) {
            logger.info(`[Deduplication] Linked "${anime.title}" to AniList ID: ${match.id}`);
            await Anime.findByIdAndUpdate(anime._id, {
              $set: {
                anilistId: match.id,
                ...normalizeAniListData(match),
              },
            });
          }
        } catch (e) {
          // Skip failures
        }
      }
    }

    // 2. Second Pass: Group and Merge by AniList ID
    const allAnime = await Anime.find({});
    const anilistMap = {};
    const slugMap = {};

    for (const anime of allAnime) {
      if (anime.anilistId) {
        if (!anilistMap[anime.anilistId]) anilistMap[anime.anilistId] = [];
        anilistMap[anime.anilistId].push(anime);
      } else {
        const normalizedTitle = cleanTitle(anime.title);
        const normalizedSlug = toSlug(normalizedTitle);
        if (normalizedSlug.length >= 6) {
          if (!slugMap[normalizedSlug]) slugMap[normalizedSlug] = [];
          slugMap[normalizedSlug].push(anime);
        }
      }
    }

    let deletedCount = 0;
    let mergedEpisodesCount = 0;

    const processGroups = async (map) => {
      for (const key in map) {
        const duplicates = map[key];
        if (duplicates.length > 1) {
          logger.info(`[Deduplication] Found ${duplicates.length} duplicates for key: ${key}`);

          duplicates.sort((a, b) => {
            if (a.anilistId && !b.anilistId) return -1;
            if (!a.anilistId && b.anilistId) return 1;
            if (a.description?.length > b.description?.length) return -1;
            return 0;
          });

          const primary = duplicates[0];
          const toDelete = duplicates.slice(1);

          for (const duplicate of toDelete) {
            const dupEpisodes = await Episode.find({ animeId: duplicate._id });
            for (const ep of dupEpisodes) {
              const exists = await Episode.findOne({
                animeId: primary._id,
                number: ep.number,
              });
              if (exists) {
                await Episode.findByIdAndDelete(ep._id);
              } else {
                await Episode.findByIdAndUpdate(ep._id, {
                  $set: { animeId: primary._id },
                });
                mergedEpisodesCount++;
              }
            }
            await Anime.findByIdAndDelete(duplicate._id);
            deletedCount++;
          }
        }
      }
    };

    await processGroups(anilistMap);
    await processGroups(slugMap);

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    logger.info(
      `[Deduplication] Complete in ${duration}s! Deleted ${deletedCount} records and merged ${mergedEpisodesCount} episodes.`,
    );
    
    return { deletedCount, mergedEpisodesCount };
  } catch (error) {
    logger.error(`[Deduplication] Failed: ${error.message}`);
    throw error;
  }
}

// Support CLI execution
if (require.main === module) {
  (async () => {
    try {
      await mongoose.connect(env.MONGODB_URI);
      await runDeduplication();
    } catch (err) {
      console.error(err);
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  })();
}

module.exports = { runDeduplication };
