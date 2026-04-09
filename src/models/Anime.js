const mongoose = require('mongoose');

/**
 * Anime schema — stores series-level metadata.
 * Enriched with AniList data via the fuzzy matcher.
 */
const animeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      index: true,
    },
    altTitles: {
      type: [String],
      default: [],
    },
    slug: {
      type: String,
      unique: true,
      index: true,
    },
    anilistId: {
      type: Number,
      default: null,
    },
    coverImage: {
      type: String,
      default: '',
    },
    bannerImage: {
      type: String,
      default: '',
    },
    description: {
      type: String,
      default: '',
    },
    genres: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    totalEpisodes: {
      type: Number,
      default: 0,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    sourceId: {
      type: String,
      default: '',
      index: true,
    },
    source: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Generate a URL-friendly slug from the title before saving.
 */
animeSchema.pre('validate', function (next) {
  if (this.title && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

/**
 * Text index for search functionality.
 */
animeSchema.index({ title: 'text', altTitles: 'text', description: 'text' });

module.exports = mongoose.model('Anime', animeSchema);
