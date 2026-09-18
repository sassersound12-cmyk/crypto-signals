/**
 * lib/patterns.js
 *
 * Chart-pattern detection on closed candles (ascending by time).
 *
 * Uses fractal swing points (see lib/signals.js) and simple geometry:
 * trendline slopes via least squares, tolerance bands scaled by ATR so the
 * same code works for BTC and DOGE.
 *
 * Deliberately conservative: a pattern is reported only when its geometric
 * criteria are genuinely met. It is CORRECT and expected for detectPatterns()
 * to often return an empty array — the API then carries the note
 * "No pattern detected in recent price action."
 *
 * Each pattern: { name, confidence, detectedAt, label, trigger,
 *                 invalidation, target, startIndex, endIndex, levels }
 * startIndex/endIndex are indices into the input candle array (ascending),
 * so the frontend can overlay them.
 * `levels` carries the same key prices as plain numbers for chart overlays:
 * { trigger: number[], invalidation: number[], target: number|null }
 * (null when a pattern has no numeric levels, e.g. symmetrical triangle).
 */

import { swingPoints, atr } from "./signals.js";

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

function linreg(pts) {
  const m = pts.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = m * sxx - sx * sx;
  const slope = denom !== 0 ? (m * sxy - sx * sy) / denom : 0;
  const intercept = m ? (sy - slope * sx) / m : 0;
  return { slope, intercept };
}

function lineVal(reg, x) {
  return reg.slope * x + reg.intercept;
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

function roundPrice(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1000) return Math.round(n * 100) / 100;
  if (n >= 100) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 1000) / 1000;
  return Math.round(n * 100000) / 100000;
}

/** Swing points restricted to the last `lookback` candles. */
function recentSwings(candles, k, lookback) {
  const n = candles.length;
  const { highs, lows } = swingPoints(candles, k);
  return {
    highs: highs.filter((h) => h.i >= n - lookback),
    lows: lows.filter((l) => l.i >= n - lookback),
  };
}

function base(candles, startIndex, endIndex) {
  return {
    detectedAt: new Date(candles[candles.length - 1].time * 1000).toISOString(),
    startIndex,
    endIndex,
  };
}

// ---------------------------------------------------------------------------
// Reversal patterns
// ---------------------------------------------------------------------------

function detectDoubleTop(candles, A) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, 150);
  if (highs.length < 2) return null;
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  if (h2.i < n - 45) return null; // must be recent
  if (h2.i - h1.i < 5) return null;
  if (Math.abs(h1.price - h2.price) > 1.2 * A) return null; // tops must align
  const between = lows.filter((l) => l.i > h1.i && l.i < h2.i);
  if (!between.length) return null;
  const neck = Math.min(...between.map((l) => l.price));
  const top = Math.max(h1.price, h2.price);
  const depth = top - neck;
  if (depth < 1.5 * A) return null; // needs a real valley between the tops
  const symmetry = 1 - Math.abs(h1.price - h2.price) / (1.2 * A);
  const confidence = Math.min(
    85,
    Math.round(58 + symmetry * 17 + Math.min(10, depth / A))
  );
  return {
    name: "Double Top",
    confidence,
    ...base(candles, h1.i, h2.i),
    label: "Double Top — bearish reversal",
    trigger: `A close below the $${fmtPrice(neck)} neckline would confirm the pattern.`,
    invalidation: `Invalidated by a close above $${fmtPrice(top)}.`,
    target: roundPrice(neck - depth),
    levels: { trigger: [roundPrice(neck)], invalidation: [roundPrice(top)], target: roundPrice(neck - depth) },
  };
}

