const axios = require('axios');
const { load } = require('cheerio');
const logger = require('../../utils/logger');
const GogoCDN = require('../../utils/extractors/gogocdn');
const StreamSB = require('../../utils/extractors/streamsb');

const SOURCE_NAME = 'gogoanime';
const BASE_URL = 'https://gogoanime.by';
const gogoCDN = new GogoCDN();
const streamSB = new StreamSB();

const requestHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Referer': BASE_URL,
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

async function searchAnime(query, page = 1) {
  try {
    // Gogoanime.by search matches root with ?s= query
    const res = await axios.get(
      `${BASE_URL}/?s=${encodeURIComponent(query)}`,
      { headers: requestHeaders }
    );

    const $ = load(res.data);
    const results = [];

    // Search results are often <a> tags with class 'tip'
    $('a.tip').each((i, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();
      const id = href.split('/series/').pop().split('/')[0];
      const image = $(el).find('img').attr('src') || '';

      if (title && id && href.includes('/series/')) {
        results.push({
          sourceId: id,
          title,
          url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
          image: image.startsWith('http') ? image : `https:${image}`,
          audio: title.toLowerCase().includes('dub') ? 'dub' : 'sub',
        });
      }
    });

    return results;
  } catch (err) {
    logger.error(`[${SOURCE_NAME}] Search error: ${err.message}`);
    return [];
  }
}

async function getEpisodes(animeUrlOrId) {
  try {
    let url = animeUrlOrId;
    if (!animeUrlOrId.startsWith('http')) {
      url = `${BASE_URL}/series/${animeUrlOrId}/`;
    }

    const { data } = await axios.get(url, { headers: requestHeaders });
    const $ = load(data);

    const episodes = [];
    $('.episodes a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      const numMatch = text.match(/Episode\s+(\d+(?:\.\d+)?)/i);
      const number = numMatch ? parseFloat(numMatch[1]) : i + 1;

      episodes.push({
        number,
        title: text,
        sourceEpisodeId: href.split('/').filter(Boolean).pop(),
        url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      });
    });

    return episodes.sort((a, b) => a.number - b.number);
  } catch (err) {
    logger.error(`[${SOURCE_NAME}] getEpisodes error: ${err.message}`);
    return [];
  }
}

async function getStreamingSources(episodeUrl) {
  try {
    const { data } = await axios.get(episodeUrl, { headers: requestHeaders });
    const $ = load(data);

    const servers = [];
    $('.anime_muti_link ul li').each((i, el) => {
      let url = $(el).find('a').attr('data-video');
      if (url) {
        if (!url.startsWith('http')) url = `https:${url}`;
        servers.push({
          name: $(el).find('a').text().replace('Choose this server', '').trim(),
          url: url,
        });
      }
    });

    const sources = [];
    for (const server of servers) {
      if (server.name.toLowerCase().includes('vidstreaming') || server.name.toLowerCase().includes('gogo')) {
        const extracted = await gogoCDN.extract(server.url);
        extracted.forEach(s => sources.push({ ...s, server: 'GogoCDN', type: s.isM3U8 ? 'hls' : 'mp4' }));
      } else if (server.name.toLowerCase().includes('streamsb')) {
        const extracted = await streamSB.extract(server.url);
        extracted.forEach(s => sources.push({ ...s, server: 'StreamSB', type: s.isM3U8 ? 'hls' : 'mp4' }));
      }
    }

    return sources;
  } catch (err) {
    logger.error(`[${SOURCE_NAME}] getStreamingSources error: ${err.message}`);
    return [];
  }
}

async function getCatalogAnime(page = 1) {
  try {
    const res = await axios.get(BASE_URL, { headers: requestHeaders });
    const $ = load(res.data);
    const results = [];

    // Latest series usually in a simple list on home
    $('.last_episodes ul.items li').each((i, el) => {
      const a = $(el).find('p.name a');
      const href = a.attr('href') || '';
      const id = href.split('/series/').pop().split('/')[0];
      const title = a.attr('title') || a.text().trim();
      
      if (id) {
          results.push({
            sourceId: id,
            title,
            url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
          });
      }
    });

    return results;
  } catch (err) {
    logger.error(`[${SOURCE_NAME}] getCatalogAnime error: ${err.message}`);
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
};
