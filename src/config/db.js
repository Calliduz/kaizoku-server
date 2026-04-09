const mongoose = require('mongoose');
const logger = require('../utils/logger');
const env = require('./env');

/**
 * Connect to MongoDB with retry logic.
 * Retries up to 5 times with a 5-second delay between attempts.
 */
const connectDB = async () => {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const conn = await mongoose.connect(env.MONGODB_URI, {
        // Mongoose 8 uses the new driver defaults; no need for deprecated options
      });

      logger.info(`MongoDB connected: ${conn.connection.host}`);
      return conn;
    } catch (error) {
      logger.error(`MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);

      if (attempt === MAX_RETRIES) {
        logger.error('All MongoDB connection attempts exhausted. Exiting.');
        process.exit(1);
      }

      logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
};

module.exports = connectDB;