function detectDoubleBottom(candles, A) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, 150);
  if (lows.length < 2) return null;
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
  if (l2.i < n - 45) return null;
  if (l2.i - l1.i < 5) return null;
  if (Math.abs(l1.price - l2.price) > 1.2 * A) return null;
  const between = highs.filter((h) => h.i > l1.i && h.i < l2.i);
  if (!between.length) return null;
  const neck = Math.max(...between.map((h) => h.price));
  const bottom = Math.min(l1.price, l2.price);
  const height = neck - bottom;
  if (height < 1.5 * A) return null;
  const symmetry = 1 - Math.abs(l1.price - l2.price) / (1.2 * A);
  const confidence = Math.min(
    85,
    Math.round(58 + symmetry * 17 + Math.min(10, height / A))
  );
  return {
    name: "Double Bottom",
    confidence,
    ...base(candles, l1.i, l2.i),
    label: "Double Bottom — bullish reversal",
    trigger: `A close above the $${fmtPrice(neck)} neckline would confirm the pattern.`,
    invalidation: `Invalidated by a close below $${fmtPrice(bottom)}.`,
    target: roundPrice(neck + height),
    levels: { trigger: [roundPrice(neck)], invalidation: [roundPrice(bottom)], target: roundPrice(neck + height) },
  };
}

function detectHeadAndShoulders(candles, A) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, 160);
  if (highs.length < 3) return null;
  const [s1, head, s2] = highs.slice(-3);
  if (s2.i < n - 45) return null;
  if (head.price <= s1.price + 0.8 * A) return null; // head must stand out
  if (head.price <= s2.price + 0.8 * A) return null;
  if (Math.abs(s1.price - s2.price) > 1.5 * A) return null; // balanced shoulders
  const t1 = lows.filter((l) => l.i > s1.i && l.i < head.i);
  const t2 = lows.filter((l) => l.i > head.i && l.i < s2.i);
  if (!t1.length || !t2.length) return null;
  const neck = Math.min(
    Math.min(...t1.map((l) => l.price)),
    Math.min(...t2.map((l) => l.price))
  );
  const height = head.price - neck;
  if (height < 2 * A) return null;
  const shoulderBalance = 1 - Math.abs(s1.price - s2.price) / (1.5 * A);
  const confidence = Math.min(
    85,
    Math.round(60 + shoulderBalance * 15 + Math.min(10, height / (2 * A)))
  );
  return {
    name: "Head and Shoulders",
    confidence,
    ...base(candles, s1.i, s2.i),
    label: "Head and Shoulders — bearish reversal",
    trigger: `A close below the $${fmtPrice(neck)} neckline would confirm the pattern.`,
    invalidation: `Invalidated by a close above the $${fmtPrice(head.price)} head.`,
    target: roundPrice(neck - height),
    levels: { trigger: [roundPrice(neck)], invalidation: [roundPrice(head.price)], target: roundPrice(neck - height) },
  };
}

function detectInverseHeadAndShoulders(candles, A) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, 160);
  if (lows.length < 3) return null;
  const [s1, head, s2] = lows.slice(-3);
  if (s2.i < n - 45) return null;
  if (head.price >= s1.price - 0.8 * A) return null;
  if (head.price >= s2.price - 0.8 * A) return null;
  if (Math.abs(s1.price - s2.price) > 1.5 * A) return null;
  const t1 = highs.filter((h) => h.i > s1.i && h.i < head.i);
  const t2 = highs.filter((h) => h.i > head.i && h.i < s2.i);
  if (!t1.length || !t2.length) return null;
  const neck = Math.max(
    Math.max(...t1.map((h) => h.price)),
    Math.max(...t2.map((h) => h.price))
  );
  const depth = neck - head.price;
  if (depth < 2 * A) return null;
  const shoulderBalance = 1 - Math.abs(s1.price - s2.price) / (1.5 * A);
  const confidence = Math.min(
    85,
    Math.round(60 + shoulderBalance * 15 + Math.min(10, depth / (2 * A)))
  );
  return {
    name: "Inverse Head and Shoulders",
    confidence,
    ...base(candles, s1.i, s2.i),
    label: "Inverse Head and Shoulders — bullish reversal",
    trigger: `A close above the $${fmtPrice(neck)} neckline would confirm the pattern.`,
    invalidation: `Invalidated by a close below the $${fmtPrice(head.price)} head.`,
    target: roundPrice(neck + depth),
    levels: { trigger: [roundPrice(neck)], invalidation: [roundPrice(head.price)], target: roundPrice(neck + depth) },
  };
}

