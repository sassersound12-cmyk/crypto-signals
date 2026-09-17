/**
 * lib/prices.js
 *
 * Keyless market-data helpers backed by the Coinbase Exchange public API.
 *
 *   https://api.exchange.coinbase.com/products/{id}/ticker
 *   https://api.exchange.coinbase.com/products/{id}/stats   (24h)
 *   https://api.exchange.coinbase.com/products/{id}/candles?granularity=...
 *
 * Node 24 native fetch is used (no node-fetch). A User-Agent header is set
 * per Coinbase's guidance. Responses are cached in memory:
 *   - prices: 30s
 *   - candles: 60s
 * On upstream failure we fall back to the last-good cache; when there is no
 * cache we throw a clean Error the route handler turns into { error } JSON.
 */

const UA = { "User-Agent": "crypto-signals/1.0 (+keyless public data)" };

/** Symbols the app tracks. */
export const SYMBOLS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "DOGE-USD",
  "ADA-USD",
  "LINK-USD",
];

const GRANULARITIES = new Set([60, 300, 900, 3600, 21600, 86400]);

// ---- in-memory caches -------------------------------------------------------
const priceCache = { data: null, at: 0 }; // 30s
const candleCache = new Map(); // key: `${symbol}:${granularity}` -> { data, at } (60s)
const PRICE_TTL = 30_000;
const CANDLE_TTL = 60_000;

async function fetchJson(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Latest prices + 24h change for all tracked symbols.
 * Returns { prices: { "BTC-USD": { price, change24hPct } }, updatedAt }.
 */
export async function getPrices() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.at < PRICE_TTL) return priceCache.data;

  const results = await Promise.allSettled(
    SYMBOLS.map(async (symbol) => {
      const [ticker, stats] = await Promise.all([
        fetchJson(`https://api.exchange.coinbase.com/products/${symbol}/ticker`),
        fetchJson(`https://api.exchange.coinbase.com/products/${symbol}/stats`),
      ]);
      const price = Number(ticker.price);
      const open24h = Number(stats.open);
      const change24hPct =
        Number.isFinite(price) && Number.isFinite(open24h) && open24h > 0
          ? ((price - open24h) / open24h) * 100
          : 0;
      return { symbol, price, change24hPct };
    })
  );

  const prices = {};
  let anyOk = false;
  for (const r of results) {
    if (r.status === "fulfilled" && Number.isFinite(r.value.price)) {
      prices[r.value.symbol] = {
        price: r.value.price,
        change24hPct: r.value.change24hPct,
      };
      anyOk = true;
    }
  }

  if (!anyOk) {
    if (priceCache.data) return priceCache.data; // last-good fallback
    throw new Error("Coinbase price feed unavailable");
  }

  const data = { prices, updatedAt: new Date().toISOString() };
  priceCache.data = data;
  priceCache.at = now;
  return data;
}

/**
 * Closed candles only, sorted ascending by time.
 * Coinbase returns up to 300 candles per call, newest first; the final
 * (most recent) candle is usually still forming, so we always drop any
 * candle whose close time is in the future / not yet elapsed.
 *
 * Coinbase candle: [ time, low, high, open, close, volume ]
 * (time = bucket open in unix seconds; close time = time + granularity)
 */
export async function getCandles(symbol, granularity, limit = 200, endBefore = null) {
  const g = Number(granularity);
  if (!SYMBOLS.includes(symbol)) throw new Error(`Unsupported symbol ${symbol}`);
  if (!GRANULARITIES.has(g)) throw new Error(`Unsupported granularity ${granularity}`);
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  // Optional cursor: fetch candles at-or-before this unix-seconds timestamp.
  // Lets the frontend stitch sequential chunks for multi-year history.
  const endCursor = Number(endBefore);
  const hasCursor = Number.isFinite(endCursor) && endCursor > 0;

  const key = hasCursor ? `${symbol}:${g}:end${endCursor}` : `${symbol}:${g}`;
  const now = Date.now();
  const cached = candleCache.get(key);
  if (
    cached &&
    now - cached.at < CANDLE_TTL &&
    cached.data.candles.length >= limit
  ) {
    return { ...cached.data, candles: cached.data.candles.slice(-limit) };
  }

  // Stitch multiple calls for longer history. Coinbase takes optional
  // start/end (ISO 8601) to page older data; we walk backwards from
  // `endCursor` when given, otherwise from "now".
  const want = limit + 10; // over-fetch a little to cover the dropped forming candle
  const pages = Math.ceil(want / 300);
  const all = [];
  let end = hasCursor ? new Date(endCursor * 1000) : null;

  for (let p = 0; p < pages; p++) {
    const params = new URLSearchParams({ granularity: String(g) });
    if (end) {
      params.set("end", end.toISOString());
    }
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?${params}`;
    let rows;
    try {
      rows = await fetchJson(url);
    } catch (err) {
      if (all.length === 0 && cached) return cached.data; // last-good fallback
      if (all.length === 0) throw new Error("Coinbase candle feed unavailable");
      break; // partial history is better than nothing
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const [t, low, high, open, close, volume] of rows) {
      all.push({
        time: t,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
      });
    }
    if (rows.length < 300) break; // no more history
    end = new Date(all[all.length - 1].time * 1000); // oldest candle -> page further back
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const closed = all
    .filter((c) => c.time + g <= nowSec) // drop the still-forming candle
    .sort((a, b) => a.time - b.time);

  // Dedupe overlapping page boundaries.
  const seen = new Set();
  const deduped = closed.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  const data = { symbol, granularity: g, candles: deduped };
  candleCache.set(key, { data, at: now });
  return { ...data, candles: deduped.slice(-limit) }; // most recent `limit` candles
}

/** True if a symbol is one we track (used by route validation). */
export function isSupportedSymbol(symbol) {
  return SYMBOLS.includes(symbol);
}
