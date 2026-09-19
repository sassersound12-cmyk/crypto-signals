/**
 * lib/prices.js
 *
 * Keyless market-data helpers. Most symbols come from the Coinbase Exchange
 * public API:
 *
 *   https://api.exchange.coinbase.com/products/{id}/ticker
 *   https://api.exchange.coinbase.com/products/{id}/stats   (24h)
 *   https://api.exchange.coinbase.com/products/{id}/candles?granularity=...
 *
 * Symbols not listed on Coinbase (see KRAKEN_SYMBOLS) come from the Kraken
 * public API instead (no key required):
 *
 *   https://api.kraken.com/0/public/Ticker?pair=...
 *   https://api.kraken.com/0/public/OHLC?pair=...&interval=...
 *
 * Node 24 native fetch is used (no node-fetch). A User-Agent header is set
 * per upstream guidance. Responses are cached in memory:
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
  "FLR-USD",
  "XLM-USD",
  "HBAR-USD",
  "SHX-USD",
];

/** Symbols served by Kraken instead of Coinbase: app symbol -> Kraken pair. */
const KRAKEN_SYMBOLS = {
  "SHX-USD": "SHXUSD",
};

/** Kraken OHLC interval minutes for each supported granularity (seconds). */
const KRAKEN_INTERVALS = { 60: 1, 300: 5, 900: 15, 3600: 60, 21600: 240, 86400: 1440 };

const GRANULARITIES = new Set([60, 300, 900, 3600, 21600, 86400]);

// ---- in-memory caches -------------------------------------------------------
const priceCache = { data: null, at: 0 }; // 30s
const candleCache = new Map(); // key: `${symbol}:${granularity}` -> { data, at } (60s)
const PRICE_TTL = 30_000;
const CANDLE_TTL = 60_000;

async function fetchJson(url, timeoutMs = 12_000, source = "Coinbase") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${source} ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** First (non-"last") result key of a Kraken response, e.g. "SHXUSD". */
function krakenResultKey(result) {
  return Object.keys(result || {}).find((k) => k !== "last");
}

/**
 * Latest price + 24h change for a Kraken-served symbol.
 * Price comes from the ticker; 24h change from the last two daily closes.
 */
async function krakenPrice(symbol) {
  const pair = KRAKEN_SYMBOLS[symbol];
  const [tickerJson, ohlcJson] = await Promise.all([
    fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, 12_000, "Kraken"),
    fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`, 12_000, "Kraken"),
  ]);
  if (tickerJson.error?.length || ohlcJson.error?.length) {
    throw new Error(`Kraken error for ${pair}`);
  }
  const t = tickerJson.result[krakenResultKey(tickerJson.result)];
  const rows = ohlcJson.result[krakenResultKey(ohlcJson.result)];
  const price = Number(t?.c?.[0]);
  let change24hPct = 0;
  if (Array.isArray(rows) && rows.length >= 2) {
    const prev = Number(rows[rows.length - 2][4]);
    const last = Number(rows[rows.length - 1][4]);
    if (Number.isFinite(prev) && Number.isFinite(last) && prev > 0) {
      change24hPct = ((last - prev) / prev) * 100;
    }
  }
  if (!Number.isFinite(price)) throw new Error(`Kraken price unavailable for ${pair}`);
  return { symbol, price, change24hPct };
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
      if (KRAKEN_SYMBOLS[symbol]) return krakenPrice(symbol);
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
    throw new Error("Price feed unavailable");
  }

  const data = { prices, updatedAt: new Date().toISOString() };
  priceCache.data = data;
  priceCache.at = now;
  return data;
}

/**
 * Closed candles for a Kraken-served symbol, ascending by time.
 * Kraken OHLC: [ time, open, high, low, close, vwap, volume, count ],
 * up to 720 rows per call; `since` pages forward, so we walk backwards from
 * the cursor in <=720-row windows and keep candles at/before the cursor.
 */
async function krakenCandles(symbol, g, limit, endBefore, cacheKey, hasCursor, endCursor) {
  const pair = KRAKEN_SYMBOLS[symbol];
  const interval = KRAKEN_INTERVALS[g];
  const now = Date.now();
  const cached = candleCache.get(cacheKey);
  if (cached && now - cached.at < CANDLE_TTL && cached.data.candles.length >= limit) {
    return { ...cached.data, candles: cached.data.candles.slice(-limit) };
  }

  const want = limit + 10; // over-fetch to cover the dropped forming candle
  const all = [];
  const seen = new Set();
  let cursor = hasCursor ? endCursor : Math.floor(now / 1000);

  while (all.length < want) {
    const since = Math.max(0, cursor - want * g);
    const url =
      `https://api.kraken.com/0/public/OHLC?pair=${pair}` +
      `&interval=${interval}&since=${since}`;
    let json;
    try {
      json = await fetchJson(url, 12_000, "Kraken");
    } catch (err) {
      if (all.length === 0 && cached) return cached.data; // last-good fallback
      if (all.length === 0) throw new Error("Kraken candle feed unavailable");
      break;
    }
    if (json.error?.length) {
      if (all.length === 0) throw new Error(`Kraken error for ${pair}`);
      break;
    }
    const rows = json.result?.[krakenResultKey(json.result)];
    if (!Array.isArray(rows) || rows.length === 0) break;
    let added = 0;
    for (const [t, o, h, l, c, _vwap, v] of rows) {
      const time = Math.floor(Number(t));
      if (!Number.isFinite(time) || time > cursor || seen.has(time)) continue;
      seen.add(time);
      all.push({
        time,
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(c),
        volume: Number(v),
      });
      added++;
    }
    if (!added) break;
    const oldest = Math.min(...all.map((c) => c.time));
    if (rows.length < 720) break; // no more history upstream
    cursor = oldest - g; // page further back
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const candles = all
    .filter((c) => c.time + g <= nowSec) // drop the still-forming candle
    .sort((a, b) => a.time - b.time)
    .slice(-limit);

  const data = { symbol, granularity: g, candles };
  candleCache.set(cacheKey, { data, at: now });
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

  if (KRAKEN_SYMBOLS[symbol]) {
    return krakenCandles(symbol, g, limit, endBefore, key, hasCursor, endCursor);
  }

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
      // Coinbase only honors `end` together with `start`, and caps one
      // response at 300 candles — page an explicit <=300-candle window.
      params.set("end", end.toISOString());
      params.set("start", new Date(end.getTime() - 300 * g * 1000).toISOString());
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
