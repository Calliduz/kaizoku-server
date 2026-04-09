const mongoose = require("mongoose");
const env = require("../config/env");
const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const { fetchEpisodeSources } = require("../scrapers/engine");

(async () => {
  await mongoose.connect(env.MONGODB_URI);
  const anime = await Anime.findOne({ title: /^one piece$/i }).lean();
  const ep = await Episode.findOne({ animeId: anime._id, number: 1 }).lean();
  const sources = await fetchEpisodeSources(ep._id.toString());
  console.log(
    JSON.stringify(
      {
        episodeId: ep._id.toString(),
        sourceEpisodeId: ep.sourceEpisodeId,
        count: sources.length,
        sources: sources.slice(0, 3),
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
})();
