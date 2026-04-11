const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const animeRoutes = require("./routes/animeRoutes");
const scraperRoutes = require("./routes/scraperRoutes");
const errorHandler = require("./middleware/errorHandler");
const env = require("./config/env");

/**
 * Express application factory.
 * Mounts all middleware and routes, returns the configured app.
 */
function createApp() {
  const app = express();

  // Trust proxy for rate limiting (essential for Render/Vercel/Nginx)
  app.set("trust proxy", 1);

  // ── Security ──────────────────────────────────────────
  app.use(helmet());
  app.use(
    cors({
      origin: env.isDev ? "*" : process.env.CLIENT_URL,
      methods: ["GET", "POST"],
    }),
  );

  // ── Health check (No Rate Limit) ──────────────────────
  app.get("/health", (_req, res) => {
    res.json({
      status: "UP",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    });
  });

  // ── Rate limiting ─────────────────────────────────────
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { message: "Too many requests, please try again later" },
    },
  });
  app.use("/api/", limiter);

  // ── Parsing & logging ─────────────────────────────────
  app.use(express.json({ limit: "10kb" }));
  app.use(
    morgan(env.isDev ? "dev" : "combined", {
      skip: function (req, res) {
        return req.originalUrl.includes("/proxy");
      }, // Hide noisy scraper logs
    }),
  );

  // ── API routes ────────────────────────────────────────
  app.use("/api", animeRoutes);
  app.use("/api/scraper", scraperRoutes);

  // ── 404 handler ───────────────────────────────────────
  app.use((_req, res) => {
    res
      .status(404)
      .json({ success: false, error: { message: "Route not found" } });
  });

  // ── Error handler (must be last) ─────────────────────
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
