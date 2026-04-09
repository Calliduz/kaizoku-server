const mongoose = require("mongoose");
const env = require("../config/env");
const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const logger = require("../utils/logger");

async function cleanupPlaybackData() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info("[Cleanup] Connected to MongoDB");

  const bbbAnime = await Anime.find({ title: /big\s*buck\s*bunny/i })
    .select("_id")
    .lean();
  const animeIds = bbbAnime.map((item) => item._id);

  let deletedEpisodesByAnime = 0;
  if (animeIds.length > 0) {
    const episodeDeleteResult = await Episode.deleteMany({
      animeId: { $in: animeIds },
    });
    deletedEpisodesByAnime = episodeDeleteResult.deletedCount || 0;
  }

  const animeDeleteResult = await Anime.deleteMany({
    title: /big\s*buck\s*bunny/i,
  });

  const fallbackCleanResult = await Episode.updateMany(
    { "streamingSources.url": /test-streams\.mux\.dev/i },
    { $pull: { streamingSources: { url: /test-streams\.mux\.dev/i } } },
  );

  logger.info(
    `[Cleanup] deletedAnime=${animeDeleteResult.deletedCount || 0} deletedEpisodesByAnime=${deletedEpisodesByAnime} episodesCleanedFromFallback=${fallbackCleanResult.modifiedCount || 0}`,
  );

  await mongoose.disconnect();
  logger.info("[Cleanup] Done");
}

cleanupPlaybackData().catch(async (error) => {
  logger.error(`[Cleanup] Failed: ${error.message}`);
  try {
    await mongoose.disconnect();
  } catch (_e) {
    // ignore disconnect error in failure path
  }
  process.exit(1);
});
