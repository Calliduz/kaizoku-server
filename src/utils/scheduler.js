const { scrapeCatalog } = require("../scrapers/engine");
const logger = require("./logger");

/**
 * Background Scheduler
 *
 * Periodically syncs the latest releases from sources to keep the database fresh.
 */
let syncInterval = null;

/**
 * Start the background catalog synchronization.
 *
 * @param {number} intervalMinutes - Frequency of the sync in minutes
 */
function startCatalogSync(intervalMinutes = 120) {
  if (syncInterval) {
    logger.warn(
      "[Scheduler] Sync already running. Stopping previous instance.",
    );
    clearInterval(syncInterval);
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info(
    `[Scheduler] Starting background catalog sync every ${intervalMinutes} minutes.`,
  );

  // Define the sync task
  const runSync = async () => {
    try {
      logger.info("[Scheduler] Triggering periodic catalog sync...");

      // We limit to 2 pages to keep memory usage low on Render Free tier.
      // fetchEpisodes: true ensures new episode entries are created for the latest updates.
      const results = await scrapeCatalog({
        maxPages: 2,
        fetchEpisodes: true,
      });

      logger.info(
        `[Scheduler] Sync complete. Processed ${results.length} titles.`,
      );
    } catch (error) {
      logger.error(`[Scheduler] Periodic sync failed: ${error.message}`);
    }
  };

  // Run immediately on start
  runSync();

  // Schedule repetitions
  syncInterval = setInterval(runSync, intervalMs);
}

/**
 * Stop the background catalog synchronization.
 */
function stopCatalogSync() {
  if (syncInterval) {
    logger.info("[Scheduler] Stopping background catalog sync.");
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = { startCatalogSync, stopCatalogSync };
