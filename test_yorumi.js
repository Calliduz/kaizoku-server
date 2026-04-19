const animepahe = require('./src/scrapers/sources/animepahe');
const logger = require('./src/utils/logger');

async function test() {
    logger.info('Testing Yorumi Protocol on One Piece...');
    
    // Test Search (should be fast)
    const results = await animepahe.searchAnime('One Piece');
    console.log('Search Results:', results.length);
    
    if (results.length > 0) {
        // Test Episodes
        const episodes = await animepahe.getEpisodes(results[0].url);
        console.log('Episodes found:', episodes.length);
        
        if (episodes.length > 0) {
            // Test Extraction (should trigger Prime if unauthenticated, then scrape DOM)
            const sources = await animepahe.getStreamingSources(episodes[episodes.length - 1].url);
            console.log('Sources extracted:', JSON.stringify(sources, null, 2));
        }
    }
    
    process.exit(0);
}

test();
