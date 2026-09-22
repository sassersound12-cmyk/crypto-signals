/**
 * lib/signals.js
 *
 * Technical-analysis building blocks and the deterministic signal engine.
 *
 * Everything here operates on CLOSED candles only — callers are responsible
 * for stripping the still-forming candle (see lib/prices.js).
 *
 * Exports:
 *   swingPoints(candles, k)      fractal swing highs/lows -> [{ i, price, time }]
 *   atr(candles, period)         average true range
 *   computeRSI(closes, period)   Wilder's RSI (null when not enough data)
 *   computeSupportResistance(candles, lookback)
 *   computeRegime(allPrices)     BTC-led / Altcoin season / Risk-off / Mixed
 *   buildSignals({...})          full /api/signals payload
 *
 * Signal rules (deterministic):
 *   BUY  = a closed candle CLOSES above resistance AND its volume is
 *          > 1.5x the mean volume of the 20 candles before it.
 *   SELL = a closed candle CLOSES below support.
 * A "break" is counted only on a fresh cross (previous close was on the
 * other side of the level). Crucially, each candle is tested against the
 * support/resistance AS THEY STOOD BEFORE THAT CANDLE (levels from candles
 * up to the previous close), not against today's levels and not against
 * levels that include the candle itself — a breakout must defeat the
 * resistance that existed going into it. That keeps phantom signals from
 * appearing late (old candles measured against new levels) and keeps real
 * breakouts in history even as levels move later.
 * The scan is fully deterministic, so repeated polling returns the same
 * history without any dedupe bookkeeping.
 *
 * Nothing here is financial advice and no outcome is ever presented as a
 * sure thing: confidence is a 0-100 score of how many independent
 * confirmations fired, nothing more.
 */

// ---------------------------------------------------------------------------
// Shared primitives (also used by lib/patterns.js)
// ---------------------------------------------------------------------------

/**
 * Fractal swing points: index i is a swing high when high[i] is strictly the
 * highest of high[i-k .. i+k] (mirror for lows). Returns indices into the
 * input array so callers can map back to candles / overlay coordinates.
 */
export function swingPoints(candles, k = 2) {
  const highs = [];
  const lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

/** Average True Range over the last `period` candles (null if too little data). */
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

/** Wilder's RSI. Returns null when there are fewer than period+1 closes. */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsiState(value) {
  if (value == null) return "neutral";
  if (value >= 70) return "overbought";
  if (value <= 30) return "oversold";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Support / resistance from recent swing points
// ---------------------------------------------------------------------------

/**
 * Support = most recent swing low below the last close; resistance = most
 * recent swing high above the last close (both from the last `lookback`
 * candles). Falls back to the window's min low / max high so the fields are
 * rarely null.
 */
export function computeSupportResistance(candles, lookback = 100) {
  if (!candles.length) return { support: null, resistance: null };
  const window = candles.slice(-lookback);
  const lastClose = candles[candles.length - 1].close;
  const { highs, lows } = swingPoints(window, 2);

  let support = null;
  for (let i = lows.length - 1; i >= 0; i--) {
    if (lows[i].price < lastClose) {
      support = lows[i].price;
      break;
    }
  }
  let resistance = null;
  for (let i = highs.length - 1; i >= 0; i--) {
    if (highs[i].price > lastClose) {
      resistance = highs[i].price;
      break;
    }
  }
  if (support == null) support = Math.min(...window.map((c) => c.low));
  if (resistance == null) resistance = Math.max(...window.map((c) => c.high));
  return { support, resistance };
}

// ---------------------------------------------------------------------------
// Market regime from 24h performance of the tracked majors
// ---------------------------------------------------------------------------

export function computeRegime(allPrices) {
  const entries = Object.entries(allPrices || {}).filter(([, v]) =>
    Number.isFinite(v?.change24hPct)
  );
  if (!entries.length) {
    return {
      label: "Mixed",
      note: "Not enough market data to classify the current regime.",
    };
  }
  const btc = allPrices["BTC-USD"]?.change24hPct ?? 0;
  const altChanges = entries
    .filter(([s]) => s !== "BTC-USD")
    .map(([, v]) => v.change24hPct);
  const avgAlt = altChanges.length
    ? altChanges.reduce((a, b) => a + b, 0) / altChanges.length
    : 0;
  const meanAll =
    entries.reduce((a, [, v]) => a + v.change24hPct, 0) / entries.length;

  if (meanAll <= -3) {
    return {
      label: "Risk-off",
      note: "Broad weakness across majors over the last 24h — capital looks to be moving to the sidelines.",
    };
  }
  if (avgAlt >= 2 && avgAlt - btc >= 3) {
    return {
      label: "Altcoin season",
      note: "Altcoins are outperforming BTC by a wide margin — rotation into alts appears underway.",
    };
  }
  if (btc >= 2 && btc - avgAlt >= 1) {
    return {
      label: "BTC-led",
      note: "BTC is leading the market while altcoins lag behind.",
    };
  }
  return {
    label: "Mixed",
    note: "No clear leader — majors are moving in different directions over the last 24h.",
  };
}

// ---------------------------------------------------------------------------
// Signal engine
// ---------------------------------------------------------------------------

const BULLISH_PATTERNS = new Set([
  "Double Bottom",
  "Inverse Head and Shoulders",
  "Falling Wedge",
  "Ascending Triangle",
  "Bull Pennant",
]);
const BEARISH_PATTERNS = new Set([
  "Double Top",
  "Head and Shoulders",
  "Rising Wedge",
  "Descending Triangle",
  "Bear Pennant",
]);

/**
 * No dedupe bookkeeping: the break scan below is fully deterministic, so
 * every recompute over the same candles yields the same signal history.
 */

function meanVolume(candles, from, to) {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    sum += candles[i].volume;
    n++;
  }
  return n ? sum / n : 0;
}

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1000)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

