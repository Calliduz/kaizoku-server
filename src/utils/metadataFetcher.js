const { META } = require("@consumet/extensions");
const logger = require("./logger");

/**
 * Metadata Fetcher Utility
 * Uses Consumet Meta providers to enrich local anime/episode data 
 * with descriptions, high-res thumbnails, and seasonal info.
 */

// Initialize Consumet Anilist Meta Provider
const anilist = new META.Anilist();

/**
 * Fetch detailed metadata for all episodes of an anime.
 * @param {string|number} anilistId - The AniList ID of the series
 * @returns {Promise<Array>} List of episode metadata
 */
async function fetchEpisodeMetadata(anilistId) {
  if (!anilistId) return [];

  try {
    logger.info(`[Metadata] Fetching enriched episode data for AniList ID: ${anilistId}`);
    
    // fetchAnimeInfo gets data from AniList + TMDb/TVDB cross-reference
    const info = await anilist.fetchAnimeInfo(anilistId);
    
    if (!info || !info.episodes) {
      return [];
    }

    return (info.episodes || []).map(ep => ({
      number: ep.number,
      title: ep.title || `Episode ${ep.number}`,
      description: "", // SKIP synopses to improve stability and performance
      thumbnail: ep.image || ep.thumbnail || "",
      seasonNumber: info.seasonNumber || null
    }));
  } catch (error) {
    if (error.message.includes("Unexpected end of JSON input")) {
      logger.error(`[Metadata] Provider balance error (AniList/TMDb) for ID ${anilistId}: ${error.message}`);
    } else {
      logger.error(`[Metadata] Failed to fetch enriched metadata: ${error.message}`);
    }
    return [];
  }
}

module.exports = { fetchEpisodeMetadata };
