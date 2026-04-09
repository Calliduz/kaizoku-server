const mongoose = require('mongoose');

/**
 * Streaming source sub-schema.
 * Each episode can have multiple sources (different servers/qualities).
 */
const streamingSourceSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
    },
    quality: {
      type: String,
      default: 'default',
    },
    server: {
      type: String,
      default: 'unknown',
    },
    type: {
      type: String,
      enum: ['hls', 'mp4', 'webm', 'iframe', 'embed'],
      default: 'hls',
    },
  },
  { _id: false }
);

/**
 * Episode schema — stores per-episode data and streaming sources.
 */
const episodeSchema = new mongoose.Schema(
  {
    animeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Anime',
      required: true,
      index: true,
    },
    number: {
      type: Number,
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    sourceEpisodeId: {
      type: String,
      default: '',
    },
    thumbnail: {
      type: String,
      default: '',
    },
    streamingSources: {
      type: [streamingSourceSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound index: each anime can only have one entry per episode number.
 */
episodeSchema.index({ animeId: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('Episode', episodeSchema);