function fmtRatio(r) {
  return `${r.toFixed(1)}x`;
}

/** Pattern whose window covers (or just ended before) candle index i. */
function patternNear(patterns, i) {
  let best = null;
  for (const p of patterns || []) {
    if (p.startIndex <= i && p.endIndex + 12 >= i) {
      if (!best || p.confidence > best.confidence) best = p;
    }
  }
  return best;
}

/** Newest high/medium-impact news item mentioning the asset within 24h. */
function newsNear(newsItems, asset, breakTime) {
  let best = null;
  for (const item of newsItems || []) {
    if (!item.assets?.includes(asset)) continue;
    if (item.impact !== "high" && item.impact !== "medium") continue;
    if (!item.publishedAt) continue;
    const t = Date.parse(item.publishedAt);
    if (!Number.isFinite(t)) continue;
    const ageH = (breakTime * 1000 - t) / 3_600_000;
    if (ageH < 0 || ageH > 24) continue;
    if (!best || t > Date.parse(best.publishedAt)) best = item;
  }
  return best;
}

function confidenceFor(type, { volRatio, rsiValue, patternName, newsItem, depthPct }) {
  let c = 55; // the break itself
  if (type === "BUY") {
    if (volRatio >= 2.5) c += 15;
    if (rsiValue != null && rsiValue > 50 && rsiValue < 70) c += 10;
    if (patternName && BULLISH_PATTERNS.has(patternName)) c += 10;
  } else {
    if (volRatio >= 1.5) c += 10;
    if (depthPct >= 1) c += 10; // decisive close beyond the level
    if (rsiValue != null && rsiValue > 30 && rsiValue < 50) c += 10;
    if (patternName && BEARISH_PATTERNS.has(patternName)) c += 10;
  }
  if (newsItem?.impact === "high") c -= 10; // headline risk cuts both ways
  else c += 5;
  return Math.max(40, Math.min(95, Math.round(c)));
}

