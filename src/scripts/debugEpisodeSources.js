const mongoose = require('mongoose');
const env = require('../config/env');
const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const gogoanime = require('../scrapers/sources/gogoanime');

async function run() {
  await mongoose.connect(env.MONGODB_URI);

  const anime = await Anime.findOne({ title: /^one piece$/i }).lean();
  if (!anime) {
    console.log('No One Piece anime found');
    await mongoose.disconnect();
    return;
  }

  const episode = await Episode.findOne({ animeId: anime._id, number: 1 }).lean();
  if (!episode) {
    console.log('No episode 1 found for One Piece');
    await mongoose.disconnect();
    return;
  }

  const fallbackUrl = `${gogoanime.BASE_URL}/${anime.sourceId}-episode-${episode.number}`;
  const candidates = gogoanime.buildEpisodeUrls({ anime, episode, fallbackUrl });

  console.log('Anime:', anime._id.toString(), anime.sourceId);
  console.log('Episode:', episode._id.toString(), episode.sourceEpisodeId);
  console.log('Candidates:', candidates);

  for (const url of candidates) {
    const sources = await gogoanime.getStreamingSources(url);
    console.log(`URL: ${url}`);
    console.log(`Sources: ${sources.length}`);
    if (sources.length > 0) {
      console.log('Sample:', sources.slice(0, 3));
    }
  }

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_err) {
    // ignore
  }
  process.exit(1);
});
