const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const env = require('../config/env');
const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const logger = require('../utils/logger');

// Dummy data using a public test HLS stream
const TEST_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

const mockAnimes = [
  {
    title: 'One Piece',
    slug: 'one-piece',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-YCDignzj9mHj.jpg',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg',
    description: 'Gold Roger was known as the Pirate King, the strongest and most infamous being to have sailed the Grand Line. The capture and death of Roger by the World Government brought a change throughout the world. His last words before his death revealed the location of the greatest treasure in the world, One Piece...',
    genres: ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy'],
    status: 'RELEASING',
    totalEpisodes: 1100,
    rating: 86,
    sourceId: 'one-piece',
    source: 'gogoanime',
  },
  {
    title: 'Jujutsu Kaisen',
    slug: 'jujutsu-kaisen',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-bbBWj4pEFseh.jpg',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg',
    description: 'Idly indulging in baseless paranormal activities with the Occult Club, high schooler Yuuji Itadori spends his days at either the clubroom or the hospital, where he visits his bedridden grandfather. However, this leisurely lifestyle soon takes a turn for the bizarre...',
    genres: ['Action', 'Drama', 'Supernatural'],
    status: 'FINISHED',
    totalEpisodes: 24,
    rating: 86,
    sourceId: 'jujutsu-kaisen',
    source: 'gogoanime',
  },
  {
    title: 'Attack on Titan',
    slug: 'attack-on-titan',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-m5ZMNtFiG7ng.webp',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmnei.jpg',
    description: 'Centuries ago, mankind was slaughtered to near extinction by monstrous humanoid creatures called titans, forcing humans to hide in fear behind enormous concentric walls. What makes these giants truly terrifying is that their taste for human flesh is not born out of hunger but what appears to be out of pleasure...',
    genres: ['Action', 'Drama', 'Fantasy', 'Mystery'],
    status: 'FINISHED',
    totalEpisodes: 25,
    rating: 85,
    sourceId: 'attack-on-titan',
    source: 'gogoanime',
  },
  {
    title: 'Demon Slayer: Kimetsu no Yaiba',
    slug: 'demon-slayer',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-PEn1CTc93DQl.jpg',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-YlzjhB6ugnN9.jpg',
    description: 'Ever since the death of his father, the burden of supporting the family has fallen upon Tanjirou Kamado\'s shoulders. Though living impoverished on a remote mountain, the Kamado family are able to enjoy a relatively peaceful and happy life. One day, Tanjirou decides to go down to the local village to make a little money selling charcoal...',
    genres: ['Action', 'Adventure', 'Fantasy'],
    status: 'FINISHED',
    totalEpisodes: 26,
    rating: 83,
    sourceId: 'demon-slayer',
    source: 'gogoanime',
  },
  {
    title: 'Solo Leveling',
    slug: 'solo-leveling',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-m1gX3iwfIsLu.png',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-3FqEONiZg842.jpg',
    description: 'Ten years ago, "the Gate" appeared and connected the real world with the realm of magic and monsters. To combat these vile beasts, ordinary people received superhuman powers and became known as "Hunters." Twenty-year-old Sung Jin-Woo is one such Hunter, but he is known as the "World\'s Weakest"...',
    genres: ['Action', 'Adventure', 'Fantasy'],
    status: 'FINISHED',
    totalEpisodes: 12,
    rating: 84,
    sourceId: 'solo-leveling',
    source: 'gogoanime',
  },
  {
    title: 'Frieren: Beyond Journey\'s End',
    slug: 'frieren',
    coverImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-n1MjsJvAhaB1.jpg',
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg',
    description: 'The demon king has been defeated, and the victorious hero party returns home before disbanding. The four—mage Frieren, hero Himmel, priest Heiter, and warrior Eisen—reminisce about their decade-long journey as the moment to bid each other farewell arrives. But the passing of time is different for elves, thus Frieren witnesses her companions slowly pass away one by one.',
    genres: ['Adventure', 'Drama', 'Fantasy'],
    status: 'FINISHED',
    totalEpisodes: 28,
    rating: 91,
    sourceId: 'frieren',
    source: 'gogoanime',
  }
];

async function seed() {
  try {
    logger.info(`Connecting to database at ${env.MONGODB_URI}`);
    await mongoose.connect(env.MONGODB_URI);
    logger.info('Connected.');

    logger.info('Clearing database...');
    await Anime.deleteMany({});
    await Episode.deleteMany({});
    logger.info('Database cleared.');

    logger.info('Seeding Anime...');
    const insertedAnimes = await Anime.insertMany(mockAnimes);
    
    logger.info('Seeding Episodes...');
    const mockEpisodes = [];

    // Each anime gets 5 dummy episodes
    for (const anime of insertedAnimes) {
      for (let i = 1; i <= 5; i++) {
        mockEpisodes.push({
          animeId: anime._id,
          number: i,
          title: `Episode ${i}`,
          sourceEpisodeId: `${anime.sourceId}-episode-${i}`,
          thumbnail: anime.bannerImage,
          streamingSources: [
            {
              url: TEST_HLS_URL,
              quality: 'auto',
              server: 'test-HLS-Server',
              type: 'hls'
            }
          ]
        });
      }
    }

    await Episode.insertMany(mockEpisodes);
    logger.info(`Done! Inserted ${insertedAnimes.length} Anime and ${mockEpisodes.length} Episodes.`);

    process.exit(0);
  } catch (error) {
    logger.error('Seed script failed:', error);
    process.exit(1);
  }
}

seed();
