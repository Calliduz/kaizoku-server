const axios = require("axios");

let animeDatabaseCache = null;
let databaseLastFetched = 0;
const DATABASE_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getTVDBIdFromAniList(anilistId) {
  try {
    const now = Date.now();
    if (!animeDatabaseCache || now - databaseLastFetched > DATABASE_CACHE_TTL) {
      try {
        const response = await axios.get(
          "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json",
          { timeout: 15000 },
        );
        if (response.data && Array.isArray(response.data)) {
          animeDatabaseCache = response.data;
          databaseLastFetched = now;
        }
      } catch (err) {
        console.error("Failed fetching Fribb data:", err.message);
      }
    }

    if (animeDatabaseCache) {
      const entry = animeDatabaseCache.find(
        (item) => item.anilist_id === Number(anilistId),
      );
      if (entry && entry.tvdb_id) return entry.tvdb_id;
    }

    const query =
      "query { Media(id: " + anilistId + ", type: ANIME) { idMal } }";
    const res = await axios.post("https://graphql.anilist.co", {
      query: query,
    });
    const malId = res.data.data.Media.idMal;
    if (!malId) return null;

    const malRes = await axios.get(
      "https://api.malsync.moe/mal/anime/" + malId,
    );
    if (malRes.data && malRes.data.Sites && malRes.data.Sites.TheTVDB) {
      return Object.keys(malRes.data.Sites.TheTVDB)[0];
    }
  } catch (e) {}
  return null;
}

async function fetchLogoFromFanartTV(tvdbId) {
  try {
    const apiKey =
      process.env.FANART_API_KEY || "c90b63afbbff5f88fcde43fc784e1b87";
    const res = await axios.get(
      "https://webservice.fanart.tv/v3/tv/" + tvdbId + "?api_key=" + apiKey,
    );

    // Prefer English logos
    const enHdtv = res.data.hdtvlogo?.find(
      (l) => l.lang === "en" || l.lang === "00" || l.lang === "",
    );
    const enClear = res.data.clearart?.find(
      (l) => l.lang === "en" || l.lang === "00" || l.lang === "",
    );
    const firstHdtv = res.data.hdtvlogo?.[0];
    const firstClear = res.data.clearart?.[0];

    const selectedLogo = enHdtv || firstHdtv || enClear || firstClear;
    const logoUrl = selectedLogo ? selectedLogo.url : null;

    const tvthumbs = res.data.tvthumb || [];
    const backgrounds = res.data.showbackground || [];
    const enBg = backgrounds.find(
      (b) => b.lang === "en" || b.lang === "00" || b.lang === "",
    );
    const firstBg = backgrounds[0];

    const selectedBg = enBg || firstBg;
    const bgUrl = selectedBg ? selectedBg.url : null;

    return { logoUrl, bgUrl };
  } catch (e) {}
  return { logoUrl: null, bgUrl: null };
}

async function getFanartAssetsByAnilistId(anilistId) {
  const tvdbId = await getTVDBIdFromAniList(anilistId);
  if (tvdbId) return await fetchLogoFromFanartTV(tvdbId);
  return { logoUrl: null, bgUrl: null };
}

async function getLogoByAnilistId(anilistId) {
  const { logoUrl } = await getFanartAssetsByAnilistId(anilistId);
  return logoUrl;
}

async function getBackgroundByAnilistId(anilistId) {
  const { bgUrl } = await getFanartAssetsByAnilistId(anilistId);
  return bgUrl;
}

module.exports = {
  getLogoByAnilistId,
  getBackgroundByAnilistId,
  getFanartAssetsByAnilistId,
  getTVDBIdFromAniList,
  fetchLogoFromFanartTV,
};
