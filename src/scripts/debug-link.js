const mongoose = require("mongoose");
const env = require("../config/env");
const Anime = require("../models/Anime");
const { searchAniList } = require("../scrapers/anilist");
const { findBestMatch } = require("../scrapers/matcher");
const gogoanime = require("../scrapers/sources/gogoanime");
const puppeteerPool = require("../utils/puppeteerPool");

async function debug() {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected DB");
  const anime = await Anime.findById("69d7c31c269432440cc32411");
  console.log("Anime Title:", anime.title, "Anilist ID:", anime.anilistId);

  const searchResults = await gogoanime.searchAnime(anime.title);
  console.log(`Found ${searchResults.length} results from gogoanime`);

  for (const item of searchResults) {
    if (anime.anilistId) {
      console.log(`Searching AniList for: ${item.title}`);
      const anilistResults = await searchAniList(item.title);
      const { match, isExact } = findBestMatch(item.title, anilistResults);
      console.log(`Best match for ${item.title} -> ${match?.title?.romaji || 'NONE'} (ID: ${match?.id}) - exact? ${isExact}`);
      if (match && match.id === anime.anilistId) {
        console.log("FOUND A MATCH!");
      }
    }
  }

  await puppeteerPool.shutdown();
  process.exit(0);
}
debug();
