const { Router } = require('express');
const {
  getAll,
  getById,
  getEpisodes,
  getEpisodeSources,
  triggerScrape,
  getSuggestions,
} = require('../controllers/animeController');

const router = Router();

// ── Anime catalog ──────────────────────────────────────────
router.get('/anime', getAll);
router.get('/anime/search/suggest', getSuggestions);
router.get('/anime/:id', getById);
router.get('/anime/:id/episodes', getEpisodes);

// ── Episode sources ────────────────────────────────────────
router.get('/episodes/:id/sources', getEpisodeSources);

// ── Scraper ────────────────────────────────────────────────
router.post('/scrape', triggerScrape);

module.exports = router;
