const { Router } = require("express");
const {
  getAll,
  getById,
  getEpisodes,
  getEpisodeSources,
  triggerScrape,
  getSuggestions,
  getLogo,
  getTop100,
  getSchedule,
} = require("../controllers/animeController");

const router = Router();

// ── Anime catalog ────────────────────────────────
router.get("/anime", getAll);
router.get("/anime/top-100", getTop100);
router.get("/anime/airing-schedule", getSchedule);
router.get("/anime/search/suggest", getSuggestions);
router.get("/anime/:id", getById);
router.get("/anime/:id/logo", getLogo);
router.get("/anime/:id/episodes", getEpisodes);

// ── Episode sources ────────────────────────────────────────
router.get("/episodes/:id/sources", getEpisodeSources);

// ── Scraper ────────────────────────────────────────────────
router.post("/scrape", triggerScrape);

module.exports = router;
