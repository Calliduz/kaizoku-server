const logger = require('../utils/logger');

/**
 * AniList GraphQL API client.
 * Fetches rich metadata (cover images, descriptions, genres, ratings)
 * to enrich scraped anime data.
 *
 * API docs: https://anilist.gitbook.io/anilist-apiv2-docs/
 */

const ANILIST_API = 'https://graphql.anilist.co';

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        title {
          romaji
          english
          native
        }
        synonyms
        coverImage {
          extraLarge
          large
        }
        bannerImage
        description(asHtml: false)
        genres
        status
        episodes
        averageScore
        season
        seasonYear
      }
    }
  }
`;

/**
 * Search AniList for anime metadata.
 *
 * @param {string} query - Search string
 * @param {number} [perPage=10] - Results per page
 * @returns {Promise<Array>} Array of AniList media objects
 */
async function searchAniList(query, perPage = 10) {
  try {
    const response = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { search: query, page: 1, perPage },
      }),
    });

    if (!response.ok) {
      throw new Error(`AniList API returned ${response.status}`);
    }

    const json = await response.json();
    const media = json?.data?.Page?.media || [];

    logger.debug(`[AniList] Found ${media.length} results for "${query}"`);
    return media;
  } catch (error) {
    logger.error(`[AniList] Search failed: ${error.message}`);
    return [];
  }
}

/**
 * Transform an AniList media object into a normalized metadata shape.
 *
 * @param {object} media - AniList media object
 * @returns {object} Normalized metadata
 */
function normalizeAniListData(media) {
  return {
    anilistId: media.id,
    title: media.title?.english || media.title?.romaji || '',
    altTitles: [
      media.title?.romaji,
      media.title?.english,
      media.title?.native,
      ...(media.synonyms || []),
    ].filter(Boolean),
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || '',
    bannerImage: media.bannerImage || '',
    description: (media.description || '').replace(/<[^>]*>/g, ''), // Strip HTML
    genres: media.genres || [],
    status: media.status || 'UNKNOWN',
    totalEpisodes: media.episodes || 0,
    rating: media.averageScore || 0,
  };
}

module.exports = { searchAniList, normalizeAniListData };
