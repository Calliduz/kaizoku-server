const mongoose = require("mongoose");
const env = require("./src/config/env");
const Episode = require("./src/models/Episode");

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(env.MONGODB_URI);
    console.log("Connected. Clearing streamingSources arrays...");
    const result = await Episode.updateMany(
      {},
      { $set: { streamingSources: [] } },
    );
    console.log("Result: " + result.modifiedCount + " episodes updated.");
  } catch (error) {
    console.error("Error clearing:", error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}
run();
