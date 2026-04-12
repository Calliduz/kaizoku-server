const axios = require('axios');
const logger = require('./logger');
const env = require('../config/env');

/**
 * Attempts to fetch a high-quality logo (Fanart) for a given anilistId.
 * We use a public aggregator (Anify) which caches TMDB and Fanart.tv maps.
 * 
 * @param {Number|String} anilistId 
 * @returns {Promise<String|null>} The logo URL or null
 */
async function fetchLogo(anilistId) {
    if (!anilistId) return null;
    try {
        const response = await axios.get(`https://anify.anyanime.com/info/${anilistId}`, { timeout: 4000 });
        if (response.data && response.data.artwork) {
            // Fanart / clear logos from Anify
            const logos = response.data.artwork.filter(a => a.type === 'clear_logo' || a.type === 'logo');
            if (logos.length > 0) {
                return logos[0].url;
            }
        }
        return null;
    } catch (error) {
        logger.debug(`[Fanart] Could not fetch logo for anilistId ${anilistId}: ${error.message}`);
        return null;
    }
}

module.exports = {
    fetchLogo
};
