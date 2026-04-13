const express = require("express");
const axios = require("axios");
const router = express.Router();
const logger = require("../utils/logger");

/**
 * Helper to rewrite M3U8 content for the proxy
 */
function rewriteM3U8(content, baseUrl, referer) {
  const lines = content.split("\n");
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    // Resolve relative URL to absolute
    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, baseUrl).href;
    } catch (e) {
      return line;
    }

    // Wrap in our proxy
    return `/api/scraper/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
  });

  return rewritten.join("\n");
}

/**
 * @api {get} /scraper/proxy Proxy request to avoid CORS/Referer issues
 */
router.get("/proxy", async (req, res) => {
  const { url, referer } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    // Detect if this is likely an HLS stream from the URL
    let isM3U8 = url.includes(".m3u8");

    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: referer || new URL(url).origin,
      },
      // If m3u8, we need to read the text to rewrite it
      responseType: isM3U8 ? "text" : "stream",
      timeout: 15000,
    });

    // Mirror the content type
    const contentType = response.headers["content-type"] || "";
    // Refine HLS detection based on Content-Type
    isM3U8 = isM3U8 || contentType.includes("mpegurl");
    const isHtml = contentType.includes("text/html");

    res.setHeader("Content-Type", contentType || (isM3U8 ? "application/vnd.apple.mpegurl" : "application/octet-stream"));

    if (isM3U8) {
      const rewritten = rewriteM3U8(response.data, url, referer);
      res.send(rewritten);
    } else if (isHtml) {
      // Inject <base> tag to fix relative links (JS/CSS/Images) on proxied pages
      let html = response.data;
      if (typeof html === "string" && !html.includes("<base ")) {
        const baseTag = `<base href="${new URL(url).origin}/">`;
        html = html.replace("<head>", `<head>${baseTag}`);
      }
      res.send(html);
    } else {
      response.data.pipe(res);
    }
  } catch (error) {
    logger.error(`[Proxy] Failed to proxy ${url}: ${error.message}`);
    res.status(500).json({ error: "Proxy request failed" });
  }
});

module.exports = router;
