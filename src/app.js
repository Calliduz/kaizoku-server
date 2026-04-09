const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const animeRoutes = require('./routes/animeRoutes');
const errorHandler = require('./middleware/errorHandler');
const env = require('./config/env');

/**
 * Express application factory.
 * Mounts all middleware and routes, returns the configured app.
 */
function createApp() {
  const app = express();

  // ── Security ──────────────────────────────────────────
  app.use(helmet());
  app.use(
    cors({
      origin: env.isDev ? '*' : process.env.CLIENT_URL,
      methods: ['GET', 'POST'],
    })
  );

  // ── Rate limiting ─────────────────────────────────────
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { message: 'Too many requests, please try again later' } },
  });
  app.use('/api/', limiter);

  // ── Parsing & logging ─────────────────────────────────
  app.use(express.json({ limit: '10kb' }));
  app.use(morgan(env.isDev ? 'dev' : 'combined'));

  // ── Health check ──────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, message: 'Kaizoku API is running', timestamp: new Date() });
  });

  // ── API routes ────────────────────────────────────────
  app.use('/api', animeRoutes);

  // ── 404 handler ───────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { message: 'Route not found' } });
  });

  // ── Error handler (must be last) ─────────────────────
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
