const mongoose = require("mongoose");
const env = require("./src/config/env");
const Episode = require("./src/models/Episode");
const Anime = require("./src/models/Anime");

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(env.MONGODB_URI);
    console.log("Connected.");

    // Delete all cached episodes from the database
    console.log("Deleting all cached episodes...");
    const epResult = await Episode.deleteMany({});
    console.log(`Deleted ${epResult.deletedCount} episodes.`);

    // Reset scraping state on all anime records to force a clean re-scrape
    console.log("Resetting anime scraping metadata...");
    const animeResult = await Anime.updateMany(
      {},
      {
        $set: {
          sourceId: "",
          scrapeSource: "",
          episodesUpdatedAt: null,
          metaEnriched: false,
        },
      }
    );
    console.log(`Reset metadata for ${animeResult.modifiedCount} anime records.`);
    console.log("Cache cleared successfully!");
  } catch (error) {
    console.error("Error clearing cache:", error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}
run();
