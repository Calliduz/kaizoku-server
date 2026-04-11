const logger = require("../utils/logger");

/**
 * AniList GraphQL API client.
 * Fetches rich metadata (cover images, descriptions, genres, ratings)
 * to enrich scraped anime data.
 *
 * API docs: https://anilist.gitbook.io/anilist-apiv2-docs/
 */

const ANILIST_API = "https://graphql.anilist.co";

// Rate limiting state
let lastRequestTime = 0;
const MIN_DELAY_MS = 670; // ~90 requests per minute
const queryCache = new Map();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          color
        }
        bannerImage
        description(asHtml: false)
        genres
        tags {
          name
          rank
        }
        status
        format
        source
        episodes
        duration
        averageScore
        meanScore
        popularity
        favourites
        season
        seasonYear
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
        nextAiringEpisode {
          episode
          airingAt
        }
        isAdult
        studios(isMain: true) {
          nodes {
            id
            name
            isAnimationStudio
          }
        }
        characters(sort: ROLE, perPage: 10) {
          edges {
            role
            voiceActors(language: JAPANESE, sort: RELEVANCE) {
              id
              name {
                full
                native
              }
              image {
                large
              }
            }
            node {
              id
              name {
                full
                native
              }
              image {
                large
              }
              gender
              age
            }
          }
        }
        trailer {
          id
          site
          thumbnail
        }
        externalLinks {
          url
          site
          type
        }
        recommendations(sort: RATING_DESC, perPage: 5) {
          nodes {
            mediaRecommendation {
              id
              title { romaji english }
              coverImage { large }
              averageScore
            }
          }
        }
        relations {
          edges {
            relationType
            node {
              id
              title { romaji english }
              coverImage { large }
              format
              status
            }
          }
        }
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
async function searchAniList(query, perPage = 10, retries = 3) {
  const cacheKey = `${query}_${perPage}`;
  if (queryCache.has(cacheKey)) {
    return queryCache.get(cacheKey);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Enforce rate limiting
      const now = Date.now();
      const timeSinceLast = now - lastRequestTime;
      if (timeSinceLast < MIN_DELAY_MS) {
        await wait(MIN_DELAY_MS - timeSinceLast);
      }
      lastRequestTime = Date.now();

      const response = await fetch(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          variables: { search: query, page: 1, perPage },
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
          logger.warn(
            `[AniList] Rate limited (429). Retrying in ${delay / 1000}s... (Attempt ${attempt}/${retries})`,
          );
          await wait(delay);
          continue; // Retry
        }
        throw new Error(`AniList API returned ${response.status}`);
      }

      const json = await response.json();
      const media = json?.data?.Page?.media || [];

      logger.debug(`[AniList] Found ${media.length} results for "${query}"`);

      // Cache the result
      queryCache.set(cacheKey, media);
      return media;
    } catch (error) {
      if (attempt === retries) {
        logger.error(
          `[AniList] Search failed after ${retries} attempts: ${error.message}`,
        );
        return [];
      }
      logger.warn(
        `[AniList] Error: ${error.message}. Retrying... (Attempt ${attempt}/${retries})`,
      );
      await wait(1000 * attempt);
    }
  }
}

/**
 * Transform an AniList media object into a normalized metadata shape.
 *
 * @param {object} media - AniList media object
 * @returns {object} Normalized metadata
 */
function normalizeAniListData(media) {
  // Build characters with their voice actors
  const characters = (media.characters?.edges || []).map((edge) => ({
    id: edge.node?.id,
    name: edge.node?.name?.full || "",
    nameNative: edge.node?.name?.native || "",
    image: edge.node?.image?.large || "",
    role: edge.role || "SUPPORTING",
    gender: edge.node?.gender || null,
    age: edge.node?.age || null,
    voiceActors: (edge.voiceActors || []).map((va) => ({
      id: va.id,
      name: va.name?.full || "",
      nameNative: va.name?.native || "",
      image: va.image?.large || "",
    })),
  }));

  // Build studios list
  const studios = (media.studios?.nodes || []).map((s) => ({
    id: s.id,
    name: s.name,
    isAnimationStudio: s.isAnimationStudio || false,
  }));

  // Build trailer info
  const trailer = media.trailer
    ? {
        id: media.trailer.id,
        site: media.trailer.site,
        thumbnail: media.trailer.thumbnail,
        url:
          media.trailer.site === "youtube"
            ? `https://www.youtube.com/watch?v=${media.trailer.id}`
            : media.trailer.site === "dailymotion"
              ? `https://www.dailymotion.com/video/${media.trailer.id}`
              : null,
      }
    : null;

  // Format startDate / endDate
  const formatDate = (d) =>
    d?.year
      ? `${d.year}-${String(d.month || 1).padStart(2, "0")}-${String(d.day || 1).padStart(2, "0")}`
      : null;

  // Recommendations
  const recommendations = (media.recommendations?.nodes || [])
    .filter((n) => n.mediaRecommendation)
    .map((n) => ({
      id: n.mediaRecommendation.id,
      title:
        n.mediaRecommendation.title?.english ||
        n.mediaRecommendation.title?.romaji ||
        "",
      coverImage: n.mediaRecommendation.coverImage?.large || "",
      averageScore: n.mediaRecommendation.averageScore || 0,
    }));

  // Relations (Sequels, Prequels, etc.)
  const relations = (media.relations?.edges || []).map((edge) => ({
    id: edge.node?.id,
    relationType: edge.relationType,
    title: edge.node?.title?.english || edge.node?.title?.romaji || "",
    coverImage: edge.node?.coverImage?.large || "",
    format: edge.node?.format,
    status: edge.node?.status,
  }));

  // Top tags (ranked >= 60%)
  const tags = (media.tags || [])
    .filter((t) => t.rank >= 60)
    .map((t) => t.name);

  return {
    anilistId: media.id,
    title: media.title?.english || media.title?.romaji || "",
    altTitles: [
      media.title?.romaji,
      media.title?.english,
      media.title?.native,
      ...(media.synonyms || []),
    ].filter(Boolean),
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || "",
    coverColor: media.coverImage?.color || null,
    bannerImage: media.bannerImage || "",
    description: (media.description || "").replace(/<[^>]*>/g, ""), // Strip HTML
    genres: media.genres || [],
    tags,
    status: media.status || "UNKNOWN",
    format: media.format || null,
    source: media.source || null,
    totalEpisodes: media.episodes || 0,
    episodeDuration: media.duration || null,
    rating: media.averageScore || 0,
    meanScore: media.meanScore || 0,
    popularity: media.popularity || 0,
    favourites: media.favourites || 0,
    season: media.season || null,
    seasonYear: media.seasonYear || null,
    startDate: formatDate(media.startDate),
    endDate: formatDate(media.endDate),
    nextAiringEpisode: media.nextAiringEpisode
      ? {
          episode: media.nextAiringEpisode.episode,
          airingAt: new Date(
            media.nextAiringEpisode.airingAt * 1000,
          ).toISOString(),
        }
      : null,
    isAdult: media.isAdult || false,
    studios,
    characters,
    trailer,
    externalLinks: (media.externalLinks || []).map((l) => ({
      url: l.url,
      site: l.site,
      type: l.type,
    })),
    recommendations,
    relations,
  };
}

module.exports = { searchAniList, normalizeAniListData };
