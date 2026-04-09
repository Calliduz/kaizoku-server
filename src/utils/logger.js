/**
 * Simple structured logger with timestamps and levels.
 * Replace with winston/pino in production if needed.
 */
const logger = {
  _format(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  },

  info(message) {
    console.log(this._format('info', message));
  },

  warn(message) {
    console.warn(this._format('warn', message));
  },

  error(message) {
    console.error(this._format('error', message));
  },

  debug(message) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(this._format('debug', message));
    }
  },
};

module.exports = logger;