// ---------------------------------------------------------------------------
// Wedges and triangles (last 70 candles, >=3 swing highs and >=3 swing lows)
// ---------------------------------------------------------------------------

function trendPair(candles, A, W = 70) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, W);
  if (highs.length < 3 || lows.length < 3) return null;
  const rh = linreg(highs.map((h) => ({ x: h.i, y: h.price })));
  const rl = linreg(lows.map((l) => ({ x: l.i, y: l.price })));
  const spread0 =
    lineVal(rh, highs[0].i) - lineVal(rl, lows[0].i);
  const spread1 = lineVal(rh, n - 1) - lineVal(rl, n - 1);
  const narrowing = spread1 > 0 && spread1 < spread0 * 0.85;
  return { highs, lows, rh, rl, narrowing, n, W };
}

function detectRisingWedge(candles, A) {
  const t = trendPair(candles, A);
  if (!t) return null;
  const { rh, rl, narrowing, n, W, highs, lows } = t;
  if (!(rh.slope > 0 && rl.slope > 0)) return null;
  if (!(rl.slope > rh.slope * 1.25)) return null; // lower line rising faster
  if (rl.slope * W < 1.0 * A) return null;
  if (!narrowing) return null;
  const lowerNow = lineVal(rl, n - 1);
  const confidence = Math.min(82, Math.round(60 + Math.min(22, (rl.slope / rh.slope) * 8)));
  return {
    name: "Rising Wedge",
    confidence,
    ...base(candles, Math.min(highs[0].i, lows[0].i), n - 1),
    label: "Rising Wedge — bearish",
    trigger: `A close below the rising lower trendline near $${fmtPrice(lowerNow)} would confirm breakdown.`,
    invalidation: "Invalidated by a strong close above the upper trendline.",
    target: null,
    levels: { trigger: [roundPrice(lowerNow)], invalidation: [], target: null },
  };
}

function detectFallingWedge(candles, A) {
  const t = trendPair(candles, A);
  if (!t) return null;
  const { rh, rl, narrowing, n, W, highs, lows } = t;
  if (!(rh.slope < 0 && rl.slope < 0)) return null;
  if (!(Math.abs(rh.slope) > Math.abs(rl.slope) * 1.25)) return null;
  if (Math.abs(rh.slope) * W < 1.0 * A) return null;
  if (!narrowing) return null;
  const upperNow = lineVal(rh, n - 1);
  const confidence = Math.min(
    82,
    Math.round(60 + Math.min(22, (Math.abs(rh.slope) / Math.abs(rl.slope)) * 8))
  );
  return {
    name: "Falling Wedge",
    confidence,
    ...base(candles, Math.min(highs[0].i, lows[0].i), n - 1),
    label: "Falling Wedge — bullish",
    trigger: `A close above the falling upper trendline near $${fmtPrice(upperNow)} would confirm breakout.`,
    invalidation: "Invalidated by a strong close below the lower trendline.",
    target: null,
    levels: { trigger: [roundPrice(upperNow)], invalidation: [], target: null },
  };
}

function detectAscendingTriangle(candles, A) {
  const t = trendPair(candles, A);
  if (!t) return null;
  const { highs, lows, rh, rl, n, W } = t;
  const res = highs.reduce((a, h) => a + h.price, 0) / highs.length;
  const variance =
    highs.reduce((a, h) => a + (h.price - res) ** 2, 0) / highs.length;
  if (Math.abs(rh.slope) * W > 0.8 * A) return null; // resistance must be flat
  if (Math.sqrt(variance) > 1.0 * A) return null; // highs must cluster
  if (rl.slope * W < 1.2 * A) return null; // support must be rising
  const lowLine = lineVal(rl, n - 1);
  const confidence = Math.min(84, Math.round(62 + Math.min(22, (rl.slope * W) / A)));
  return {
    name: "Ascending Triangle",
    confidence,
    ...base(candles, Math.min(highs[0].i, lows[0].i), n - 1),
    label: "Ascending Triangle — bullish continuation",
    trigger: `A close above resistance at $${fmtPrice(res)} would confirm breakout.`,
    invalidation: `Invalidated by a close below the rising support near $${fmtPrice(lowLine)}.`,
    target: roundPrice(res + (res - Math.min(...lows.map((l) => l.price)))),
    levels: { trigger: [roundPrice(res)], invalidation: [roundPrice(lowLine)], target: roundPrice(res + (res - Math.min(...lows.map((l) => l.price)))) },
  };
}

