const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const { scrape, fetchEpisodeSources } = require('../scrapers/engine');
const asyncHandler = require('../middleware/asyncHandler');

/**
 * @desc    Get all anime (paginated, searchable)
 * @route   GET /api/anime
 * @query   page, limit, search, genre, status
 */
const getAll = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  // Build query filter
  const filter = {};

  if (req.query.search) {
    filter.$text = { $search: req.query.search };
  }

  if (req.query.genre) {
    filter.genres = { $in: [req.query.genre] };
  }

  if (req.query.status) {
    filter.status = req.query.status.toUpperCase();
  }

  const [anime, total] = await Promise.all([
    Anime.find(filter)
      .sort(req.query.search ? { score: { $meta: 'textScore' } } : { updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Anime.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: anime,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * @desc    Get single anime by ID
 * @route   GET /api/anime/:id
 */
const getById = asyncHandler(async (req, res) => {
  const anime = await Anime.findById(req.params.id).lean();

  if (!anime) {
    const error = new Error('Anime not found');
    error.statusCode = 404;
    throw error;
  }

  res.json({ success: true, data: anime });
});

/**
 * @desc    Get episodes for an anime
 * @route   GET /api/anime/:id/episodes
 */
const getEpisodes = asyncHandler(async (req, res) => {
  const episodes = await Episode.find({ animeId: req.params.id })
    .sort({ number: 1 })
    .lean();

  res.json({ success: true, data: episodes });
});

/**
 * @desc    Get streaming sources for an episode (fetches on-demand if not cached)
 * @route   GET /api/episodes/:id/sources
 */
const getEpisodeSources = asyncHandler(async (req, res) => {
  const sources = await fetchEpisodeSources(req.params.id);

  res.json({ success: true, data: sources });
});

/**
 * @desc    Trigger a scrape operation
 * @route   POST /api/scrape
 * @body    { query: string, fetchEpisodes?: boolean }
 */
const triggerScrape = asyncHandler(async (req, res) => {
  const { query, fetchEpisodes = false } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    const error = new Error('Query is required and must be a non-empty string');
    error.statusCode = 400;
    throw error;
  }

  const results = await scrape(query.trim(), { fetchEpisodes });

  res.status(201).json({
    success: true,
    message: `Scraped ${results.length} anime for "${query}"`,
    data: results,
  });
});

module.exports = { getAll, getById, getEpisodes, getEpisodeSources, triggerScrape };
