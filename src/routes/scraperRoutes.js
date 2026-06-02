const express = require("express");
const axios = require("axios");
const https = require("https");
const router = express.Router();
const logger = require("../utils/logger");

// Create a persistent agent to handle SSL handshake issues on legacy mirrors
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // Bypass self-signed/expired certs on pirate stream mirrors
  keepAlive: true,
});

/**
 * Helper to rewrite M3U8 content for the proxy.
 * Uses RELATIVE URLs (/api/scraper/proxy?...) so hls.js resolves them
 * against the page origin (localhost:5173 via Vite proxy).
 * Absolute URLs would be wrong because Vite's changeOrigin rewrites the
 * Host header to localhost:5000, causing CORP: same-origin blocks.
 */
function rewriteM3U8(content, baseUrl, referer) {
  const lines = content.split("\n");
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
          try {
            const absoluteUrl = new URL(uri, baseUrl).href;
            const t = Date.now();
            const proxiedUrl = `/api/scraper/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&t=${t}`;
            return `URI="${proxiedUrl}"`;
          } catch (e) {
            return match;
          }
        });
      }
      return line;
    }

    // Resolve relative URL to absolute upstream URL
    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, baseUrl).href;
    } catch (e) {
      return line;
    }

    const t = Date.now();
    return `/api/scraper/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&t=${t}`;
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

  // Always enable CORS for the proxy itself
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Referer, Origin, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges");

  if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
  }

  try {
    const targetUrl = new URL(url);
    
    const requestHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "Referer": referer || targetUrl.origin,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity", // Force raw binary to prevent Axios auto-decompression length mismatches
        "Connection": "keep-alive",
        "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    };

    // Forward Range header for video segments
    if (req.headers.range) {
        requestHeaders["Range"] = req.headers.range;
    }

    const response = await axios.get(url, {
      headers: requestHeaders,
      responseType: "stream",
      timeout: 25000,
      httpsAgent,
      maxRedirects: 10,
      validateStatus: (status) => status < 400 || status === 206 // Allow Partial Content
    });

    const contentType = response.headers["content-type"] || "";
    const isM3U8 = url.includes(".m3u8") || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL");
    
    // `url` here is req.query.url (the upstream CDN URL), NOT the full request URL.
    // e.g. "https://vault-12.owocdn.top/.../mon.key" — so .endsWith('.key') is correct.
    const isKeyFile = url.endsWith('.key');

    res.status(response.status);
    
    // Do NOT copy content-length: Axios may auto-decompress gzip from Cloudflare, changing
    // byte length. Browser aborts if received bytes exceed the declared content-length.
    // Express auto-uses Transfer-Encoding: chunked instead — perfect for HLS streaming.
    const headersToCopy = ['content-range', 'accept-ranges', 'content-type'];
    headersToCopy.forEach(h => {
        if (response.headers[h]) res.setHeader(h, response.headers[h]);
    });
    
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Force binary type for .key files — override any upstream content-type
    if (isKeyFile) {
        res.setHeader('Content-Type', 'application/octet-stream');
    }

    if (isM3U8) {
      const chunks = [];
      response.data.on('data', chunk => chunks.push(chunk));
      response.data.on('end', () => {
          const content = Buffer.concat(chunks).toString();
          // Use relative URLs so hls.js resolves against the page origin (5173)
          // and requests flow through Vite proxy (same-origin, no CORP conflicts)
          const rewritten = rewriteM3U8(content, url, referer);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.send(rewritten);
      });
    } else {
      response.data.pipe(res);
    }
  } catch (error) {
    const status = error.response ? error.response.status : 500;
    const errorMsg = error.response?.data?.message || error.message;
    logger.error(`[Proxy] Failed [${status}] for ${url}: ${errorMsg}`);
    if (!res.headersSent) {
      res.status(status).end();
    }
  }
});

module.exports = router;