function buildSignal({
  symbol,
  asset,
  type,
  candle,
  level,
  volRatio,
  rsiValue,
  rsiSt,
  patternName,
  newsItem,
  horizon,
  granularity,
}) {
  // Timestamp the signal at the candle CLOSE (the actual event: the break is
  // confirmed when the candle closes). candle.time is the bucket OPEN, so a
  // signal stamped with it would read one full candle early (30 min on 30m).
  const breakTime = candle.time + (Number(granularity) || 0);
  const close = candle.close;
  const depthPct = Math.abs((close - level) / level) * 100;
  const confidence = confidenceFor(type, {
    volRatio,
    rsiValue,
    patternName,
    newsItem,
    depthPct,
  });
  const volumeStr = `${fmtRatio(volRatio)} the 20-candle average`;
  const rsiStr =
    rsiValue == null ? "RSI unavailable" : `RSI ${rsiValue.toFixed(0)} (${rsiSt})`;
  const newsStr = newsItem
    ? `${newsItem.impact}-impact: ${newsItem.title.slice(0, 110)}`
    : null;

  const levelWord = type === "BUY" ? "resistance" : "support";
  let rationale =
    `${asset} closed ${type === "BUY" ? "above" : "below"} ${levelWord} ` +
    `at $${fmtPrice(level)} (close $${fmtPrice(close)}) with volume ${volumeStr}. ` +
    `${rsiStr}.`;
  if (patternName) rationale += ` A ${patternName} pattern was detected nearby.`;
  if (newsItem) rationale += ` Related news: ${newsItem.title.slice(0, 110)}.`;
  rationale +=
    " This is an automated observation of price structure, not financial advice.";

  return {
    id: `sig-${symbol}-${type}-${breakTime}`,
    type,
    time: new Date(breakTime * 1000).toISOString(),
    price: close,
    confidence,
    horizon,
    rationale,
    components: {
      pattern: patternName || null,
      volume: volumeStr,
      rsi: rsiStr,
      news: newsStr,
    },
  };
}

/**
 * Scan closed candles (ascending) for fresh S/R breaks.
 * Each candle is tested against the support/resistance AS THEY STOOD
 * BEFORE IT (from candles up to the previous close), so breaks are
 * detected when they actually happened and stay in history even as
 * levels move later. Fully deterministic: same candles, same signals.
 */
function scanBreaks({ symbol, asset, candles, patterns, newsItems, granularity }) {
  const signals = [];
  const horizon = granularity <= 3600 ? "intraday" : "swing";
  const closes = candles.map((c) => c.close);

  for (let i = candles.length - 1; i >= 20; i--) {
    const c = candles[i];
    const prev = candles[i - 1];
    // Levels as they stood BEFORE this candle (at the previous close) —
    // never today's levels and never levels that include this candle.
    // A breakout must defeat the resistance that existed going into it.
    const { support, resistance } = computeSupportResistance(
      candles.slice(0, i),
      100
    );
    const avgVol = meanVolume(candles, i - 20, i);
    const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
    const pattern = patternNear(patterns, i);
    const newsItem = newsNear(newsItems, asset, c.time);
    // RSI as it stood at the signal candle (not today's value).
    const rsiAtSignal = computeRSI(closes.slice(0, i + 1), 14);
    const rsiStAtSignal = rsiState(rsiAtSignal);

    let type = null;
    let level = null;
    if (
      resistance != null &&
      prev.close <= resistance &&
      c.close > resistance &&
      volRatio > 1.5
    ) {
      type = "BUY";
      level = resistance;
    } else if (support != null && prev.close >= support && c.close < support) {
      type = "SELL";
      level = support;
    }
    if (!type) continue;

    signals.push(
      buildSignal({
        symbol,
        asset,
        type,
        candle: c,
        level,
        volRatio,
        rsiValue: rsiAtSignal,
        rsiSt: rsiStAtSignal,
        patternName: pattern?.name,
        newsItem,
        horizon,
        granularity,
      })
    );
  }

  signals.sort((a, b) => (a.time < b.time ? 1 : -1)); // newest first
  return signals;
}

// ---------------------------------------------------------------------------
// Unified per-coin verdict: one clear directional read built from the same
// pieces the app already shows (S/R signals, EMA trend, RSI, momentum,
// position vs support/resistance). When the pieces genuinely disagree the
// verdict lands on Neutral instead of forcing a fake consensus — "wait for
// clarity" is itself a clear answer.
// ---------------------------------------------------------------------------