function detectDescendingTriangle(candles, A) {
  const t = trendPair(candles, A);
  if (!t) return null;
  const { highs, lows, rh, rl, n, W } = t;
  const sup = lows.reduce((a, l) => a + l.price, 0) / lows.length;
  const variance =
    lows.reduce((a, l) => a + (l.price - sup) ** 2, 0) / lows.length;
  if (Math.abs(rl.slope) * W > 0.8 * A) return null; // support must be flat
  if (Math.sqrt(variance) > 1.0 * A) return null;
  if (Math.abs(rh.slope) * W < 1.2 * A) return null; // resistance falling
  const upperNow = lineVal(rh, n - 1);
  const confidence = Math.min(
    84,
    Math.round(62 + Math.min(22, (Math.abs(rh.slope) * W) / A))
  );
  return {
    name: "Descending Triangle",
    confidence,
    ...base(candles, Math.min(highs[0].i, lows[0].i), n - 1),
    label: "Descending Triangle — bearish continuation",
    trigger: `A close below support at $${fmtPrice(sup)} would confirm breakdown.`,
    invalidation: `Invalidated by a close above the falling resistance near $${fmtPrice(upperNow)}.`,
    target: roundPrice(sup - (Math.max(...highs.map((h) => h.price)) - sup)),
    levels: { trigger: [roundPrice(sup)], invalidation: [roundPrice(upperNow)], target: roundPrice(sup - (Math.max(...highs.map((h) => h.price)) - sup)) },
  };
}

function detectSymmetricalTriangle(candles, A) {
  const t = trendPair(candles, A);
  if (!t) return null;
  const { highs, lows, rh, rl, narrowing, n, W } = t;
  if (!(rh.slope * W < -1.2 * A)) return null;
  if (!(rl.slope * W > 1.2 * A)) return null;
  if (!narrowing) return null;
  const confidence = Math.min(80, Math.round(60 + Math.min(20, (Math.abs(rh.slope) * W) / A)));
  return {
    name: "Symmetrical Triangle",
    confidence,
    ...base(candles, Math.min(highs[0].i, lows[0].i), n - 1),
    label: "Symmetrical Triangle — direction undecided",
    trigger: "A close outside either trendline confirms the direction.",
    invalidation: "Invalidated if price drifts out of the pattern without a decisive close.",
    target: null,
    levels: null,
  };
}

// ---------------------------------------------------------------------------
// Pennants: sharp flagpole (>=4.5 ATR over 5-12 candles) + small consolidation
// ---------------------------------------------------------------------------

