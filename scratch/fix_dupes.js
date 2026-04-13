const mongoose = require('mongoose');
const Anime = require('./src/models/Anime');
const Episode = require('./src/models/Episode');
const env = require('./src/config/env');

async function fix() {
  await mongoose.connect(env.MONGODB_URI);
  console.log('Connected');

  const anilistId = 21;
  const docs = await Anime.find({ anilistId });
  console.log(`Found ${docs.length} docs for anilistId ${anilistId}`);

  if (docs.length > 1) {
    const primary = docs[0];
    const duplicates = docs.slice(1);

    for (const dup of duplicates) {
      console.log(`Merging ${dup._id} into ${primary._id}`);
      // Move episodes
      const res = await Episode.updateMany({ animeId: dup._id }, { $set: { animeId: primary._id } });
      console.log(`Moved ${res.modifiedCount} episodes`);
      // Delete dup
      await Anime.findByIdAndDelete(dup._id);
      console.log(`Deleted ${dup._id}`);
    }
  }

  process.exit(0);
}

fix();
