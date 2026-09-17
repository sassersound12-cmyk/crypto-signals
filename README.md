# Crypto Signals — Public App

A standalone, publicly-deployable crypto signals web app. One Node.js + Express
server serves the frontend and a small JSON API. **No API keys required** — market
data comes from the free Coinbase public API, news from free RSS feeds, charts
from the TradingView embed.

> **Not financial advice.** Signals are rule-based observations of past price
> action, never predictions or guarantees. Paper trading is simulated with
> virtual money only — this app can never place real orders.

## Features

- Live prices (Coinbase): BTC, ETH, SOL, XRP, DOGE, ADA, LINK
- Rule-based BUY/SELL signals — BUY on resistance break with volume confirmation
  and candle CLOSE above; SELL on close below support. Closed candles only.
- RSI (14) with overbought/oversold/neutral states
- BTC-vs-altcoin market regime (BTC-led / Altcoin season / Risk-off / Mixed)
- Market-moving news scanner (CoinDesk + Cointelegraph RSS) with impact level
  and affected-asset tags
- Transparent rationale per signal (pattern + volume + RSI + news, horizon,
  confidence). Deterministic signals are visually distinct from outlook wording.
- Live TradingView chart embed (follows the selected symbol)
- Automatic chart-pattern overlays on closed candles: double tops/bottoms,
  head & shoulders, wedges, triangles, pennants, rectangles — with trigger,
  invalidation, measured target, confidence. Honest "no pattern" state.
- Rainbow cycle chart: log-scale bands, 30D / 1Y / ALL ranges, drag-pan +
  wheel/pinch zoom, reset zoom
- Multi-EMA ribbon (8/13/21/34/55/89) with BUY/SELL zone-flip markers
- Paper-trading portfolio (localStorage): virtual longs/shorts, live
  mark-to-market, per-trade and total P&L, trade history. Clearly SIMULATED.
- PWA: manifest, 192/512px icons, offline-shell service worker, in-app install
  prompt with browser-specific fallback instructions
- Access-code gate: buyers enter a code after paying; unlock persists in
  localStorage

## Run locally

```bash
npm install
npm start          # serves on http://localhost:3000 (or $PORT)
```

## Access codes (for $2 buyers)

Mint a code and email it to the buyer manually after their Stripe payment:

```bash
npm run gen-code            # prints a new code, e.g. XXXX-XXXX
npm run gen-code -- --list  # list codes
npm run gen-code -- --revoke XXXX-XXXX
```

Codes live in `data/codes.json` (git-ignored). The app's gate screen POSTs to
`/api/verify`; valid codes unlock the app and the unlock persists in the
browser's localStorage. (Stripe-webhook auto-issuing is a planned later phase.)

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/prices` | 7 symbols: price + 24h change |
| `GET /api/candles?symbol=BTC-USD&granularity=3600&limit=200[&end=<unix sec>]` | Closed candles, ascending. `end` pages older history (for the rainbow chart). |
| `GET /api/signals?symbol=BTC-USD` | RSI, support/resistance, signals with rationales, regime |
| `GET /api/patterns?symbol=BTC-USD` | Detected chart patterns (often empty — by design) |
| `GET /api/news` | Tagged news items (impact high/medium/low, assets) |
| `POST /api/verify` `{code}` | Access-code check → `{valid:true/false}` |

Granularities: 60, 300, 900, 3600, 21600, 86400.

## Deploy

The app is a single Node process on one `$PORT` — it deploys anywhere.

**Render (free tier):**
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Render sets `$PORT` automatically. Free tier sleeps when idle (~30s cold start).

**Railway:**
1. `npm i -g @railway/cli && railway init` in this folder (or connect the GitHub repo in the dashboard).
2. Deploy — Railway sets `$PORT`; start command `npm start` is auto-detected.

**VPS (e.g. Hetzner/DigitalOcean, ~$5/mo):**
```bash
# on the server (Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git
git clone <your-repo> crypto-signals && cd crypto-signals
npm install --omit=dev
# run persistently:
npm i -g pm2 && pm2 start server.js --name crypto-signals && pm2 save
# optional: put Caddy/Nginx in front for HTTPS
```

Then point the sales page / Stripe confirmation at the deployed URL.

## Project layout

```
server.js            Express app (static ./public + API)
lib/
  prices.js          Coinbase public API: ticker/stats/candles, closed-candle filter
  signals.js         RSI, swing S/R, BUY/SELL break rules, regime
  patterns.js        12 conservative geometric pattern detectors
  news.js            RSS fetch + impact/asset tagging
  codes.js           access-code store (data/codes.json)
scripts/gen-code.js  mint/list/revoke access codes
public/
  index.html / styles.css / app.js   the app
  manifest.json / sw.js / icons/     PWA packaging
data/codes.json      access codes (git-ignored, created at runtime)
```

## Notes & simplifications

- Rainbow bands are fixed ±1.0 log10 offsets around a least-squares log-price
  trend fit — a standard interpretation of the classic rainbow chart.
- Pattern detectors are deliberately conservative; an empty result ("no pattern
  detected") is the honest common case, not an error.
- Signal history is re-derived from recent candles on each poll and deduped
  per break event in memory (a server restart re-derives the same recent
  signals — no duplicates shown).
- In-memory caches: prices 30s, candles 60s, signals/patterns 5min, news
  10min. If Coinbase/RSS is unreachable, last-good data is served where
  available.
