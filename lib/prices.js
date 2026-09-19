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
 *   - prices: 10s
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

/**
 * Candle granularity plans.
 *
 * Neither upstream offers every interval, so each supported granularity
 * resolves per-source to either a native fetch or a resample rule
 * [nativeGranularity, factor]: fetch `factor`x native candles and aggregate
 * them into target buckets (open = first open, high = max, low = min,
 * close = last close, volume = sum). Every interval divides evenly and
 * aligns to the unix epoch, so buckets are exact.
 *
 * (Also fixes a latent bug: Kraken has no 6h interval, so SHX 21600s
 * candles were silently fetched as 4h. They now resample from 1h.)
 */
const CB_NATIVE = new Set([60, 300, 900, 3600, 21600, 86400]);
const CB_RESAMPLE = {
  1800: [900, 2], // 30m  <- 2 x 15m
  43200: [3600, 12], // 12h  <- 12 x 1h
  604800: [86400, 7], // 1w   <- 7 x 1d
  2592000: [86400, 30], // 30d  <- 30 x 1d
};
// Kraken OHLC interval minutes for each natively supported granularity (seconds).
const KR_NATIVE = new Map([
  [60, 1],
  [300, 5],
  [900, 15],
  [1800, 30],
  [3600, 60],
  [14400, 240],
  [86400, 1440],
  [604800, 10080],
  [1296000, 21600],
]);
const KR_RESAMPLE = {
  21600: [3600, 6], // 6h  <- 6 x 1h
  43200: [3600, 12], // 12h <- 12 x 1h
  2592000: [86400, 30], // 30d <- 30 x 1d
};

const GRANULARITIES = new Set([
  60, 300, 900, 1800, 3600, 21600, 43200, 86400, 604800, 2592000,
]);

// Cap on native candles fetched per getCandles call: bounds upstream paging
// for high-factor resamples (e.g. 30d). When the cap binds, partial history
// is returned rather than nothing.
const MAX_NATIVE_CANDLES = 3000;

// ---- in-memory caches -------------------------------------------------------
const priceCache = { data: null, at: 0 }; // 10s
const candleCache = new Map(); // key: `${symbol}:${granularity}` -> { data, at } (60s)
const PRICE_TTL = 10_000;
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
 * Native-granularity candles from Kraken, ascending by time, deduped.
 * The still-forming candle is NOT dropped here — the caller drops it at
 * the (possibly resampled) target granularity. Returns the full fetched
 * array; the caller slices to its limit.
 */
async function krakenNativeCandles(symbol, g, limit, fetchEnd, hasCursor, cached, now) {
  const pair = KRAKEN_SYMBOLS[symbol];
  const interval = KR_NATIVE.get(g);
  const all = [];
  const seen = new Set();
  let cursor = hasCursor ? fetchEnd : Math.floor(now / 1000);
  const want = limit + 10; // over-fetch a little to cover the dropped forming candle

  while (all.length < want) {
    const since = Math.max(0, cursor - want * g);
    const url =
      `https://api.kraken.com/0/public/OHLC?pair=${pair}` +
      `&interval=${interval}&since=${since}`;
    let json;
    try {
      json = await fetchJson(url, 12_000, "Kraken");
    } catch (err) {
      if (all.length === 0 && cached) return cached.data.candles; // last-good fallback
      if (all.length === 0) throw new Error("Kraken candle feed unavailable");
      break; // partial history is better than nothing
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

  return all.sort((a, b) => a.time - b.time);
}

/**
 * Native-granularity candles from Coinbase, ascending by time, deduped.
 * Same contract as krakenNativeCandles: no forming-candle drop here.
 */
async function coinbaseNativeCandles(symbol, g, limit, fetchEnd, hasCursor, cached, now) {
  // Stitch multiple calls for longer history. Coinbase takes optional
  // start/end (ISO 8601) to page older data; we walk backwards from
  // `fetchEnd` when given, otherwise from "now".
  const want = limit + 10; // over-fetch a little to cover the dropped forming candle
  const pages = Math.ceil(want / 300);
  const all = [];
  let end = hasCursor ? new Date(fetchEnd * 1000) : null;

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
      if (all.length === 0 && cached) return cached.data.candles; // last-good fallback
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

  // Dedupe overlapping page boundaries.
  const seen = new Set();
  return all
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });
}

/**
 * Aggregate native candles into larger target-granularity buckets.
 * open = first open, high = max high, low = min low, close = last close,
 * volume = sum. Input must be ascending by time (first candle in each
 * bucket wins `open`, last wins `close`).
 */
function resampleCandles(native, g) {
  const buckets = new Map();
  for (const c of native) {
    const bt = Math.floor(c.time / g) * g;
    let b = buckets.get(bt);
    if (!b) {
      b = {
        time: bt,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 0,
      };
      buckets.set(bt, b);
    } else {
      if (c.high > b.high) b.high = c.high;
      if (c.low < b.low) b.low = c.low;
      b.close = c.close;
    }
    const v = Number(c.volume);
    b.volume += Number.isFinite(v) ? v : 0;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
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

  // Resolve to a natively supported granularity; resample when the upstream
  // doesn't offer the requested interval (e.g. Coinbase has no 30m/12h/1w).
  const kraken = !!KRAKEN_SYMBOLS[symbol];
  let nativeG = g,
    factor = 1;
  if (kraken ? !KR_NATIVE.has(g) : !CB_NATIVE.has(g)) {
    const rule = (kraken ? KR_RESAMPLE : CB_RESAMPLE)[g];
    if (!rule) throw new Error(`Unsupported granularity ${granularity}`);
    [nativeG, factor] = rule;
  }

  // Over-fetch natives to feed the resampler, bounded so high-factor
  // resamples (e.g. 30d) don't page upstream forever.
  const nativeLimit =
    factor === 1 ? limit : Math.min(limit * factor + factor, MAX_NATIVE_CANDLES);
  // For resampled chunks the cursor names a target bucket; extend the native
  // fetch to the bucket's last native candle so the boundary bucket is whole.
  const fetchEnd = hasCursor && factor > 1 ? endCursor + g - nativeG : endCursor;
  const key = hasCursor
    ? `${symbol}:${nativeG}:end${fetchEnd}`
    : `${symbol}:${nativeG}`;
  const now = Date.now();

  const cached = candleCache.get(key);
  let native;
  if (
    cached &&
    now - cached.at < CANDLE_TTL &&
    cached.data.candles.length >= nativeLimit
  ) {
    native = cached.data.candles;
  } else {
    native = kraken
      ? await krakenNativeCandles(symbol, nativeG, nativeLimit, fetchEnd, hasCursor, cached, now)
      : await coinbaseNativeCandles(symbol, nativeG, nativeLimit, fetchEnd, hasCursor, cached, now);
    candleCache.set(key, {
      data: { symbol, granularity: nativeG, candles: native },
      at: now,
    });
  }

  const candles = factor === 1 ? native : resampleCandles(native, g);

  // Drop the still-forming target candle, then sort, dedupe, and take the
  // newest `limit`.
  const nowSec = Math.floor(now / 1000);
  const seen = new Set();
  const closed = candles
    .filter((c) => c.time + g <= nowSec)
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

  return { symbol, granularity: g, candles: closed.slice(-limit) };
}

/** True if a symbol is one we track (used by route validation). */
export function isSupportedSymbol(symbol) {
  return SYMBOLS.includes(symbol);
}
