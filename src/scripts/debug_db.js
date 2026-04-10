const mongoose = require('mongoose');
const Anime = require('../models/Anime');
const env = require('../config/env');

async function debug() {
  await mongoose.connect(env.MONGODB_URI);
  const anime = await Anime.find({ title: /Kujima/i });
  console.log(JSON.stringify(anime, null, 2));
  await mongoose.disconnect();
  process.exit(0);
}

debug();
