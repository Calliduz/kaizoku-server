const mongoose = require("mongoose");
const env = require("../config/env");
const Anime = require("../models/Anime");
const logger = require("../utils/logger");

const AOD_URL = "https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json";

function extractAnilistId(sources) {
  if (!sources) return null;
  for (const src of sources) {
    if (src.includes("anilist.co/anime/")) {
      const match = src.match(/anilist\.co\/anime\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

function mapStatus(aodStatus) {
  switch (aodStatus) {
    case "FINISHED":
      return "FINISHED";
    case "ONGOING":
      return "RELEASING";
    case "UPCOMING":
      return "NOT_YET_RELEASED";
    default:
      return "UNKNOWN";
  }
}

function toSlug(value = "", id = "") {
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  if (id) slug += `-${id}`;
  return slug;
}

async function runSeed() {
  try {
    logger.info("[Seeder] Connecting to MongoDB...");
    await mongoose.connect(env.MONGODB_URI);
    logger.info("[Seeder] Connected to MongoDB.");

    logger.info(`[Seeder] Fetching Anime-Offline-Database from ${AOD_URL}...`);
    const response = await fetch(AOD_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch AOD: ${response.statusText}`);
    }

    const json = await response.json();
    const data = json.data;
    logger.info(`[Seeder] Fetched ${data.length} anime entries. Processing...`);

    const batchSize = 1000;
    let operations = [];
    let processed = 0;
    let upseretCount = 0;

    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      const anilistId = extractAnilistId(item.sources);
      const title = item.title;
      // Skip items without an anilist ID or title to maintain DB quality matching
      if (!title) continue;

      const animeData = {
        title: title,
        slug: toSlug(title, anilistId || i),
        altTitles: item.synonyms || [],
        coverImage: item.picture || item.thumbnail || "",
        status: mapStatus(item.status),
        format: item.type || null,
        totalEpisodes: item.episodes || 0,
        episodeDuration: item.duration?.value ? Math.round(item.duration.value / 60) : null,
        rating: item.score?.arithmeticMean ? Math.round(item.score.arithmeticMean * 10) : 0,
        season: item.animeSeason?.season || null,
        seasonYear: item.animeSeason?.year || null,
        studios: (item.studios || []).map((s) => ({ name: s, isAnimationStudio: true })),
        tags: item.tags || [],
      };

      if (anilistId) {
        animeData.anilistId = anilistId;
      }

      // Unique lookup key: prefer anilistId if available, else fallback to title
      let filter = { title: title };
      if (anilistId) {
        filter = { anilistId: anilistId };
      }

      operations.push({
        updateOne: {
          filter: filter,
          update: {
            $setOnInsert: { sourceId: "", scrapeSource: "" },
            $set: animeData,
          },
          upsert: true,
        },
      });

      if (operations.length === batchSize || i === data.length - 1) {
        if (operations.length > 0) {
          await Anime.bulkWrite(operations, { ordered: false });
          upseretCount += operations.length;
          operations = [];
          logger.info(`[Seeder] Seeded batch: ${upseretCount}/${data.length}`);
        }
      }
    }

    logger.info(`[Seeder] Seeding done! Successfully processed ${upseretCount} items.`);

  } catch (err) {
    logger.error(`[Seeder] Error executing seed: ${err.message}`);
  } finally {
    await mongoose.disconnect();
    logger.info("[Seeder] Disconnected from MongoDB. Exiting.");
  }
}

runSeed();
