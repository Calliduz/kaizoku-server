const mongoose = require('mongoose');
const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const { searchAniList, normalizeAniListData } = require('../scrapers/anilist');
const { findBestMatch } = require('../scrapers/matcher');
const env = require('../config/env');
const logger = require('../utils/logger');

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
    .replace(/\s+0\d+\s+/g, " ")
    .replace(/\s+0\d+$/g, " ")
    .replace(/\b(?:Season|S)\s*\d+\b/gi, "")
    .replace(/\d+(?:st|nd|rd|th)\s+Season/gi, "")
    .replace(/\s+(?:Part|Pt)\s*\d+/gi, "")
    .replace(/\s+Cour\s*\d+/gi, "")
    .replace(/\b(?:Subbed|Dubbed|Sub|Dub|English|Italiano|Español|Português)\b/gi, "")
    .replace(/\[\d+p\]/gi, "")
    .replace(/[\[\]\(\)\-:]/g, " ") 
    .replace(/\s+/g, " ")
    .trim();
}

async function deduplicate() {
  try {
    await mongoose.connect(env.MONGODB_URI);
    logger.info('Connected to MongoDB for deep deduplication');

    // 1. First Pass: Re-link missing AniList IDs
    const missingMetadata = await Anime.find({ anilistId: { $exists: false } });
    if (missingMetadata.length > 0) {
      logger.info(`Attempting to link ${missingMetadata.length} records to AniList...`);
      for (const anime of missingMetadata) {
        try {
          const results = await searchAniList(anime.title);
          const { match } = findBestMatch(anime.title, results);
          if (match) {
            logger.info(`Linked "${anime.title}" to AniList ID: ${match.id}`);
            await Anime.findByIdAndUpdate(anime._id, {
              $set: { 
                anilistId: match.id,
                ...normalizeAniListData(match)
              }
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
      // Priority 1: Anilist ID
      if (anime.anilistId) {
        if (!anilistMap[anime.anilistId]) anilistMap[anime.anilistId] = [];
        anilistMap[anime.anilistId].push(anime);
      } else {
        // Priority 2: Slug fallback
        const normalizedTitle = cleanTitle(anime.title);
        const normalizedSlug = toSlug(normalizedTitle);
        if (!slugMap[normalizedSlug]) slugMap[normalizedSlug] = [];
        slugMap[normalizedSlug].push(anime);
      }
    }

    let deletedCount = 0;
    let mergedEpisodesCount = 0;

    const processGroups = async (map) => {
      for (const key in map) {
        const duplicates = map[key];
        if (duplicates.length > 1) {
          logger.info(`Found ${duplicates.length} duplicates for key: ${key}`);
          
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
              const exists = await Episode.findOne({ animeId: primary._id, number: ep.number });
              if (exists) {
                await Episode.findByIdAndDelete(ep._id);
              } else {
                await Episode.findByIdAndUpdate(ep._id, { $set: { animeId: primary._id } });
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

    logger.info(`Deduplication complete! Deleted ${deletedCount} records and merged ${mergedEpisodesCount} episodes.`);
  } catch (error) {
    logger.error(`Deduplication failed: ${error.message}`);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

deduplicate();
