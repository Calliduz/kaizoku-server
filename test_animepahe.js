const {
  searchAnime,
  getEpisodes,
} = require("./src/scrapers/sources/animepahe");
const fuzzball = require("fuzzball");

async function run() {
  const search = await searchAnime("ONE PIECE");
  console.log("Search results:", search.length);
  if (search.length > 0) {
    const score = fuzzball.ratio(search[0].title.toLowerCase(), "one piece");
    console.log("Match Score:", score);
    console.log("URL:", search[0].url);
    const eps = await getEpisodes(search[0].url);
    console.log("Total Episodes listed:", eps.length);
    console.log(
      "Ep 1:",
      eps.find((e) => e.number === 1),
    );
  }
  process.exit(0);
}
run();
