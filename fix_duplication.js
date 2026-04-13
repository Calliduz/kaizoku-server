const mongoose = require('mongoose');
const Anime = require('./src/models/Anime');
const Episode = require('./src/models/Episode');
const env = require('./src/config/env');

async function cleanAll() {
  await mongoose.connect(env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // 1. Group by AniList ID
  const dupGroups = await Anime.aggregate([
    { $match: { anilistId: { $ne: null } } },
    { $group: { _id: '$anilistId', count: { $sum: 1 }, ids: { $push: '$_id' }, titles: { $push: '$title' } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  console.log(`Found ${dupGroups.length} groups of duplicates by AniList ID`);

  let deletedTotal = 0;

  for (const group of dupGroups) {
    console.log(`Cleaning group ${group._id} with ${group.count} entries`);
    const docs = await Anime.find({ _id: { $in: group.ids } }).sort({ description: -1, updatedAt: -1 });
    const primary = docs[0];
    const duplicates = docs.slice(1);

    for (const dup of duplicates) {
      console.log(`Merging duplicate "${dup.title}" (${dup._id}) -> "${primary.title}" (${primary._id})`);
      const res = await Episode.updateMany({ animeId: dup._id }, { $set: { animeId: primary._id } });
      console.log(`  Moved ${res.modifiedCount} episodes`);
      await Anime.findByIdAndDelete(dup._id);
      deletedTotal++;
    }
  }

  console.log(`Deduplication complete. Deleted ${deletedTotal} duplicate records.`);
  process.exit(0);
}

cleanAll();
