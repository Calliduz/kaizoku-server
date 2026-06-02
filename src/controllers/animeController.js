const Anime = require("../models/Anime");
const Episode = require("../models/Episode");
const {
  scrape,
  fetchEpisodeSources,
  linkAndFetchEpisodes,
  enrichAllEpisodesMetadata,
  activeScrapes,
} = require("../scrapers/engine");
const { 
  searchAniList, 
  normalizeAniListData, 
  getTopAnime, 
  getAiringSchedule 
} = require("../scrapers/anilist");
const asyncHandler = require("../middleware/asyncHandler");
const fanart = require("../utils/fanart");
const logger = require("../utils/logger");
const fileCache = require("../utils/fileCache");

// In-memory lock to prevent concurrent enrichment for the same anime
const PendingEnrichments = new Map();

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

  // Auto-enrich metadata in background if missing
  const needsEnrichment = !anime.anilistId || !anime.description || !anime.relations || anime.relations.length === 0;
  if (needsEnrichment && !PendingEnrichments.has(anime._id.toString())) {
    (async () => {
      try {
        PendingEnrichments.set(anime._id.toString(), Date.now());
        const anilistResults = await searchAniList(anime.title, 5);
        if (anilistResults.length > 0) {
          const enrichedData = normalizeAniListData(anilistResults[0]);
          await Anime.findByIdAndUpdate(anime._id, { $set: enrichedData });
          logger.info(`[Controller] Background enriched detail for ${anime.title}`);
        }
      } catch (err) {
        logger.error(`[Controller] Background enrichment failed for ${anime.title}: ${err.message}`);
      } finally {
        PendingEnrichments.delete(anime._id.toString());
      }
    })();
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

  const isScraping = activeScrapes.has(req.params.id);

  if (episodes.length === 0) {
    // If not already in the DB, trigger the lazy-link process
    // This will add to activeScrapes inside linkAndFetchEpisodes
    if (!isScraping) {
      // Start in background but inform the response
      linkAndFetchEpisodes(req.params.id).catch(err => 
        logger.error(`[Controller] linkAndFetchEpisodes failed: ${err.message}`)
      );
      
      return res.json({ 
        success: true, 
        data: [], 
        isScraping: true,
        message: "Episode discovery started in background."
      });
    }

    return res.json({ 
      success: true, 
      data: [], 
      isScraping: true,
      message: "Episode discovery is currently in progress."
    });
  }

  // If episodes exist, return them immediately
  // Also trigger episode metadata sync in background (Netflix-style thumbnails)
  if (!anime.metaEnriched && episodes.length > 0) {
    const animeId = req.params.id;
    if (!PendingEnrichments.has(animeId)) {
      PendingEnrichments.set(animeId, Date.now());
      enrichAllEpisodesMetadata(animeId)
        .catch(err => logger.error(`[Controller] Episode enrichment failed for ${anime.title}: ${err.message}`))
        .finally(() => PendingEnrichments.delete(animeId));
    }
  }

  // Trigger background check for new episodes if not already scraping
  if (!isScraping) {
    linkAndFetchEpisodes(req.params.id).catch(err => 
      logger.error(`[Controller] linkAndFetchEpisodes background update failed: ${err.message}`)
    );
  }

  res.json({ success: true, data: episodes, isScraping });
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

/**
 * @desc    Get top 100 anime from AniList (cached)
 * @route   GET /api/anime/top-100
 */
const getTop100 = asyncHandler(async (req, res) => {
  const cached = await fileCache.get("top-100-anime");
  if (cached) return res.json({ success: true, data: cached });

  const topAnime = await getTopAnime(1, 100);
  const normalized = topAnime.map(anime => ({
    ...normalizeAniListData(anime),
    _id: `anilist:${anime.id}` // Use a virtual ID for external content
  }));
  
  await fileCache.set("top-100-anime", normalized, 86400); // Cache for 24h

  res.json({ success: true, data: normalized });
});

/**
 * @desc    Get airing schedule from AniList (cached)
 * @route   GET /api/anime/airing-schedule
 */
const getSchedule = asyncHandler(async (req, res) => {
  const cached = await fileCache.get("airing-schedule");
  if (cached) return res.json({ success: true, data: cached });

  // Weekly range: today - 1 day to today + 6 days
  const now = Math.floor(Date.now() / 1000);
  const start = now - 86400 * 1;
  const end = now + 86400 * 6;

  const schedule = await getAiringSchedule(start, end);
  await fileCache.set("airing-schedule", schedule, 3600 * 6); // Cache for 6h

  res.json({ success: true, data: schedule });
});

module.exports = {
  getAll,
  getById,
  getEpisodes,
  getEpisodeSources,
  triggerScrape,
  getSuggestions,
  getTop100,
  getSchedule,
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
