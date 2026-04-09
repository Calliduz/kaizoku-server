const fuzzball = require('fuzzball');
const logger = require('../utils/logger');

/**
 * Fuzzy title matcher using fuzzball.
 * Bridges the gap between scraped titles and AniList canonical titles.
 *
 * For example: "Shingeki no Kyojin" (scraper) ↔ "Attack on Titan" (AniList)
 * By comparing against altTitles/synonyms, the matcher finds the best fit.
 */

const DEFAULT_THRESHOLD = 70; // Minimum similarity score (0-100)

/**
 * Find the best matching AniList result for a scraped title.
 *
 * @param {string} scrapedTitle - The title extracted from the source site
 * @param {Array} anilistResults - Array of AniList media objects
 * @param {number} [threshold] - Minimum similarity score
 * @returns {{ match: object | null, score: number }}
 */
function findBestMatch(scrapedTitle, anilistResults, threshold = DEFAULT_THRESHOLD) {
  if (!scrapedTitle || !anilistResults?.length) {
    return { match: null, score: 0 };
  }

  let bestMatch = null;
  let bestScore = 0;

  for (const result of anilistResults) {
    // Build a list of all possible title variations
    const candidates = [
      result.title?.romaji,
      result.title?.english,
      result.title?.native,
      ...(result.synonyms || []),
    ].filter(Boolean);

    for (const candidate of candidates) {
      // Use both full ratio and partial ratio, take the higher
      const fullScore = fuzzball.ratio(scrapedTitle.toLowerCase(), candidate.toLowerCase());
      const partialScore = fuzzball.partial_ratio(scrapedTitle.toLowerCase(), candidate.toLowerCase());
      const score = Math.max(fullScore, partialScore);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }
  }

  if (bestScore < threshold) {
    logger.debug(
      `[Matcher] No match above threshold (${threshold}) for "${scrapedTitle}". Best: ${bestScore}`
    );
    return { match: null, score: bestScore };
  }

  const matchTitle = bestMatch.title?.english || bestMatch.title?.romaji || 'unknown';
  logger.info(`[Matcher] Matched "${scrapedTitle}" → "${matchTitle}" (score: ${bestScore})`);

  return { match: bestMatch, score: bestScore };
}

module.exports = { findBestMatch, DEFAULT_THRESHOLD };
