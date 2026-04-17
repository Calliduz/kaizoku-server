const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

const CACHE_DIR = path.join(__dirname, "../../scratch/cache");

/**
 * Simple file-based cache to persist data across server restarts
 * and avoid slamming external APIs.
 */
class FileCache {
  constructor() {
    this.init();
  }

  async init() {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
      logger.error(`[FileCache] Failed to create cache directory: ${err.message}`);
    }
  }

  async get(key) {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const { value, expiry } = JSON.parse(data);

      if (expiry && Date.now() > expiry) {
        await this.delete(key);
        return null;
      }

      return value;
    } catch (err) {
      return null;
    }
  }

  async set(key, value, ttlSeconds = 86400) { // Default 24h
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    const expiry = Date.now() + ttlSeconds * 1000;
    try {
      await fs.writeFile(filePath, JSON.stringify({ value, expiry }), "utf-8");
    } catch (err) {
      logger.error(`[FileCache] Failed to write cache ${key}: ${err.message}`);
    }
  }

  async delete(key) {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      // Ignore
    }
  }
}

module.exports = new FileCache();