function emaLast(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

export function computeVerdict({ signals, price, change24hPct, rsiValue, candles, support, resistance }) {
  const bull = [];
  const bear = [];
  let score = 0;

  // 1. Newest S/R signal, weight decaying to zero at 24h old.
  const s0 = Array.isArray(signals) && signals.length ? signals[0] : null;
  if (s0) {
    const t = Date.parse(s0.time);
    const ageH = isFinite(t) ? (Date.now() - t) / 3600000 : Infinity;
    if (ageH <= 24) {
      const w = 2 * (1 - ageH / 24);
      const isSell = String(s0.type || '').toUpperCase() === 'SELL';
      score += isSell ? -w : w;
      (isSell ? bear : bull).push(
        (isSell ? 'SELL' : 'BUY') + ' signal ' + (ageH < 1 ? 'under an hour ago' : Math.round(ageH) + 'h ago')
      );
    }
  }

  // 2. EMA ribbon trend on the 1h candles: price vs the ribbon.
  const closes = (candles || []).map((c) => c.close);
  const emas = [8, 13, 21, 34, 55, 89].map((p) => emaLast(closes, p)).filter((v) => v != null);
  if (emas.length && isFinite(price)) {
    const mx = Math.max(...emas);
    const mn = Math.min(...emas);
    if (price > mx) { score += 1; bull.push('price above EMA ribbon'); }
    else if (price < mn) { score -= 1; bear.push('price below EMA ribbon'); }
  }

  // 3. RSI extremes.
  if (rsiValue != null && isFinite(rsiValue)) {
    if (rsiValue >= 70) { score -= 1; bear.push('RSI overbought (' + Math.round(rsiValue) + ')'); }
    else if (rsiValue <= 30) { score += 1; bull.push('RSI oversold (' + Math.round(rsiValue) + ')'); }
  }

  // 4. 24h momentum.
  if (isFinite(change24hPct)) {
    if (change24hPct >= 3) { score += 1; bull.push('up ' + change24hPct.toFixed(1) + '% in 24h'); }
    else if (change24hPct <= -3) { score -= 1; bear.push('down ' + Math.abs(change24hPct).toFixed(1) + '% in 24h'); }
  }

  // 5. Position vs support/resistance (within 1%).
  if (isFinite(price)) {
    if (isFinite(resistance) && resistance > price && (resistance - price) / price < 0.01) {
      score -= 1; bear.push('pressing resistance');
    }
    if (isFinite(support) && support < price && (price - support) / price < 0.01) {
      score += 1; bull.push('holding above support');
    }
  }

  const label = score >= 2.5 ? 'Bullish' : score <= -2.5 ? 'Bearish' : 'Neutral';
  return { label, score: Math.round(score * 100) / 100, bullish: bull, bearish: bear };
}

/**
 * Build the full /api/signals payload.
 *
 * @param {object} opts
 * @param {string} opts.symbol        e.g. "BTC-USD"
 * @param {number} opts.price         latest price
 * @param {number} opts.change24hPct  24h change percent
 * @param {Array}  opts.candles       closed candles, ascending by time
 * @param {number} [opts.granularity] candle size in seconds (default 3600)
 * @param {Array}  [opts.patterns]    detectPatterns() output on same candles
 * @param {Array}  [opts.newsItems]   getNews() items
 * @param {object} [opts.allPrices]   prices map for regime classification
 */export function buildSignals({
  symbol,
  price,
  change24hPct,
  candles,
  granularity = 3600,
  patterns = [],
  newsItems = [],
  allPrices = {},
}) {
  const closes = candles.map((c) => c.close);
  const rsiValue = computeRSI(closes, 14);
  const rsiSt = rsiState(rsiValue);
  const { support, resistance } = computeSupportResistance(candles, 100);
  const asset = symbol.split("-")[0];

  const signals = scanBreaks({
    symbol,
    asset,
    candles,
    patterns,
    newsItems,
    granularity,
  }).slice(0, 25); // newest first; keep the payload light

  return {
    symbol,
    price,
    change24hPct,
    updatedAt: new Date().toISOString(),
    rsi: {
      value: rsiValue == null ? null : Math.round(rsiValue * 100) / 100,
      period: 14,
      state: rsiSt,
    },
    support,
    resistance,
    signals,
    regime: computeRegime(allPrices),
    verdict: computeVerdict({ signals, price, change24hPct, rsiValue, candles, support, resistance }),
  };
}
