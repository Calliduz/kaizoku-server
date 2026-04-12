const mongoose = require("mongoose");

/**
 * Anime schema — stores series-level metadata.
 * Enriched with AniList data via the fuzzy matcher.
 */

const voiceActorSchema = new mongoose.Schema(
  {
    id: Number,
    name: { type: String, default: "" },
    nameNative: { type: String, default: "" },
    image: { type: String, default: "" },
  },
  { _id: false },
);

const characterSchema = new mongoose.Schema(
  {
    id: Number,
    name: { type: String, default: "" },
    nameNative: { type: String, default: "" },
    image: { type: String, default: "" },
    role: { type: String, default: "SUPPORTING" }, // MAIN | SUPPORTING | BACKGROUND
    gender: { type: String, default: null },
    age: { type: String, default: null },
    voiceActors: { type: [voiceActorSchema], default: [] },
  },
  { _id: false },
);

const studioSchema = new mongoose.Schema(
  {
    id: Number,
    name: { type: String, default: "" },
    isAnimationStudio: { type: Boolean, default: false },
  },
  { _id: false },
);

const trailerSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    site: { type: String, default: "" }, // 'youtube' | 'dailymotion'
    thumbnail: { type: String, default: "" },
    url: { type: String, default: null },
  },
  { _id: false },
);

const externalLinkSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    site: { type: String, default: "" },
    type: { type: String, default: "" },
  },
  { _id: false },
);

const recommendationSchema = new mongoose.Schema(
  {
    id: Number,
    title: { type: String, default: "" },
    coverImage: { type: String, default: "" },
    averageScore: { type: Number, default: 0 },
  },
  { _id: false },
);

const relationSchema = new mongoose.Schema(
  {
    id: Number,
    relationType: String, // SEQUEL | PREQUEL | SIDE_STORY | etc.
    title: { type: String, default: "" },
    coverImage: { type: String, default: "" },
    status: String,
    format: String,
  },
  { _id: false },
);

const animeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
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
      default: "",
    },
    coverColor: {
      type: String,
      default: null,
    },
    bannerImage: {
      type: String,
      default: "",
    },
    logo: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    genres: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: [
        "RELEASING",
        "FINISHED",
        "NOT_YET_RELEASED",
        "CANCELLED",
        "HIATUS",
        "UNKNOWN",
      ],
      default: "UNKNOWN",
    },
    format: {
      type: String,
      default: null, // TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA | MUSIC
    },
    source: {
      type: String,
      default: null, // ORIGINAL | MANGA | LIGHT_NOVEL | VISUAL_NOVEL | VIDEO_GAME | etc.
    },
    totalEpisodes: {
      type: Number,
      default: 0,
    },
    episodeDuration: {
      type: Number, // in minutes
      default: null,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    meanScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    popularity: {
      type: Number,
      default: 0,
    },
    favourites: {
      type: Number,
      default: 0,
    },
    season: {
      type: String,
      default: null, // WINTER | SPRING | SUMMER | FALL
    },
    seasonYear: {
      type: Number,
      default: null,
    },
    startDate: {
      type: String,
      default: null,
    },
    endDate: {
      type: String,
      default: null,
    },
    nextAiringEpisode: {
      episode: { type: Number, default: null },
      airingAt: { type: String, default: null },
      _id: false,
    },
    isAdult: {
      type: Boolean,
      default: false,
    },
    studios: {
      type: [studioSchema],
      default: [],
    },
    characters: {
      type: [characterSchema],
      default: [],
    },
    trailer: {
      type: trailerSchema,
      default: null,
    },
    externalLinks: {
      type: [externalLinkSchema],
      default: [],
    },
    recommendations: {
      type: [recommendationSchema],
      default: [],
    },
    relations: {
      type: [relationSchema],
      default: [],
    },
    // Source scrape metadata
    sourceId: {
      type: String,
      default: "",
      index: true,
    },
    scrapeSource: {
      type: String,
      default: "",
    },
    catalogUpdatedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Generate a URL-friendly slug from the title before saving.
 */
animeSchema.pre("validate", function (next) {
  if (this.title && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }
  next();
});

/**
 * Text index for search functionality.
 */
animeSchema.index({ title: "text", altTitles: "text", description: "text" });

module.exports = mongoose.model("Anime", animeSchema);
