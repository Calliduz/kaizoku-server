const createApp = require("./src/app");
const connectDB = require("./src/config/db");
const env = require("./src/config/env");
const logger = require("./src/utils/logger");
const puppeteerPool = require("./src/utils/puppeteerPool");
const scheduler = require("./src/utils/scheduler");

/**
 * Server entry point.
 * 1. Connects to MongoDB
 * 2. Creates the Express app
 * 3. Starts listening
 */
async function start() {
  // Connect to database
  await connectDB();

  // Create and start the Express app
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(
      `Kaizoku API running on http://localhost:${env.PORT} [${env.NODE_ENV}]`,
    );

    // Start background catalog sync (every 120 mins) if enabled
    if (env.ENABLE_SCHEDULER) {
      scheduler.startCatalogSync(120);
    } else {
      logger.info(
        "[Scheduler] Background catalog sync is disabled (ENABLE_SCHEDULER=false)",
      );
    }
  });

  // ── Graceful shutdown ──────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      await puppeteerPool.shutdown();
      scheduler.stopCatalogSync();
      logger.info("Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  logger.error(`Failed to start server: ${error.message}`);
  process.exit(1);
});