function detectPennant(candles, A, bullish) {
  const n = candles.length;
  for (let i = n - 15; i >= Math.max(20, n - 55); i--) {
    for (let j = 5; j <= 12; j++) {
      if (i - j < 0) continue;
      const move = candles[i].close - candles[i - j].close;
      const isPole = bullish ? move >= 4.5 * A : move <= -4.5 * A;
      if (!isPole) continue;
      const cons = candles.slice(i, Math.min(i + 22, n - 2));
      if (cons.length < 10) continue;
      const { highs, lows } = swingPoints(cons, 2);
      if (highs.length < 2 || lows.length < 2) continue;
      const rh = linreg(highs.map((h) => ({ x: h.i, y: h.price })));
      const rl = linreg(lows.map((l) => ({ x: l.i, y: l.price })));
      const range =
        Math.max(...cons.map((c) => c.high)) -
        Math.min(...cons.map((c) => c.low));
      const converging = bullish
        ? rh.slope < 0 && rl.slope > 0
        : rh.slope < 0 && rl.slope > 0;
      if (!converging || range >= 0.55 * Math.abs(move)) continue;
      const top = Math.max(...cons.map((c) => c.high));
      const bot = Math.min(...cons.map((c) => c.low));
      const confidence = Math.min(
        82,
        Math.round(62 + Math.min(20, (Math.abs(move) / A - 4.5) * 4))
      );
      const endIdx = i + cons.length - 1;
      if (bullish) {
        return {
          name: "Bull Pennant",
          confidence,
          ...base(candles, i - j, endIdx),
          label: "Bull Pennant — bullish continuation",
          trigger: `A close above $${fmtPrice(top)} would resume the up-move.`,
          invalidation: `Invalidated by a close below $${fmtPrice(bot)}.`,
          target: roundPrice(top + Math.abs(move)),
          levels: { trigger: [roundPrice(top)], invalidation: [roundPrice(bot)], target: roundPrice(top + Math.abs(move)) },
        };
      }
      return {
        name: "Bear Pennant",
        confidence,
        ...base(candles, i - j, endIdx),
        label: "Bear Pennant — bearish continuation",
        trigger: `A close below $${fmtPrice(bot)} would resume the down-move.`,
        invalidation: `Invalidated by a close above $${fmtPrice(top)}.`,
        target: roundPrice(bot - Math.abs(move)),
        levels: { trigger: [roundPrice(bot)], invalidation: [roundPrice(top)], target: roundPrice(bot - Math.abs(move)) },
      };
    }
  }
  return null;
}

function detectBullPennant(candles, A) {
  return detectPennant(candles, A, true);
}
function detectBearPennant(candles, A) {
  return detectPennant(candles, A, false);
}

// ---------------------------------------------------------------------------
// Rectangle: horizontal range with >=2 touches per side, price still inside
// ---------------------------------------------------------------------------

function detectRectangle(candles, A) {
  const n = candles.length;
  const { highs, lows } = recentSwings(candles, 3, 70);
  if (highs.length < 2 || lows.length < 2) return null;
  const top = Math.max(...highs.map((h) => h.price));
  const bot = Math.min(...lows.map((l) => l.price));
  const range = top - bot;
  if (range < 2.5 * A) return null;
  const topTouches = highs.filter((h) => top - h.price <= 1.0 * A).length;
  const botTouches = lows.filter((l) => l.price - bot <= 1.0 * A).length;
  if (topTouches < 2 || botTouches < 2) return null;
  const last = candles[n - 1].close;
  if (last >= top || last <= bot) return null; // only while still ranging
  const start = Math.min(highs[0].i, lows[0].i);
  const confidence = Math.min(
    80,
    Math.round(60 + (topTouches + botTouches - 4) * 5 + Math.min(10, range / A))
  );
  return {
    name: "Rectangle",
    confidence,
    ...base(candles, start, n - 1),
    label: "Rectangle — ranging market",
    trigger: `A close outside $${fmtPrice(bot)}–$${fmtPrice(top)} confirms the next direction.`,
    invalidation: "A breakout that closes back inside the range was a false break.",
    target: null,
    levels: { trigger: [roundPrice(bot), roundPrice(top)], invalidation: [], target: null },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Detect chart patterns on closed, ascending candles.
 * Returns [] when nothing meets the criteria (the normal case).
 */
export function detectPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return [];
  const A = atr(candles, 14);
  if (!A || A <= 0) return [];

  const found = [];
  const detectors = [
    detectDoubleTop,
    detectDoubleBottom,
    detectHeadAndShoulders,
    detectInverseHeadAndShoulders,
    detectRisingWedge,
    detectFallingWedge,
    detectAscendingTriangle,
    detectDescendingTriangle,
    detectSymmetricalTriangle,
    detectBullPennant,
    detectBearPennant,
    detectRectangle,
  ];
  for (const d of detectors) {
    try {
      const p = d(candles, A);
      if (p) found.push(p);
    } catch {
      // One bad detector must never break the whole endpoint.
    }
  }
  found.sort((a, b) => b.endIndex - a.endIndex); // most recent first
  return found;
}
