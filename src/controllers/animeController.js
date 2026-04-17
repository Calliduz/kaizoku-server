const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const {
  scrape,
  fetchEpisodeSources,
  linkAndFetchEpisodes,
  enrichAllEpisodesMetadata,
} = require("../scrapers/engine");
const { searchAniList, normalizeAniListData } = require("../scrapers/anilist");
const asyncHandler = require("../middleware/asyncHandler");
const fanart = require("../utils/fanart");
const logger = require("../utils/logger");

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
    const searchTerms = req.query.search
      .trim()
      .split(/\s+/)
      .map((term) => term.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"));
    const lookaheadRegex = searchTerms.map((term) => `(?=.*${term})`).join("");
    const searchRegex = new RegExp(`^${lookaheadRegex}.*$`, "i");

    filter.$or = [{ title: searchRegex }, { altTitles: searchRegex }];
  }

  if (req.query.genre) {
    filter.genres = { $in: [req.query.genre] };
  }

  if (req.query.status) {
    filter.status = req.query.status.toUpperCase();
  }

  if (req.query.format) {
    filter.format = req.query.format.toUpperCase();
  }

  // Determine standard tie-breakers logically prioritizing Main Series
  let sortConfig = { _id: -1 };

  if (req.query.search) {
    // If searching, strongly favor length, popularity, and rating
    sortConfig = { totalEpisodes: -1, popularity: -1, rating: -1 };
  } else if (req.query.sort) {
    if (req.query.sort === "rating")
      sortConfig = { rating: -1, totalEpisodes: -1 };
    else if (req.query.sort === "popular")
      sortConfig = { popularity: -1, rating: -1 };
    else if (req.query.sort === "popularity")
      sortConfig = { popularity: -1, _id: -1 }; // Trending
    else if (req.query.sort === "newest")
      sortConfig = { catalogUpdatedAt: -1, _id: -1 };
    else sortConfig = { catalogUpdatedAt: -1, _id: -1 }; // Default to recently updated
  } else {
    sortConfig = { catalogUpdatedAt: -1, _id: -1 };
  }

  const [anime, total] = await Promise.all([
    Anime.aggregate([
      { $match: filter },
      // Relevance Scoring
      {
        $addFields: {
          searchScore: {
            $add: [
              // Exact matches get massive boost
              {
                $cond: [
                  { $eq: [{ $toLower: "$title" }, (req.query.search || "").toLowerCase().trim()] },
                  200,
                  0
                ]
              },
              // Starts with match boost
              {
                $cond: [
                  { 
                    $regexMatch: { 
                      input: "$title", 
                      regex: new RegExp(`^${(req.query.search || "").trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i") 
                    } 
                  },
                  50,
                  0
                ]
              },
              // Popularity scaling (normalized)
              { $divide: [{ $ifNull: ["$popularity", 0] }, 1000] },
              // Main series boost (favor TV over Specials/ONA/etc)
              { $cond: [{ $eq: ["$format", "TV"] }, 10, 0] },
              // Long-running series boost
              { $cond: [{ $gt: ["$totalEpisodes", 12] }, 15, 0] }
            ]
          }
        }
      },
      // Final Sort: Relevance > Popularity > Latest
      { 
        $sort: req.query.search 
          ? { searchScore: -1, popularity: -1 } 
          : sortConfig 
      },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: "episodes",
          let: { animeId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$animeId", "$$animeId"] } } },
            { $sort: { number: -1 } },
            { $limit: 1 },
            { $project: { number: 1 } },
          ],
          as: "latestEpisodeData",
        },
      },
      {
        $addFields: {
          latestEpisode: { $arrayElemAt: ["$latestEpisodeData.number", 0] },
          id: "$_id",
        },
      },
      { $project: { latestEpisodeData: 0 } },
    ]),
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
  let anime = await Anime.findById(req.params.id);

  if (!anime) {
    const error = new Error("Anime not found");
    error.statusCode = 404;
    throw error;
  }

  // Auto-enrich metadata if we have signs of low-quality or missing data
  const isLowQuality =
    !anime.anilistId ||
    !anime.description ||
    !anime.relations ||
    anime.relations.length === 0;

  if (isLowQuality) {
    const anilistResults = await searchAniList(anime.title, 5);
    if (anilistResults.length > 0) {
      // Use the first result (highest match score)
      const enrichedData = normalizeAniListData(anilistResults[0]);

      // Use findByIdAndUpdate to avoid VersionError constraints caused by concurrent requests
      anime = await Anime.findByIdAndUpdate(
        anime._id,
        { $set: enrichedData },
        { new: true, runValidators: true },
      );
    }
  }

  res.json({ success: true, data: anime });
});

/**
 * @desc    Get episodes for an anime
 * @route   GET /api/anime/:id/episodes
 */
const getEpisodes = asyncHandler(async (req, res) => {
  const anime = await Anime.findById(req.params.id);
  if (!anime) {
    return res.status(404).json({ success: false, message: "Anime not found" });
  }

  let episodes = await Episode.find({ animeId: req.params.id })
    .sort({ number: -1 })
    .lean();

  if (episodes.length === 0) {
    await linkAndFetchEpisodes(req.params.id);
    episodes = await Episode.find({ animeId: req.params.id })
      .sort({ number: -1 })
      .lean();
  }

  // Ensure metadata is synced (Netflix descriptions/thumbnails)
  // If not already enriched, WE WAIT for it to ensure the first visit is populated
  if (!anime.metaEnriched && episodes.length > 0) {
    logger.info(`[Controller] First-time metadata sync for ${anime.title}...`);
    await enrichAllEpisodesMetadata(req.params.id);
    // Re-fetch once to get the new data
    episodes = await Episode.find({ animeId: req.params.id })
      .sort({ number: -1 })
      .lean();
  }

  res.json({ success: true, data: episodes });
});

/**
 * @desc    Get streaming sources for an episode (fetches on-demand if not cached)
 * @route   GET /api/episodes/:id/sources
 */
const getEpisodeSources = asyncHandler(async (req, res) => {
  const { refresh } = req.query;
  const sources = await fetchEpisodeSources(req.params.id, refresh === "true");

  res.json({ success: true, data: sources });
});

/**
 * @desc    Trigger a scrape operation
 * @route   POST /api/scrape
 * @body    { query: string, fetchEpisodes?: boolean }
 */
const triggerScrape = asyncHandler(async (req, res) => {
  const { query, fetchEpisodes = false } = req.body;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    const error = new Error("Query is required and must be a non-empty string");
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

/**
 * @desc    Get title suggestions for search
 * @route   GET /api/anime/search/suggest
 * @query   query
 */
const getSuggestions = asyncHandler(async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 2) {
    return res.json({ success: true, data: [] });
  }

  const searchRegex = new RegExp(
    query.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
    "i",
  );

  const suggestions = await Anime.find({
    $or: [{ title: searchRegex }, { altTitles: searchRegex }],
  })
    .select("title coverImage format")
    .sort({ popularity: -1 })
    .limit(6)
    .lean();

  res.json({ success: true, data: suggestions });
});

module.exports = {
  getAll,
  getById,
  getEpisodes,
  getEpisodeSources,
  triggerScrape,
  getSuggestions,
};

/**
 * @desc    Get anime logo
 * @route   GET /api/anime/:id/logo
 */
const getLogo = asyncHandler(async (req, res) => {
  const anime = await Anime.findById(req.params.id);

  if (!anime) {
    return res.status(404).json({ success: false, error: "Anime not found" });
  }

  // Check if we have assets in DB
  const hasLogo = anime.logo && anime.logo.trim() !== "";
  const hasBg = anime.fanartBackground && anime.fanartBackground.trim() !== "";
  
  if (hasLogo || hasBg) {
    return res.json({ 
      success: true, 
      data: anime.logo, 
      background: anime.fanartBackground 
    });
  }

  // Fetch using fanart, passing existing tvdbId if we have it
  const { logoUrl, bgUrl } = await fanart.getFanartAssetsByAnilistId(
    anime.anilistId,
    anime.tvdbId
  );

  let updated = false;

  // Store TVDB ID if we found one but didn't have it
  if (!anime.tvdbId) {
    const tvdbId = await fanart.getTVDBIdFromAniList(anime.anilistId);
    if (tvdbId) {
      anime.tvdbId = tvdbId;
      updated = true;
    }
  }

  if (logoUrl && anime.logo !== logoUrl) {
    anime.logo = logoUrl;
    updated = true;
  }
  if (bgUrl && anime.fanartBackground !== bgUrl) {
    anime.fanartBackground = bgUrl;
    updated = true;
  }

  if (updated) {
    await anime.save();
  }

  if (anime.logo || anime.fanartBackground) {
    return res.json({
      success: true,
      data: anime.logo,
      background: anime.fanartBackground,
    });
  }

  return res.status(404).json({ success: false, error: "Assets not found" });
});

module.exports.getLogo = getLogo;
