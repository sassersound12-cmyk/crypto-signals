/**
 * server.js
 *
 * Crypto Signals backend — Node 24 + Express.
 *
 * Serves the frontend from ./public (static) and exposes the API:
 *   GET  /api/health
 *   GET  /api/prices
 *   GET  /api/candles?symbol=BTC-USD&granularity=3600&limit=200[&end=<unix sec>]
 *   GET  /api/signals?symbol=BTC-USD
 *   GET  /api/patterns?symbol=BTC-USD
 *   GET  /api/news
 *   POST /api/verify   { code }
 *
 * All market data comes from keyless public endpoints (Coinbase Exchange
 * API for prices/candles; CoinDesk + Cointelegraph RSS for news).
 * In-memory caching per endpoint keeps us friendly to upstream rate limits.
 * Upstream failures degrade to last-good cache or clean { error } JSON.
 *
 * No real-money trading, no exchange connectors, no order placement —
 * this service only reads public market data and derives observations.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPrices, getCandles, isSupportedSymbol, SYMBOLS } from "./lib/prices.js";
import { buildSignals } from "./lib/signals.js";
import { detectPatterns } from "./lib/patterns.js";
import { getNews } from "./lib/news.js";
import { verifyCode } from "./lib/codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "10kb" }));

// Frontend (built by a separate agent) is served from ./public when present.
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Tiny in-memory caches for expensive derived endpoints (5 min)
// ---------------------------------------------------------------------------
const derivedCache = new Map(); // key -> { data, at }
const DERIVED_TTL = 5 * 60_000;

function cacheGet(key) {
  const entry = derivedCache.get(key);
  if (entry && Date.now() - entry.at < DERIVED_TTL) return entry.data;
  derivedCache.delete(key);
  return null;
}
function cacheSet(key, data) {
  derivedCache.set(key, { data, at: Date.now() });
  // Keep the map bounded.
  if (derivedCache.size > 100) {
    const oldest = derivedCache.keys().next().value;
    derivedCache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Light rate limit for POST /api/verify: 30 req/min per IP (in-memory)
// ---------------------------------------------------------------------------
const verifyHits = new Map(); // ip -> [ timestamps ]
const VERIFY_LIMIT = 30;
const VERIFY_WINDOW = 60_000;

setInterval(() => {
  const cutoff = Date.now() - VERIFY_WINDOW;
  for (const [ip, times] of verifyHits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length) verifyHits.set(ip, fresh);
    else verifyHits.delete(ip);
  }
}, VERIFY_WINDOW).unref();

function verifyRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const times = (verifyHits.get(ip) || []).filter((t) => now - t < VERIFY_WINDOW);
  if (times.length >= VERIFY_LIMIT) {
    return res.status(429).json({ error: "Too many attempts — try again in a minute." });
  }
  times.push(now);
  verifyHits.set(ip, times);
  next();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const GRANULARITIES = new Set([60, 300, 900, 3600, 21600, 86400]);

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}
function upstreamError(res, err) {
  console.error("[api]", err?.message || err);
  return res.status(502).json({ error: "Upstream data temporarily unavailable." });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/prices", async (req, res) => {
  try {
    res.json(await getPrices());
  } catch (err) {
    upstreamError(res, err);
  }
});

app.get("/api/candles", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC-USD");
  const granularity = Number(req.query.granularity ?? 3600);
  const limit = Number(req.query.limit ?? 200);
  const end = req.query.end !== undefined ? Number(req.query.end) : null;

  if (!isSupportedSymbol(symbol)) {
    return badRequest(res, `Unsupported symbol "${symbol}". Use one of: ${SYMBOLS.join(", ")}`);
  }
  if (!GRANULARITIES.has(granularity)) {
    return badRequest(
      res,
      `Unsupported granularity "${req.query.granularity}". Use one of: ${[...GRANULARITIES].join(", ")}`
    );
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    return badRequest(res, `limit must be between 1 and 1000.`);
  }
  if (end !== null && (!Number.isFinite(end) || end <= 0)) {
    return badRequest(res, `end must be a unix-seconds timestamp.`);
  }

  try {
    res.json(await getCandles(symbol, granularity, Math.floor(limit), end));
  } catch (err) {
    upstreamError(res, err);
  }
});

app.get("/api/signals", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC-USD");
  if (!isSupportedSymbol(symbol)) {
    return badRequest(res, `Unsupported symbol "${symbol}". Use one of: ${SYMBOLS.join(", ")}`);
  }

  const cached = cacheGet(`signals:${symbol}`);
  if (cached) return res.json(cached);

  try {
    const [priceData, candleData, newsData] = await Promise.all([
      getPrices(),
      getCandles(symbol, 3600, 220),
      getNews(),
    ]);
    const info = priceData.prices[symbol];
    if (!info) throw new Error(`No price data for ${symbol}`);

    const payload = buildSignals({
      symbol,
      price: info.price,
      change24hPct: info.change24hPct,
      candles: candleData.candles,
      granularity: 3600,
      patterns: detectPatterns(candleData.candles),
      newsItems: newsData.items,
      allPrices: priceData.prices,
    });
    cacheSet(`signals:${symbol}`, payload);
    res.json(payload);
  } catch (err) {
    upstreamError(res, err);
  }
});

app.get("/api/patterns", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC-USD");
  const granularity = Number(req.query.granularity ?? 3600);
  if (!isSupportedSymbol(symbol)) {
    return badRequest(res, `Unsupported symbol "${symbol}". Use one of: ${SYMBOLS.join(", ")}`);
  }
  if (!GRANULARITIES.has(granularity)) {
    return badRequest(
      res,
      `Unsupported granularity "${req.query.granularity}". Use one of: ${[...GRANULARITIES].join(", ")}`
    );
  }

  const cached = cacheGet(`patterns:${symbol}:${granularity}`);
  if (cached) return res.json(cached);

  try {
    const candleData = await getCandles(symbol, granularity, 200);
    const patterns = detectPatterns(candleData.candles);
    const payload = {
      symbol,
      patterns,
      note: patterns.length
        ? `${patterns.length} pattern${patterns.length === 1 ? "" : "s"} detected in recent price action. Patterns describe past structure, not future results.`
        : "No pattern detected in recent price action.",
    };
    cacheSet(`patterns:${symbol}:${granularity}`, payload);
    res.json(payload);
  } catch (err) {
    upstreamError(res, err);
  }
});

app.get("/api/news", async (req, res) => {
  try {
    res.json(await getNews());
  } catch (err) {
    upstreamError(res, err);
  }
});

app.post("/api/verify", verifyRateLimit, (req, res) => {
  const code = req.body?.code;
  if (typeof code !== "string" || !code.trim()) {
    return badRequest(res, "Request body must be JSON with a non-empty `code` string.");
  }
  res.json({ valid: verifyCode(code) });
});

// Unknown /api routes -> JSON 404 (keeps the frontend's fetch() happy).
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Unknown API endpoint." });
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[crypto-signals] listening on port ${PORT}`);
});
