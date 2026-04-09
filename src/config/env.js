const dotenv = require('dotenv');

dotenv.config();

/**
 * Centralized environment configuration.
 * All env variables are accessed through this module to ensure
 * defaults and validation happen in a single place.
 */
const env = {
  PORT: parseInt(process.env.PORT, 10) || 5000,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/kaizoku',
  NODE_ENV: process.env.NODE_ENV || 'development',
  TARGET_URL: process.env.TARGET_URL || '',
  SCRAPE_CONCURRENCY: parseInt(process.env.SCRAPE_CONCURRENCY, 10) || 3,

  get isDev() {
    return this.NODE_ENV === 'development';
  },

  get isProd() {
    return this.NODE_ENV === 'production';
  },
};

module.exports = env;
