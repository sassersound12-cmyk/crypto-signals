/**
 * lib/news.js
 *
 * Crypto news from keyless RSS feeds (CoinDesk + Cointelegraph), parsed with
 * rss-parser. Results are cached in memory for 10 minutes. On feed failure
 * the last good cache is returned; if there is none, an empty list is
 * returned — the endpoint never crashes because of upstream problems.
 *
 * Each item: { title, source, link, publishedAt, impact, assets }
 *   impact: "high" | "medium" | "low"   (keyword tagging)
 *   assets: ["BTC","ETH",...]           (symbol/name mentions, [] if none)
 */

import Parser from "rss-parser";

const parser = new Parser({
  timeout: 15_000,
  headers: { "User-Agent": "crypto-signals/1.0 (+keyless public data)" },
});

const FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
];

const NEWS_TTL = 10 * 60_000;
let cache = { items: [], updatedAt: null };
let lastFetch = 0;

const NOTE =
  "Headlines are informational context only — not trading advice. " +
  "Impact tags are rough keyword heuristics.";

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

const HIGH_KEYWORDS = [
  "fed",
  "federal reserve",
  "rate hike",
  "rate cut",
  "interest rate",
  "sec",
  "lawsuit",
  "sued",
  "hack",
  "exploit",
  "breach",
  "etf approval",
  "etf approved",
  "war",
  "sanction",
  "emergency",
  "bankrupt",
  "collapse",
  "fraud",
  "indict",
  "seized",
  "outage",
];
const MEDIUM_KEYWORDS = [
  "regulation",
  "regulator",
  "congress",
  "senate",
  "election",
  "central bank",
  "listing",
  "delist",
  "etf",
  "stablecoin",
  "treasury",
  "tariff",
];

function wordRe(words) {
  return new RegExp(`\\b(${words.join("|")})\\b`, "i");
}
const HIGH_RE = wordRe(HIGH_KEYWORDS);
const MEDIUM_RE = wordRe(MEDIUM_KEYWORDS);

const ASSET_PATTERNS = [
  ["BTC", /\b(btc|bitcoin)\b/i],
  ["ETH", /\b(eth|ethereum|ether)\b/i],
  ["SOL", /\b(sol|solana)\b/i],
  ["XRP", /\b(xrp|ripple)\b/i],
  ["DOGE", /\b(doge|dogecoin)\b/i],
  ["ADA", /\b(ada|cardano)\b/i],
  ["LINK", /\b(chainlink)\b|\bLINK\b/], // "link" alone is too common a word
];

function tagImpact(title) {
  if (HIGH_RE.test(title)) return "high";
  if (MEDIUM_RE.test(title)) return "medium";
  return "low";
}

function tagAssets(title) {
  const assets = [];
  for (const [sym, re] of ASSET_PATTERNS) {
    if (re.test(title)) assets.push(sym);
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function toIso(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalizeItem(raw, source) {
  const title = (raw.title || "").trim();
  if (!title) return null;
  return {
    title,
    source,
    link: raw.link || null,
    publishedAt: toIso(raw.isoDate || raw.pubDate),
    impact: tagImpact(title),
    assets: tagAssets(title),
  };
}

export async function getNews() {
  const now = Date.now();
  if (now - lastFetch < NEWS_TTL && cache.items.length) {
    return { ...cache, note: NOTE };
  }

  const settled = await Promise.allSettled(
    FEEDS.map((f) => parser.parseURL(f.url))
  );

  const items = [];
  const seen = new Set();
  settled.forEach((result, idx) => {
    if (result.status !== "fulfilled") return;
    const feedItems = result.value?.items || [];
    for (const raw of feedItems.slice(0, 25)) {
      const item = normalizeItem(raw, FEEDS[idx].source);
      if (!item) continue;
      const dedupeKey = item.link || `${item.source}:${item.title}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push(item);
    }
  });

  lastFetch = now;

  if (items.length) {
    items.sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    cache = {
      items: items.slice(0, 40),
      updatedAt: new Date().toISOString(),
    };
  } else if (!cache.items.length) {
    // Total failure and no last-good data: honest empty result.
    cache = { items: [], updatedAt: new Date().toISOString() };
  }
  // If items.length === 0 but we have an old cache, keep serving the old
  // cache (stale news beats no news) — updatedAt stays as-is.

  return { ...cache, note: NOTE };
}
