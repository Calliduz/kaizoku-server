const gogoanime = require('./src/scrapers/sources/gogoanime.js');

async function testAll() {
  console.log("=== Testing Search ===");
  const results = await gogoanime.searchAnime('frieren');
  console.log(results);

  if (results && results.length > 0) {
    const firstUrl = results[0].url;
    console.log("\n=== Testing Episode List ===");
    const episodes = await gogoanime.getEpisodes(firstUrl);
    console.log(episodes.slice(0, 5));

    if (episodes && episodes.length > 0) {
      console.log("\n=== Testing Video Source ===");
      const sources = await gogoanime.getStreamingSources(episodes[0].url);
      console.log(sources);
    }
  }
}

testAll().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
