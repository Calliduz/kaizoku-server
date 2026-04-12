const mongoose = require("mongoose");
const env = require("./src/config/env");
const Anime = require("./src/models/Anime");

async function run() {
  await mongoose.connect(env.MONGODB_URI);
  const res = await Anime.updateMany({}, { $set: { fanartBackground: "" } });
  console.log("Cleared fanartBackground for", res.modifiedCount, "anime");
  process.exit(0);
}
run();
