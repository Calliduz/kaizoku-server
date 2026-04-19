const axios = require('axios');
const { load } = require('cheerio');
const logger = require('../../utils/logger');
const VidCloud = require('../../utils/extractors/vidcloud');

const SOURCE_NAME = 'aniwatch';
const BASE_URL = 'https://aniwatchtv.to';
const AJAX_URL = `${BASE_URL}/ajax/v2`;
const vidcloud = new VidCloud();

const requestHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Referer': BASE_URL,
};

async function searchAnime(query, page = 1) {
  try {
    const { data } = await axios.get(`${BASE_URL}/search?keyword=${encodeURIComponent(query)}&page=${page}`, {
      headers: requestHeaders
    });
    const $ = load(data);
    const results = [];

    $('.film_list-wrap .flw-item').each((_, element) => {
      const $el = $(element);
      const anchor = $el.find('.film-name a').first();
      const title = anchor.text().trim();
      const link = anchor.attr('href') || '';
      const id = link.split('?')[0].replace('/', '').replace('watch/', '');
      const poster = $el.find('.film-poster-img').attr('data-src') || $el.find('.film-poster-img').attr('src');
      
      const sub = parseInt($el.find('.tick-sub').text()) || 0;
      const dub = parseInt($el.find('.tick-dub').text()) || 0;

      if (title && id) {
        results.push({
          sourceId: id,
          title,
          url: `${BASE_URL}${link}`,
          image: poster,
          sub,
          dub,
        });
      }
    });

    return results;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Search error: ${error.message}`);
    return [];
  }
}

async function getEpisodes(animeUrlOrId) {
  try {
    let id = animeUrlOrId;
    if (animeUrlOrId.startsWith('http')) {
      id = animeUrlOrId.split('/').pop().split('?')[0];
    }
    
    const slug = id.startsWith('watch/') ? id.replace('watch/', '') : id;
    const { data: pageData } = await axios.get(`${BASE_URL}/${slug.includes('-') ? slug : 'watch/' + slug}`, {
        headers: requestHeaders
    });
    const $ = load(pageData);
    
    let showId = null;
    try {
        const syncData = $('#syncData').text();
        if (syncData) {
            const parsed = JSON.parse(syncData);
            showId = parsed.ani_id;
        }
    } catch (e) {}

    if (!showId) {
        showId = $('[data-id]').first().attr('data-id') || $('[data-show-id]').first().attr('data-show-id');
    }

    if (!showId) {
        const watchNow = $('.ani-button-main').attr('href');
        if (watchNow) showId = watchNow.split('-').pop();
    }

    if (!showId) throw new Error(`Could not find numeric showId for ${id}`);

    const { data: epData } = await axios.get(`${AJAX_URL}/episode/list/${showId}`, {
      headers: { ...requestHeaders, 'X-Requested-With': 'XMLHttpRequest' }
    });
    const $$ = load(epData.html);

    const episodes = [];
    $$('.ss-list a').each((_, el) => {
      const $el = $$(el);
      const epId = $el.attr('data-id');
      const number = parseInt($el.attr('data-number')) || parseInt($el.text().trim());
      const title = $el.attr('title');

      episodes.push({
        number,
        title: title || `Episode ${number}`,
        sourceEpisodeId: epId,
        url: `${BASE_URL}/watch/${slug}?ep=${epId}`,
      });
    });

    return episodes;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] getEpisodes error: ${error.message}`);
    return [];
  }
}

async function getStreamingSources(episodeUrl) {
  try {
    const epId = episodeUrl.split('ep=').pop();
    
    const { data: serverData } = await axios.get(`${AJAX_URL}/episode/servers?episodeId=${epId}`, {
      headers: { ...requestHeaders, 'X-Requested-With': 'XMLHttpRequest' }
    });
    const $ = load(serverData.html);

    const servers = [];
    $('.server-item').each((_, el) => {
      servers.push({
        id: $(el).attr('data-id'),
        name: $(el).text().trim().toLowerCase(),
        serverId: $(el).attr('data-server-id')
      });
    });

    const sources = [];
    for (const server of servers) {
      if (server.name.includes('megacloud') || server.name.includes('rapidcloud')) {
        try {
          const { data: sourceData } = await axios.get(`${AJAX_URL}/episode/sources?id=${server.id}`, {
              headers: { ...requestHeaders, 'X-Requested-With': 'XMLHttpRequest' }
          });
          if (sourceData.link) {
            const extracted = await vidcloud.extract(sourceData.link);
            if (extracted.sources && extracted.sources.length > 0) {
              extracted.sources.forEach(s => {
                sources.push({
                  url: s.url,
                  quality: 'HD',
                  server: server.name,
                  type: s.isM3U8 ? 'hls' : 'mp4',
                  audio: server.name.includes('dub') ? 'dub' : 'sub',
                  subtitles: extracted.subtitles || []
                });
              });
            }
          }
        } catch (e) {
          logger.warn(`[${SOURCE_NAME}] Failed to extract from ${server.name}: ${e.message}`);
        }
      }
    }

    return sources;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] Source extraction error: ${error.message}`);
    return [];
  }
}

async function getCatalogAnime() {
  try {
    const { data } = await axios.get(`${BASE_URL}/home`, { headers: requestHeaders });
    const $ = load(data);
    const results = [];

    $('#slider .swiper-slide .deslide-item, .trending-list .item').each((_, element) => {
      const $el = $(element);
      const anchor = $el.find('.desi-head-title a, .film-name a').first();
      const title = anchor.text().trim() || $el.find('.desi-head-title').text().trim();
      let link = anchor.attr('href') || $el.find('.desi-buttons a').first().attr('href') || '';
      
      if (!title || !link) return;
      
      const id = link.split('?')[0].split('/').pop();
      const poster = $el.find('.film-poster-img').attr('data-src') || $el.find('.film-poster-img').attr('src');

      results.push({
        sourceId: id,
        title,
        url: `${BASE_URL}${link}`,
        image: poster,
      });
    });

    return results;
  } catch (error) {
    logger.error(`[${SOURCE_NAME}] getCatalogAnime error: ${error.message}`);
    return [];
  }
}

module.exports = {
  name: SOURCE_NAME,
  BASE_URL,
  searchAnime,
  getEpisodes,
  getStreamingSources,
  getCatalogAnime,
  buildEpisodeUrls({ anime, episode }) {
    const baseUrl = `${BASE_URL}/watch/${anime.sourceId}`;
    return [`${baseUrl}?ep=${episode.sourceEpisodeId || ''}`, baseUrl];
  }
};
