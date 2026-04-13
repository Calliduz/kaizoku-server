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

    // 1. First Pass: Re-link missing AniList IDs (Memory efficient using Cursor)
    const missingMetadataCursor = Anime.find({ anilistId: null }).cursor();
    let linkedCount = 0;
    
    for (let anime = await missingMetadataCursor.next(); anime != null; anime = await missingMetadataCursor.next()) {
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
          linkedCount++;
        }
      } catch (e) {
        // Skip failures for individual items
      }
    }
    if (linkedCount > 0) logger.info(`[Deduplication] Linked ${linkedCount} records to AniList.`);

    // 2. Second Pass: Group and Merge by AniList ID (Using Aggregation - zero heap overhead for grouping)
    const anilistDuplicates = await Anime.aggregate([
      { $match: { anilistId: { $ne: null } } },
      { $group: { _id: "$anilistId", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    // 3. Third Pass: Group by Slug (Using Cursor to build lightweight ID map)
    const slugMap = new Map();
    const slugCursor = Anime.find({ anilistId: null }, { _id: 1, title: 1 }).cursor();
    
    for (let anime = await slugCursor.next(); anime != null; anime = await slugCursor.next()) {
      const normalizedTitle = cleanTitle(anime.title);
      const normalizedSlug = toSlug(normalizedTitle);
      if (normalizedSlug.length >= 6) {
        if (!slugMap.has(normalizedSlug)) slugMap.set(normalizedSlug, []);
        slugMap.get(normalizedSlug).push(anime._id);
      }
    }

    let deletedCount = 0;
    let mergedEpisodesCount = 0;

    /**
     * Optimized Merge: Works with IDs to keep memory usage low.
     */
    const mergeDuplicates = async (ids) => {
      if (ids.length <= 1) return;

      // Fetch minimal info for sorting
      const duplicates = await Anime.find({ _id: { $in: ids } })
        .select("_id anilistId description title")
        .lean();

      duplicates.sort((a, b) => {
        if (a.anilistId && !b.anilistId) return -1;
        if (!a.anilistId && b.anilistId) return 1;
        if ((a.description?.length || 0) > (b.description?.length || 0)) return -1;
        return 0;
      });

      const primary = duplicates[0];
      const toDelete = duplicates.slice(1);

      for (const duplicate of toDelete) {
        // Process episodes in batches via cursor
        const epCursor = Episode.find({ animeId: duplicate._id }).cursor();
        
        for (let ep = await epCursor.next(); ep != null; ep = await epCursor.next()) {
          const exists = await Episode.findOne({
            animeId: primary._id,
            number: ep.number,
          }).select("_id").lean();

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
    };

    // Process AniList groups
    for (const group of anilistDuplicates) {
      logger.info(`[Deduplication] Merging ${group.ids.length} duplicates for AniList ID: ${group._id}`);
      await mergeDuplicates(group.ids);
    }

    // Process Slug groups
    for (const [slug, ids] of slugMap.entries()) {
      if (ids.length > 1) {
        logger.info(`[Deduplication] Merging ${ids.length} duplicates for Slug: ${slug}`);
        await mergeDuplicates(ids);
      }
    }

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
