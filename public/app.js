'use strict';
/* =====================================================================
   Crypto Signals — frontend app (vanilla JS, no build step)
   Sections:
     1. Config & helpers
     2. Access gate
     3. Symbols & dashboard
     4. Signals panel
     5. Pattern overlay chart
     6. TradingView embed
     7. Rainbow chart (BTC cycles)
     8. EMA ribbon chart
     9. Paper trading (simulated)
    10. News feed
    11. PWA install, disclosures, service worker, init
   ===================================================================== */

/* ---------- 1. Config & helpers ---------- */
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'FLR', 'XLM', 'HBAR', 'SHX'];
const apiSym = (s) => s + '-USD';
// TradingView exchange overrides for symbols not on Coinbase.
const TV_EXCHANGE = { SHX: 'KRAKEN:SHXUSD' };
const tvSym = (s) => TV_EXCHANGE[s] || ('COINBASE:' + s + 'USD');
const LS_UNLOCKED = 'cs_unlocked';
const LS_PAPER = 'cs_paper';
const LS_PAPER_LEV = 'cs_paper_lev';
const LS_DISCLOSURE = 'cs_disclosure';
const REFRESH_MS = 10000;

const $ = (id) => document.getElementById(id);
/* Loading placeholders only on first paint: refreshes keep the last good
   content on screen instead of flashing "Loading…" every cycle. */
function loadingOnce(el, html) {
  if (el && !el.dataset.loaded) el.innerHTML = html;
}
function markLoaded(el) { if (el) el.dataset.loaded = '1'; }
const state = { symbol: 'BTC', prices: {}, lastSignals: null, deferredPrompt: null, paperSide: 'LONG' };

/* ---------- chart intervals ---------- */
const INTERVALS = [
  { label: '30m', g: 1800 },
  { label: '1h', g: 3600 },
  { label: '12h', g: 43200 },
  { label: '24h', g: 86400 },
  { label: '1w', g: 604800 },
  { label: '30d', g: 2592000 },
];
const LS_PATTERN_G = 'cs_pattern_g', LS_RIBBON_G = 'cs_ribbon_g';
function savedInterval(key) {
  const v = Number(localStorage.getItem(key));
  return INTERVALS.some((i) => i.g === v) ? v : 3600;
}
state.patternG = savedInterval(LS_PATTERN_G);
state.ribbonG = savedInterval(LS_RIBBON_G);
state.paperLev = Math.min(50, Math.max(1, Number(localStorage.getItem(LS_PAPER_LEV)) || 1));
function renderIntervalBar(elId, currentG, onPick) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '';
  INTERVALS.forEach(({ label, g }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'interval-btn' + (g === currentG ? ' active' : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(g === currentG));
    b.addEventListener('click', () => { if (g !== currentG) onPick(g); });
    el.appendChild(b);
  });
}

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  const a = Math.abs(p);
  const d = a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 6;
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtNum(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtSigned(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '−') + '$' + fmtNum(Math.abs(n), d).replace('$', '');
}
function msOf(t) { // normalize epoch seconds or ms, or ISO string, to ms
  if (t == null) return Date.now();
  if (typeof t === 'string') { const p = Date.parse(t); return isNaN(p) ? Date.now() : p; }
  return t > 1e12 ? t : t * 1000;
}
function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
  return Math.floor(d / 30) + 'mo ago';
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}
function esc(s) { // minimal HTML escape for interpolated strings
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Crisp canvas: scale backing store by devicePixelRatio, return {ctx,w,h} in CSS px. */
function fitCanvas(canvas) {
  const hCss = parseInt(canvas.getAttribute('height') || '320', 10);
  canvas.style.height = hCss + 'px';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(50, canvas.clientWidth);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hCss * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hCss);
  return { ctx, w, h: hCss };
}

/* ---------- 2. Access gate ---------- */
function isUnlocked() { return localStorage.getItem(LS_UNLOCKED) === '1'; }
function showApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  if (!localStorage.getItem(LS_DISCLOSURE)) $('disclosure-banner').hidden = false;
}
function initGate() {
  if (isUnlocked()) { showApp(); return; }
  $('gate').hidden = false;
  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('gate-code').value.trim();
    $('gate-error').hidden = true;
    if (!code) return;
    try {
      const data = await fetchJson('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (data && data.valid) {
        localStorage.setItem(LS_UNLOCKED, '1');
        showApp();
        bootApp();
      } else {
        $('gate-error').hidden = false;
      }
    } catch (err) {
      $('gate-error').textContent = 'Could not reach the server — please try again.';
      $('gate-error').hidden = false;
    }
  });
}
$('disclosure-dismiss').addEventListener('click', () => {
  localStorage.setItem(LS_DISCLOSURE, '1');
  $('disclosure-banner').hidden = true;
});

/* ---------- 3. Coins & dashboard ---------- */
const COIN_META = {
  BTC:  { name: 'Bitcoin',   color: '#f7931a' },
  ETH:  { name: 'Ethereum',  color: '#627eea' },
  SOL:  { name: 'Solana',    color: '#9945ff' },
  XRP:  { name: 'XRP Ledger', color: '#25a9e0' },
  DOGE: { name: 'Dogecoin',  color: '#c2a63e' },
  ADA:  { name: 'Cardano',   color: '#2b5cff' },
  LINK: { name: 'Chainlink', color: '#4a6fe3' },
  FLR:  { name: 'Flare',     color: '#e8416c' },
  XLM:  { name: 'Stellar',   color: '#09b6e3' },
  HBAR: { name: 'Hedera',    color: '#00b5b8' },
  SHX:  { name: 'Stronghold', color: '#3b82f6' },
};
const coinRows = {}; // sym -> {btn, price, chg}: rows built once, updated in place
function renderCoinList() {
  const list = $('coin-list');
  if (!list) return;
  if (!list.dataset.built) {
    list.innerHTML = '';
    SYMBOLS.forEach((s) => {
      const meta = COIN_META[s] || { name: s, color: '#8b98ab' };
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'coin-row';
      b.setAttribute('role', 'option');
      b.innerHTML =
        '<span class="coin-badge" style="--coin:' + meta.color + '">' + esc(s) + '</span>' +
        '<span class="coin-names"><span class="coin-name">' + esc(meta.name) + '</span>' +
        '<span class="coin-ticker">' + esc(s) + ' / USD</span></span>' +
        '<span class="coin-figures"><span class="coin-price mono">—</span>' +
        '<span class="coin-chg">—</span></span>';
      b.addEventListener('click', () => setSymbol(s));
      list.appendChild(b);
      coinRows[s] = {
        btn: b,
        price: b.querySelector('.coin-price'),
        chg: b.querySelector('.coin-chg'),
      };
    });
    list.dataset.built = '1';
  }
  // In-place update: no innerHTML rebuild, so taps never get swallowed
  // mid-refresh and scroll position is untouched.
  SYMBOLS.forEach((s) => {
    const r = coinRows[s];
    if (!r) return;
    const p = state.prices[apiSym(s)];
    const up = p && p.change24hPct >= 0;
    r.btn.classList.toggle('active', s === state.symbol);
    r.btn.setAttribute('aria-selected', String(s === state.symbol));
    r.price.textContent = p ? fmtPrice(p.price) : '—';
    r.chg.textContent = p ? (up ? '▲ +' : '▼ ') + fmtNum(p.change24hPct) + '%' : '—';
    r.chg.className = 'coin-chg ' + (p ? (up ? 'up' : 'down') : '');
  });
}
function setSymbol(s) {
  if (state.symbol === s) return;
  state.symbol = s;
  renderCoinList();
  refreshDashboard();
  refreshSignals();
  refreshPatterns();
  refreshRibbon();
  loadRainbow(s);
  loadTradingView();
  renderPaperForm();
}
async function refreshPrices() {
  try {
    const data = await fetchJson('/api/prices');
    state.prices = data.prices || {};
    renderCoinList();
  } catch (err) {
    // Don't wipe a good list on a transient failure; only complain if
    // nothing has ever rendered.
    const list = $('coin-list');
    if (list && !list.dataset.built) list.innerHTML = '<div class="empty-state">Could not load prices. Check your connection and press Refresh.</div>';
  }
  // keep paper-trading "open at" price fresh
  const cur = state.prices[apiSym(state.symbol)];
  const at = $('paper-at');
  if (at) at.textContent = cur ? fmtPrice(cur.price) : '—';
  markPositions();
}
function refreshDashboard() { refreshPrices(); }

/* ---------- 4. Signals panel ---------- */
let signalsReq = 0;
async function refreshSignals() {
  // Same sequence guard as patterns: only the latest request may render.
  const req = ++signalsReq;
  const list = $('signal-list');
  loadingOnce(list, '<div class="empty-state">Loading signals…</div>');
  try {
    const data = await fetchJson('/api/signals?symbol=' + encodeURIComponent(apiSym(state.symbol)));
    if (req !== signalsReq) return; // superseded by a newer request
    state.lastSignals = data;
    renderRegime(data.regime);
    renderRsi(data.rsi);
    renderLevels(data);
    renderSignalCards(data.signals);
    voiceCheckSignals(data);
    voiceCheckLevels(data);
  } catch (err) {
    if (req !== signalsReq) return; // superseded by a newer request
    loadingOnce(list, '<div class="empty-state">Could not load signals. Check your connection and try again.</div>');
  }
}
function renderRegime(regime) {
  const el = $('regime-banner');
  if (!regime || !regime.label) { el.innerHTML = 'Market regime: <b>unknown</b>'; return; }
  el.innerHTML = '<span class="regime-label">' + esc(regime.label) + '</span>' +
    (regime.note ? '<div class="regime-note">' + esc(regime.note) + '</div>' : '');
}
function renderRsi(rsi) {
  const v = rsi && isFinite(rsi.value) ? rsi.value : null;
  $('rsi-value').textContent = v == null ? '—' : fmtNum(v, 1);
  const fill = $('rsi-fill'), st = $('rsi-state');
  if (v == null) { fill.style.width = '0%'; fill.className = 'rsi-fill'; st.textContent = '—'; return; }
  fill.style.width = Math.min(100, Math.max(0, v)) + '%';
  let cls, label;
  if (v >= 70) { cls = 'overbought'; label = 'Overbought (≥70) — momentum is stretched'; }
  else if (v <= 30) { cls = 'oversold'; label = 'Oversold (≤30) — momentum is washed out'; }
  else { cls = 'neutral'; label = 'Neutral (30–70)'; }
  fill.className = 'rsi-fill ' + cls;
  st.className = 'rsi-state ' + cls;
  st.textContent = label + (rsi.state && rsi.state !== label ? ' · ' + rsi.state : '');
}
function renderLevels(data) {
  $('sr-res').textContent = fmtPrice(data.resistance);
  $('sr-sup').textContent = fmtPrice(data.support);
  $('sr-cur').textContent = fmtPrice(data.price);
}
function renderSignalCards(signals) {
  const list = $('signal-list');
  list.innerHTML = '';
  markLoaded(list);
  if (!signals || !signals.length) {
    list.innerHTML = '<div class="empty-state">No fresh signals — market is consolidating.</div>';
    return;
  }
  signals.forEach((sg) => {
    const type = (sg.type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const card = document.createElement('div');
    card.className = 'signal-card ' + type.toLowerCase();
    let conf = sg.confidence;
    if (isFinite(conf) && conf <= 1) conf = conf * 100;
    const comps = sg.components || {};
    const compHtml = ['pattern', 'volume', 'rsi', 'news'].map((k) => {
      const v = comps[k];
      if (v == null || v === '') return '';
      const txt = typeof v === 'object' ? esc(JSON.stringify(v)) : esc(v);
      return '<div class="comp"><b>' + k + '</b>' + txt + '</div>';
    }).join('');
    card.innerHTML =
      '<div class="sig-top"><span class="badge ' + type.toLowerCase() + '">' + type + '</span>' +
      '<span class="sig-price mono">' + fmtPrice(sg.price) + '</span>' +
      '<span class="sig-time">' + esc(fmtDate(msOf(sg.time))) + '</span></div>' +
      '<div class="conf-bar"><div class="conf-fill" style="width:' + Math.min(100, Math.max(0, conf || 0)) + '%"></div></div>' +
      '<div class="conf-label mono">confidence ' + (isFinite(conf) ? fmtNum(conf, 0) + '%' : '—') +
      (sg.horizon ? ' · horizon: ' + esc(sg.horizon) : '') + '</div>' +
      (sg.rationale ? '<p class="sig-rationale">' + esc(sg.rationale) + '</p>' : '') +
      (compHtml ? '<div class="sig-components">' + compHtml + '</div>' : '');
    list.appendChild(card);
  });
}

/* ---------- 4b. Voice assistant (human phrasebook voice) ----------
   Pre-generated human voice clips (public/voice/*.mp3) stitched gaplessly
   with Web Audio. Speaks only when something NEW happens for the selected
   coin: a fresh BUY/SELL signal, a newly detected pattern, or a
   support/resistance break. State is tracked on every refresh so enabling
   mid-session never reads stale news, and nothing repeats while unchanged.
   Falls back to the device's speech engine if the phrasebook can't load. */
const LS_VOICE = 'cs_voice_on';
const VOICE_BASE = 'voice/';
let voiceOn = false;
let voiceCtx = null;
let voiceMaster = null;
let voiceBuffers = {};   // slug -> AudioBuffer
let voiceReady = false;
let voiceLoadPromise = null;
let voiceUseTTS = false; // fallback flag
let voiceSeqQueue = [];  // queued slug-arrays
let voicePlaying = false;
let voiceLast = { sig: null, pat: null, zone: null };

const VOICE_COIN_SLUG = {
  BTC: 'coin-bitcoin', ETH: 'coin-ethereum', SOL: 'coin-solana', XRP: 'coin-xrp',
  DOGE: 'coin-dogecoin', ADA: 'coin-cardano', LINK: 'coin-chainlink', FLR: 'coin-flare',
  XLM: 'coin-stellar', HBAR: 'coin-hedera', SHX: 'coin-stronghold',
};
const VOICE_PAT_SLUG = {
  'Ascending Triangle': 'pat-ascending-triangle', 'Bear Pennant': 'pat-bear-pennant',
  'Bull Pennant': 'pat-bull-pennant', 'Descending Triangle': 'pat-descending-triangle',
  'Double Bottom': 'pat-double-bottom', 'Double Top': 'pat-double-top',
  'Falling Wedge': 'pat-falling-wedge', 'Head and Shoulders': 'pat-head-and-shoulders',
  'Inverse Head and Shoulders': 'pat-inverse-head-and-shoulders', 'Rectangle': 'pat-rectangle',
  'Rising Wedge': 'pat-rising-wedge', 'Symmetrical Triangle': 'pat-symmetrical-triangle',
};
// Integer -> clip slugs, British style ("one hundred and twenty").
function numWords(n) {
  n = Math.floor(Math.abs(n));
  const out = [];
  const under1000 = (x) => {
    const a = [];
    if (x >= 100) {
      a.push('n-' + Math.floor(x / 100), 'n-hundred');
      x %= 100;
      if (x) a.push('n-and');
    }
    if (x >= 20) {
      const t = Math.floor(x / 10) * 10, u = x % 10;
      a.push('n-' + t);
      if (u) a.push('n-' + u);
    } else if (x > 0 || !a.length) {
      a.push('n-' + x);
    }
    return a;
  };
  if (n >= 1000000) {
    const m = Math.floor(n / 1000000), r = n % 1000000;
    out.push.apply(out, under1000(m).concat(['n-million']));
    if (r) { if (r < 100) out.push('n-and'); out.push.apply(out, numWords(r)); }
    return out;
  }
  if (n >= 1000) {
    const t = Math.floor(n / 1000), r = n % 1000;
    out.push.apply(out, under1000(t).concat(['n-thousand']));
    if (r) { if (r < 100) out.push('n-and'); out.push.apply(out, under1000(r)); }
    return out;
  }
  return under1000(n);
}
// Price -> clip slugs. >= $1: dollars and cents; sub-dollar: spoken in cents
// ("forty-two point five five cents"), the way traders say it.
function priceWords(p) {
  p = Number(p);
  if (!isFinite(p) || p < 0) return [];
  if (p >= 1) {
    let d = Math.floor(p), c = Math.round((p - d) * 100);
    if (c === 100) { d += 1; c = 0; }
    const out = numWords(d).concat([d === 1 ? 'n-dollar' : 'n-dollars']);
    if (c > 0) out.push('n-and'), out.push.apply(out, numWords(c)), out.push(c === 1 ? 'n-cent' : 'n-cents');
    return out;
  }
  const cents = Math.round(p * 10000) / 100;
  const ci = Math.floor(cents);
  let frac = String(Math.round((cents - ci) * 100)).padStart(2, '0').replace(/0$/, '');
  const out = numWords(ci);
  if (frac) {
    out.push('n-point');
    for (const ch of frac) out.push('n-' + ch);
  }
  out.push(ci === 1 && !frac ? 'n-cent' : 'n-cents');
  return out;
}
function granSlugs(g) {
  switch (g) {
    case 1800: return ['n-30', 'w-minute', 'w-chart'];
    case 3600: return ['n-1', 'w-hour', 'w-chart'];
    case 43200: return ['n-12', 'w-hour', 'w-chart'];
    case 86400: return ['w-daily', 'w-chart'];
    case 604800: return ['w-weekly', 'w-chart'];
    case 2592000: return ['n-30', 'w-day', 'w-chart'];
    default: return [];
  }
}
function voiceLoad() {
  if (voiceLoadPromise) return voiceLoadPromise;
  voiceLoadPromise = (async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('no webaudio');
    voiceCtx = new AC();
    voiceMaster = voiceCtx.createGain();
    voiceMaster.connect(voiceCtx.destination);
    const slugs = new Set([
      'ph-new-buy', 'ph-new-sell', 'ph-forming-on', 'ph-broke-above', 'ph-broke-below',
      'ph-online', 'w-at', 'w-chart', 'w-minute', 'w-hour', 'w-day', 'w-daily', 'w-weekly',
      'n-hundred', 'n-thousand', 'n-million', 'n-and',
      'n-dollar', 'n-dollars', 'n-cent', 'n-cents', 'n-point',
    ]);
    for (let i = 0; i < 20; i++) slugs.add('n-' + i);
    for (let t = 20; t <= 90; t += 10) slugs.add('n-' + t);
    Object.values(VOICE_COIN_SLUG).forEach((s) => slugs.add(s));
    Object.values(VOICE_PAT_SLUG).forEach((s) => slugs.add(s));
    await Promise.all([...slugs].map(async (s) => {
      const res = await fetch(VOICE_BASE + s + '.mp3');
      if (!res.ok) throw new Error('missing clip ' + s);
      voiceBuffers[s] = await voiceCtx.decodeAudioData(await res.arrayBuffer());
    }));
    voiceReady = true;
    return true;
  })().catch(() => { voiceUseTTS = true; return false; });
  return voiceLoadPromise;
}
// Device speech fallback (only if the phrasebook fails to load).
let ttsBusy = false;
const ttsQueue = [];
function ttsSay(text) {
  if (!('speechSynthesis' in window)) return;
  ttsQueue.push(text);
  const pump = () => {
    if (ttsBusy || !ttsQueue.length) return;
    ttsBusy = true;
    const u = new SpeechSynthesisUtterance(ttsQueue.shift());
    u.rate = 1.02; u.pitch = 0.9;
    const done = () => { ttsBusy = false; setTimeout(pump, 300); };
    u.onend = done; u.onerror = done;
    try { speechSynthesis.speak(u); } catch (e) { done(); }
  };
  pump();
}
function voiceEnqueue(slugs) {
  voiceSeqQueue.push(slugs);
  voicePumpSeq();
}
function voicePumpSeq() {
  if (voicePlaying || !voiceSeqQueue.length || !voiceOn) return;
  if (!voiceReady) {
    voiceLoad().then((ok) => { if (ok && voiceOn) voicePumpSeq(); });
    return;
  }
  voicePlaying = true;
  const seq = voiceSeqQueue.shift();
  let t = voiceCtx.currentTime + 0.06;
  seq.forEach((s) => {
    const buf = voiceBuffers[s];
    if (!buf) return;
    const src = voiceCtx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1.12; // brisker pace
    src.connect(voiceMaster);
    src.start(t);
    t += buf.duration / 1.12 + 0.02; // tight word gap; clips are silence-trimmed
  });
  const ms = Math.max(300, (t - voiceCtx.currentTime) * 1000);
  setTimeout(() => { voicePlaying = false; if (voiceOn) voicePumpSeq(); }, ms + 150);
}
// One alert = clip sequence (human voice) + plain text (TTS fallback).
function voiceAlert(slugs, text) {
  if (!voiceOn) return;
  if (voiceUseTTS) { ttsSay(text); return; }
  voiceEnqueue(slugs);
}
function voiceCoinName(s) { const m = COIN_META[s]; return (m && m.name) || s; }
function granSpoken(g) {
  const map = { 1800: '30 minute', 3600: '1 hour', 43200: '12 hour', 86400: 'daily', 604800: 'weekly', 2592000: '30 day' };
  return map[g] || '';
}
// Fresh BUY/SELL signal for the selected coin.
function voiceCheckSignals(data) {
  const coin = state.symbol;
  const sigs = (data && data.signals) || [];
  const key = coin + ':' + (sigs.length ? sigs[0].type + '|' + sigs[0].price + '|' + sigs[0].time : 'none');
  const changed = voiceLast.sig !== null && voiceLast.sig !== key;
  voiceLast.sig = key;
  if (!changed || !voiceOn || !sigs.length) return;
  const s0 = sigs[0];
  const isSell = String(s0.type || '').toUpperCase() === 'SELL';
  const coinSlug = VOICE_COIN_SLUG[coin];
  // Announce the LIVE chart price (data.price), not the signal's older
  // trigger price, so the spoken number always matches the chart on screen.
  const livePrice = isFinite(Number(data.price)) ? Number(data.price) : Number(s0.price);
  if (coinSlug) {
    voiceAlert(
      [(isSell ? 'ph-new-sell' : 'ph-new-buy'), coinSlug, 'w-at'].concat(priceWords(livePrice)),
      'New ' + (isSell ? 'Sell' : 'Buy') + ' signal on ' + voiceCoinName(coin) + ' at ' + fmtPrice(livePrice) + '.'
    );
  }
}
// Newly detected pattern for the selected coin.
function voiceCheckPatterns(patterns) {
  const coin = state.symbol;
  const names = (patterns || []).map((p) => p.name || p.label || 'pattern');
  const key = coin + ':' + state.patternG + ':' + names.join('|');
  const changed = voiceLast.pat !== null && voiceLast.pat !== key;
  voiceLast.pat = key;
  if (!changed || !voiceOn || !names.length) return;
  const patSlug = VOICE_PAT_SLUG[names[0]];
  const coinSlug = VOICE_COIN_SLUG[coin];
  if (patSlug && coinSlug) {
    voiceAlert(
      [patSlug, 'ph-forming-on', coinSlug].concat(granSlugs(state.patternG)),
      names[0] + ' forming on ' + voiceCoinName(coin) + ', ' + granSpoken(state.patternG) + ' chart.'
    );
  } else {
    ttsSay(names[0] + ' forming on ' + voiceCoinName(coin) + '.');
  }
}
// Support/resistance break transitions for the selected coin.
function voiceCheckLevels(data) {
  if (!data || !isFinite(data.price)) return;
  const coin = state.symbol;
  const zone = (data.resistance && data.price > data.resistance) ? 'above'
    : (data.support && data.price < data.support) ? 'below' : 'inside';
  const key = coin + ':' + zone;
  const changed = voiceLast.zone !== null && voiceLast.zone !== key;
  voiceLast.zone = key;
  if (!changed || !voiceOn || zone === 'inside') return;
  const coinSlug = VOICE_COIN_SLUG[coin];
  if (!coinSlug) return;
  if (zone === 'above') {
    voiceAlert(
      [coinSlug, 'ph-broke-above'].concat(priceWords(data.resistance)),
      voiceCoinName(coin) + ' broke above resistance at ' + fmtPrice(data.resistance) + '.'
    );
  } else {
    voiceAlert(
      [coinSlug, 'ph-broke-below'].concat(priceWords(data.support)),
      voiceCoinName(coin) + ' broke below support at ' + fmtPrice(data.support) + '.'
    );
  }
}
function initVoice() {
  const btn = $('voice-btn');
  if (!btn) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  const supported = !!AC || 'speechSynthesis' in window;
  voiceOn = supported && localStorage.getItem(LS_VOICE) === '1';
  const paint = () => {
    btn.textContent = voiceOn ? '🔊 Voice' : '🔇 Voice';
    btn.setAttribute('aria-pressed', String(voiceOn));
    btn.classList.toggle('on', voiceOn);
  };
  paint();
  if (!supported) { btn.disabled = true; btn.title = 'Voice not supported on this device'; return; }
  btn.addEventListener('click', () => {
    voiceOn = !voiceOn;
    try { localStorage.setItem(LS_VOICE, voiceOn ? '1' : '0'); } catch (e) {}
    if (!voiceOn) {
      voiceSeqQueue.length = 0;
      ttsQueue.length = 0;
      try { speechSynthesis.cancel(); } catch (e) {}
      if (voiceMaster) { try { voiceMaster.gain.value = 0; } catch (e) {} }
    } else if (voiceMaster) {
      try {
        voiceMaster.gain.value = 1;
        if (voiceCtx && voiceCtx.state === 'suspended') voiceCtx.resume();
      } catch (e) {}
    }
    paint();
    if (voiceOn) {
      // User gesture: safe to start audio. Greet once the phrasebook is in.
      voiceLoad().then((ok) => {
        if (!voiceOn) return;
        if (ok) voiceEnqueue(['ph-online']);
        else ttsSay('Voice alerts online.');
      });
    }
  });
  // If voice was left on, warm the phrasebook (no sound until a real event).
  if (voiceOn) voiceLoad();
}

/* ---------- Candle fetching (with history stitching) ---------- */
async function fetchCandles(symbol, granularity, maxChunks, chunkLimit) {
  maxChunks = maxChunks || 1;
  chunkLimit = Math.min(Math.max(chunkLimit || 200, 1), 1000); // server clamps limit to 1..1000
  const out = [];
  const seen = new Set();
  let end; // epoch seconds; ask for candles at/before this
  for (let i = 0; i < maxChunks; i++) {
    const q = new URLSearchParams({ symbol, granularity: String(granularity), limit: String(chunkLimit) });
    if (end !== undefined) q.set('end', String(Math.floor(end)));
    let data;
    try { data = await fetchJson('/api/candles?' + q.toString()); }
    catch (err) { break; }
    let cs = (data.candles || []).slice().sort((a, b) => a.time - b.time);
    cs = cs.filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    if (!cs.length) break;
    out.unshift(...cs); // older chunk goes in front
    const oldest = cs[0].time;
    if (end !== undefined && oldest >= end) break; // server ignored `end`; avoid duplicates loop
    end = oldest - granularity;
    if (cs.length < chunkLimit) break; // short chunk: reached the start of history
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/* ---------- 5. Pattern overlay chart ---------- */
const PC = { left: 8, right: 76, top: 12, bottom: 26 };
let patternReq = 0;
let patternDrawn = false; // keep the last chart on screen during refreshes
async function refreshPatterns() {
  // Sequence guard: tapping coins quickly fires overlapping requests; only
  // the latest response may draw, so a slow earlier coin never overwrites
  // the current one (which reads as "the overlay doesn't work").
  const req = ++patternReq;
  renderIntervalBar('pattern-intervals', state.patternG, (g) => {
    state.patternG = g;
    localStorage.setItem(LS_PATTERN_G, String(g));
    refreshPatterns();
  });
  const canvas = $('pattern-chart');
  if (!patternDrawn) {
    // First paint only: show a placeholder. On refreshes the last chart
    // stays on screen (no clear) until the new one is ready — no flicker.
    const { ctx } = fitCanvas(canvas);
    ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
    ctx.fillText('Loading candles…', 20, 40);
  }
  try {
    // The endpoint returns the exact candle window the patterns were
    // detected on, so startIndex/endIndex overlay without misalignment.
    const pat = await fetchJson('/api/patterns?symbol=' + encodeURIComponent(apiSym(state.symbol)) + '&granularity=' + state.patternG);
    if (req !== patternReq) return; // superseded by a newer request
    const candles = pat.candles || [];
    // Re-fit after the fetch: an overlapping refresh may have drawn since,
    // which would otherwise leave doubled-up gridlines and labels.
    const f = fitCanvas(canvas);
    drawPatternChart(f.ctx, f.w, f.h, candles, pat.patterns || []);
    if (candles.length) patternDrawn = true;
    renderPatternCards(pat.patterns || [], pat.note);
    voiceCheckPatterns(pat.patterns || []);
  } catch (err) {
    if (req !== patternReq) return; // superseded by a newer request
    if (patternDrawn) return; // keep the last good chart on transient errors
    const f = fitCanvas(canvas);
    f.ctx.fillStyle = '#8b98ab'; f.ctx.font = '13px sans-serif';
    f.ctx.fillText('Could not load chart data.', 20, 40);
  }
}
function drawPatternChart(ctx, w, h, candles, patterns) {
  const pw = w - PC.left - PC.right, ph = h - PC.top - PC.bottom;
  if (!candles.length) return;
  let lo = Infinity, hi = -Infinity;
  candles.forEach((c) => { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); });
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const X = (i) => PC.left + (pw * (i + 0.5)) / candles.length;
  const Y = (p) => PC.top + ph * (1 - (p - lo) / (hi - lo));
  const slot = pw / candles.length;

  // gridlines + price labels
  ctx.strokeStyle = '#1a2333'; ctx.fillStyle = '#8b98ab'; ctx.font = '11px monospace'; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4, y = Y(p);
    ctx.beginPath(); ctx.moveTo(PC.left, y); ctx.lineTo(w - PC.right, y); ctx.stroke();
    ctx.fillText(fmtPrice(p), w - PC.right + 8, y + 4);
  }
  // candles
  candles.forEach((c, i) => {
    const up = c.close >= c.open;
    const col = up ? '#00e676' : '#ff5252';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    const x = X(i);
    ctx.beginPath(); ctx.moveTo(x, Y(c.high)); ctx.lineTo(x, Y(c.low)); ctx.stroke();
    const bw = Math.max(2, slot * 0.6);
    const yO = Y(c.open), yC = Y(c.close);
    ctx.fillRect(x - bw / 2, Math.min(yO, yC), bw, Math.max(1.5, Math.abs(yC - yO)));
  });
  // pattern overlays: labels + trigger/invalidation/target lines
  // (numeric levels come from p.levels; trigger/invalidation are descriptive text)
  patterns.forEach((p, pi) => {
    const n = candles.length;
    const s = Math.max(0, Math.min(n - 1, p.startIndex | 0));
    const e = Math.max(s, Math.min(n - 1, (p.endIndex == null ? n - 1 : p.endIndex) | 0));
    const x0 = X(s) - slot / 2, x1 = X(e) + slot / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255,179,0,.08)';
    ctx.fillRect(x0, PC.top, x1 - x0, ph);
    const lines = [];
    const lv = p.levels || {};
    (Array.isArray(lv.trigger) ? lv.trigger : []).forEach((v) => lines.push({ v, col: '#00e676', tag: 'trigger' }));
    (Array.isArray(lv.invalidation) ? lv.invalidation : []).forEach((v) => lines.push({ v, col: '#ff5252', tag: 'invalidation' }));
    if (isFinite(lv.target)) lines.push({ v: lv.target, col: '#3d5afe', tag: 'target' });
    ctx.font = '11px sans-serif';
    lines.forEach((L) => {
      if (!isFinite(L.v)) return;
      const y = Y(L.v);
      if (y < PC.top || y > PC.top + ph) return;
      ctx.strokeStyle = L.col; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = L.col;
      ctx.fillText(L.tag + ' ' + fmtPrice(L.v), x1 + 4, y + 4);
    });
    ctx.fillStyle = '#ffb300';
    ctx.font = 'bold 12px sans-serif';
    // Stagger labels vertically: overlapping patterns (e.g. Rising Wedge +
    // Head and Shoulders on the same window) drew at the identical y and
    // collided into unreadable text.
    ctx.fillText(p.label || p.name || ('pattern ' + (pi + 1)), x0 + 6, PC.top + 18 + pi * 16);
    ctx.restore();
  });
}
function renderPatternCards(patterns, note) {
  const el = $('pattern-cards');
  el.innerHTML = '';
  if (!patterns.length) {
    el.innerHTML = '<div class="empty-state">No pattern detected right now.' +
      (note ? '<br><span style="font-size:12px">' + esc(note) + '</span>' : '') + '</div>';
    return;
  }
  patterns.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'pattern-card';
    d.innerHTML = '<h3>' + esc(p.name || p.label || 'Pattern') + '</h3>' +
      '<div class="pc-row"><span>Confidence</span><strong>' + esc(fmtNum(p.confidence, 0)) + '%</strong></div>' +
      '<div class="pc-row"><span>Detected</span><strong>' + esc(p.detectedAt ? fmtDate(msOf(p.detectedAt)) : '—') + '</strong></div>' +
      '<div class="pc-row"><span>Trigger</span><strong>' + esc(p.trigger || '—') + '</strong></div>' +
      '<div class="pc-row"><span>Invalidation</span><strong>' + esc(p.invalidation || '—') + '</strong></div>' +
      '<div class="pc-row"><span>Measured target</span><strong>' + fmtPrice(p.target) + '</strong></div>';
    el.appendChild(d);
  });
}

/* ---------- 6. TradingView embed ---------- */
function loadTradingView() {
  const host = $('tv-widget');
  host.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  container.style.cssText = 'height:100%;width:100%';
  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.cssText = 'height:100%;width:100%';
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.textContent = JSON.stringify({
    symbol: tvSym(state.symbol),
    theme: 'dark',
    style: '1',
    locale: 'en',
    timezone: 'Etc/UTC',
    allow_symbol_change: false,
    hide_side_toolbar: false,
    support_host: 'https://www.tradingview.com',
    backgroundColor: 'rgba(13, 18, 27, 1)',
    width: '100%',
    height: '100%',
  });
  container.appendChild(widget);
  container.appendChild(script);
  host.appendChild(container);
}

/* ---------- 7. Rainbow chart ---------- */
const RB = { left: 8, right: 78, top: 14, bottom: 28 };
// 9 bands, top→bottom, with classic rainbow palette & offsets (log10) from trend fit
const RB_BANDS = [
  { c: '#ff2b2b', lo: 1.00, hi: 0.78, name: 'Maximum bubble territory' },
  { c: '#ff7a1a', lo: 0.78, hi: 0.56, name: 'Sell. Seriously, SELL!' },
  { c: '#ffb300', lo: 0.56, hi: 0.34, name: 'FOMO intensifies' },
  { c: '#ffee58', lo: 0.34, hi: 0.12, name: 'Is this a bubble?' },
  { c: '#c6ff4d', lo: 0.12, hi: -0.10, name: 'HODL!' },
  { c: '#00e676', lo: -0.10, hi: -0.32, name: 'Still cheap' },
  { c: '#00bcd4', lo: -0.32, hi: -0.54, name: 'Accumulate' },
  { c: '#3d5afe', lo: -0.54, hi: -0.76, name: 'BUY!' },
  { c: '#7c4dff', lo: -0.76, hi: -1.00, name: 'Basically a fire sale' },
];
const rb = { candles: [], fit: null, view: [0, 0], range: 'all' };
let rbGen = 0; // loadRainbow generation guard against overlapping loads

let rainbowWired = false;
async function initRainbow() {
  if (rainbowWired) return;
  rainbowWired = true;
  const canvas = $('rainbow-chart');
  attachRainbowGestures(canvas);
  renderRainbowLegend();
  document.querySelectorAll('.range-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      setRainbowRange(b.dataset.range);
    }));
  $('rainbow-reset').addEventListener('click', () => setRainbowRange('all'));
  await loadRainbow(state.symbol);
}
async function loadRainbow(sym) {
  const canvas = $('rainbow-chart');
  const title = $('rainbow-title');
  if (title) title.textContent = sym + ' rainbow chart';
  // Generation guard: rapid symbol taps must not let an older fetch
  // draw over (or leave stale data under) a newer one.
  const gen = ++rbGen;
  const hadData = rb.candles.length > 0;
  rb.candles = []; rb.fit = null; rb.view = [0, 0]; rb.range = 'all';
  let ctx = null;
  if (!hadData) {
    // First paint only: otherwise the previous coin's chart stays on
    // screen (no clear) until the new history arrives — no flicker.
    ({ ctx } = fitCanvas(canvas));
    ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
    ctx.fillText('Loading ' + sym + ' history…', 20, 40);
  }
  try {
    // Single request for up to 1000 daily candles (~2.7 years); the server
    // stitches Coinbase's 300-candle pages internally.
    const candles = await fetchCandles(apiSym(sym), 86400, 1, 1000);
    if (gen !== rbGen) return; // superseded by a newer load
    if (candles.length < 30) throw new Error('not enough history');
    rb.candles = candles;
    rb.fit = logFit(candles);
    rb.view = [0, candles.length];
    drawRainbow();
  } catch (err) {
    if (gen !== rbGen) return;
    if (hadData) return; // keep the last good chart on transient errors
    if (!ctx) ({ ctx } = fitCanvas(canvas));
    ctx.fillStyle = '#8b98ab';
    ctx.fillText('Could not load long-term ' + sym + ' history.', 20, 40);
  }
}
function logFit(candles) {
  // least-squares fit of log10(close) against time (days)
  const n = candles.length;
  const t0 = candles[0].time;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  candles.forEach((c) => {
    const x = (c.time - t0) / 86400, y = Math.log10(Math.max(1e-9, c.close));
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  });
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return { t0, slope, intercept, at: (t) => intercept + slope * ((t - t0) / 86400) };
}
function setRainbowRange(r) {
  rb.range = r;
  const n = rb.candles.length;
  if (r === 'all') rb.view = [0, n];
  else {
    const days = parseInt(r, 10);
    const perDay = 86400 / 86400;
    rb.view = [Math.max(0, n - Math.ceil(days * perDay) - 1), n];
  }
  drawRainbow();
}
function attachRainbowGestures(canvas) {
  const pointers = new Map();
  let pan = null, pinch = null;
  canvas.style.touchAction = 'none';
  const idxAtX = (x, w) => {
    const [a, b] = rb.view;
    const pw = w - RB.left - RB.right;
    return a + ((x - RB.left) / pw) * (b - a);
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) pan = { x0: e.offsetX, a0: rb.view[0], b0: rb.view[1] };
    else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), a0: rb.view[0], b0: rb.view[1] };
      pan = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    const n = rb.candles.length, w = canvas.clientWidth;
    if (pan && pointers.size === 1) {
      const span = pan.b0 - pan.a0;
      const dxIdx = ((pan.x0 - e.offsetX) / (w - RB.left - RB.right)) * span;
      let a = Math.round(pan.a0 + dxIdx), b = Math.round(pan.b0 + dxIdx);
      const len = b - a;
      if (a < 0) { a = 0; b = len; }
      if (b > n) { b = n; a = n - len; }
      rb.view = [Math.max(0, a), Math.min(n, b)];
      drawRainbow();
    } else if (pinch && pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const ratio = pinch.d0 / d; // >1 = zoom out
      const [a0, b0] = [pinch.a0, pinch.b0];
      const mid = (a0 + b0) / 2, half = ((b0 - a0) / 2) * ratio;
      let a = Math.round(mid - half), b = Math.round(mid + half);
      if (b - a < 20) { const m = (a + b) / 2; a = Math.round(m - 10); b = Math.round(m + 10); }
      if (b - a > n) { a = 0; b = n; }
      rb.view = [Math.max(0, a), Math.min(n, b)];
      drawRainbow();
    }
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (pointers.size === 0) pan = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const n = rb.candles.length;
    const [a, b] = rb.view;
    const anchor = idxAtX(e.offsetX, canvas.clientWidth);
    const factor = Math.pow(1.0015, e.deltaY);
    let na = anchor - (anchor - a) * factor, nb = anchor + (b - anchor) * factor;
    if (nb - na < 20) { const m = (na + nb) / 2; na = m - 10; nb = m + 10; }
    if (nb - na > n) { na = 0; nb = n; }
    rb.view = [Math.max(0, Math.round(na)), Math.min(n, Math.round(nb))];
    drawRainbow();
  }, { passive: false });
}
function drawRainbow() {
  const canvas = $('rainbow-chart');
  const { ctx, w, h } = fitCanvas(canvas);
  const cs = rb.candles, fit = rb.fit;
  if (!cs.length || !fit) return;
  let [a, b] = rb.view;
  a = Math.max(0, Math.min(cs.length - 1, a)); b = Math.max(a + 2, Math.min(cs.length, b));
  const pw = w - RB.left - RB.right, ph = h - RB.top - RB.bottom;
  const X = (t) => RB.left + ((t - cs[a].time) / (cs[b - 1].time - cs[a].time || 1)) * pw;
  // visible log range: price line + band edges at view ends
  const yFitA = fit.at(cs[a].time), yFitB = fit.at(cs[b - 1].time);
  let lo = Math.min(yFitA, yFitB) - 1.05, hi = Math.max(yFitA, yFitB) + 1.05;
  cs.slice(a, b).forEach((c) => {
    const y = Math.log10(Math.max(1e-9, c.close));
    if (y < lo) lo = y; if (y > hi) hi = y;
  });
  const Y = (logp) => RB.top + ph * (1 - (logp - lo) / (hi - lo));

  // bands
  RB_BANDS.forEach((band) => {
    ctx.beginPath();
    const t0 = cs[a].time, t1 = cs[b - 1].time;
    ctx.moveTo(X(t0), Y(fit.at(t0) + band.hi));
    ctx.lineTo(X(t1), Y(fit.at(t1) + band.hi));
    ctx.lineTo(X(t1), Y(fit.at(t1) + band.lo));
    ctx.lineTo(X(t0), Y(fit.at(t0) + band.lo));
    ctx.closePath();
    ctx.fillStyle = band.c + '2e';
    ctx.fill();
  });
  // horizontal log gridlines with price labels
  ctx.font = '11px monospace'; ctx.lineWidth = 1;
  const pLo = Math.ceil(lo), pHi = Math.floor(hi);
  for (let p = pLo; p <= pHi; p++) {
    const y = Y(p);
    ctx.strokeStyle = '#1a2333';
    ctx.beginPath(); ctx.moveTo(RB.left, y); ctx.lineTo(w - RB.right, y); ctx.stroke();
    ctx.fillStyle = '#8b98ab';
    ctx.fillText('$' + Math.pow(10, p).toLocaleString('en-US'), w - RB.right + 8, y + 4);
  }
  // price line
  ctx.beginPath();
  cs.slice(a, b).forEach((c, i) => {
    const x = X(c.time), y = Y(Math.log10(Math.max(1e-9, c.close)));
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#e8edf3'; ctx.lineWidth = 2; ctx.stroke();
  // date labels
  const spanDays = (cs[b - 1].time - cs[a].time) / 86400;
  const fmt = spanDays > 730 ? (ms) => new Date(ms).getFullYear()
    : spanDays > 120 ? (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    : (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  ctx.fillStyle = '#8b98ab'; ctx.font = '11px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const t = cs[a].time + ((cs[b - 1].time - cs[a].time) * i) / 4;
    ctx.fillText(String(fmt(t * 1000)), RB.left + (pw * i) / 4 - 10, h - 8);
  }
  // band name labels along right edge
  ctx.font = '10px sans-serif';
  RB_BANDS.forEach((band) => {
    const y = Y(fit.at(cs[b - 1].time) + (band.hi + band.lo) / 2);
    if (y < RB.top + 6 || y > RB.top + ph - 4) return;
    ctx.fillStyle = band.c;
    ctx.fillText(band.name, w - RB.right + 8, Math.min(y + 3, h - RB.bottom - 2));
  });
}
function renderRainbowLegend() {
  $('rainbow-legend').innerHTML = RB_BANDS.map((b) =>
    '<span class="lg"><i style="background:' + b.c + '"></i>' + esc(b.name) + '</span>').join('');
}

/* ---------- 8. EMA ribbon chart ---------- */
const EMA_PERIODS = [8, 13, 21, 34, 55, 89];
const EMA_COLORS = ['#00e676', '#c6ff4d', '#ffee58', '#ffb300', '#ff7a1a', '#3d5afe'];
const ER = { left: 8, right: 76, top: 12, bottom: 26 };
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = null;
  values.forEach((v, i) => {
    if (i < period - 1) return;
    if (e == null) { // seed with SMA
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      e = s / period;
    } else e = v * k + e * (1 - k);
    out[i] = e;
  });
  return out;
}
let ribbonReq = 0;
let ribbonDrawn = false; // keep the last ribbon on screen during refreshes
async function initRibbon() {
  // Sequence guard: only the latest request may draw.
  const req = ++ribbonReq;
  renderIntervalBar('ribbon-intervals', state.ribbonG, (g) => {
    state.ribbonG = g;
    localStorage.setItem(LS_RIBBON_G, String(g));
    initRibbon();
  });
  const canvas = $('ribbon-chart');
  if (!ribbonDrawn) {
    // First paint only: on refreshes the last ribbon stays until the new
    // one is ready — no clear, no flicker.
    const { ctx } = fitCanvas(canvas);
    ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
    ctx.fillText('Loading EMAs…', 20, 40);
  }
  try {
    const candles = await fetchCandles(apiSym(state.symbol), state.ribbonG, 2);
    if (req !== ribbonReq) return; // superseded by a newer request
    if (!candles.length) throw new Error('no candles');
    // Re-fit after the fetch: an overlapping refresh may have drawn since.
    const f = fitCanvas(canvas);
    drawRibbon(f.ctx, f.w, f.h, candles.slice(-240));
    ribbonDrawn = true;
  } catch (err) {
    if (req !== ribbonReq) return; // superseded by a newer request
    if (ribbonDrawn) return; // keep the last good chart on transient errors
    const f = fitCanvas(canvas);
    f.ctx.fillStyle = '#8b98ab'; f.ctx.font = '13px sans-serif';
    f.ctx.fillText('Could not load EMA data.', 20, 40);
  }
}
function refreshRibbon() { initRibbon(); }
function drawRibbon(ctx, w, h, candles) {
  const pw = w - ER.left - ER.right, ph = h - ER.top - ER.bottom;
  const closes = candles.map((c) => c.close);
  const emas = EMA_PERIODS.map((p) => emaSeries(closes, p));
  const start = EMA_PERIODS[EMA_PERIODS.length - 1]; // wait for slowest EMA to warm up
  const idx = [];
  for (let i = start; i < candles.length; i++) idx.push(i);
  if (!idx.length) return;
  let lo = Infinity, hi = -Infinity;
  idx.forEach((i) => {
    lo = Math.min(lo, candles[i].low);
    hi = Math.max(hi, candles[i].high);
    emas.forEach((e) => { if (e[i] != null) { lo = Math.min(lo, e[i]); hi = Math.max(hi, e[i]); } });
  });
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const X = (k) => ER.left + (pw * (k + 0.5)) / idx.length;
  const Y = (p) => ER.top + ph * (1 - (p - lo) / (hi - lo));

  ctx.lineWidth = 1; ctx.font = '11px monospace';
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4, y = Y(p);
    ctx.strokeStyle = '#1a2333';
    ctx.beginPath(); ctx.moveTo(ER.left, y); ctx.lineTo(w - ER.right, y); ctx.stroke();
    ctx.fillStyle = '#8b98ab';
    ctx.fillText(fmtPrice(p), w - ER.right + 8, y + 4);
  }

  // ribbon cloud: fill between min and max EMA, tinted by trend
  idx.forEach((i, k) => {
    const vals = emas.map((e) => e[i]).filter((v) => v != null);
    if (!vals.length) return;
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const fast = emas[0][i], slow = emas[emas.length - 1][i];
    ctx.fillStyle = fast >= slow ? 'rgba(0,230,118,.10)' : 'rgba(255,82,82,.10)';
    const x0 = ER.left + (pw * k) / idx.length, x1 = ER.left + (pw * (k + 1)) / idx.length;
    ctx.fillRect(x0, Y(mx), x1 - x0, Y(mn) - Y(mx));
  });
  // EMA lines
  emas.forEach((e, ei) => {
    ctx.beginPath();
    idx.forEach((i, k) => { const x = X(k), y = Y(e[i]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = EMA_COLORS[ei]; ctx.globalAlpha = ei === 0 || ei === emas.length - 1 ? 0.95 : 0.45;
    ctx.lineWidth = ei === 0 ? 2 : 1.2;
    ctx.stroke(); ctx.globalAlpha = 1;
  });
  // price line
  ctx.beginPath();
  idx.forEach((i, k) => { const x = X(k), y = Y(candles[i].close); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = '#e8edf3'; ctx.lineWidth = 1.6; ctx.stroke();

  // zone-flip markers: close crosses above max(EMA) → buy zone; below min(EMA) → sell zone
  idx.forEach((i, k) => {
    if (k === 0) return;
    const prev = idx[k - 1];
    const mn = Math.min(...emas.map((e) => e[i]).filter((v) => v != null));
    const mx = Math.max(...emas.map((e) => e[i]).filter((v) => v != null));
    const pMn = Math.min(...emas.map((e) => e[prev]).filter((v) => v != null));
    const pMx = Math.max(...emas.map((e) => e[prev]).filter((v) => v != null));
    const c = candles[i].close, pc = candles[prev].close;
    const crossedUp = pc <= pMx && c > mx;
    const crossedDn = pc >= pMn && c < mn;
    if (crossedUp || crossedDn) {
      ctx.beginPath();
      ctx.arc(X(k), crossedUp ? Y(candles[i].low) + 10 : Y(candles[i].high) - 10, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = crossedUp ? '#00e676' : '#ff5252';
      ctx.fill();
    }
  });
}

/* ---------- 9. Paper trading (SIMULATED) ---------- */
function loadPaper() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_PAPER));
    // Normalize pre-leverage positions: 1x, margin = old size.
    if (d && isFinite(d.cash)) return {
      cash: d.cash,
      positions: (d.positions || []).map((p) => ({
        leverage: 1, tp: null, sl: null, ...p,
        margin: p.margin ?? p.size,
      })),
      history: d.history || [],
    };
  } catch (e) { /* fall through */ }
  return { cash: 10000, positions: [], history: [] };
}
function savePaper(p) { localStorage.setItem(LS_PAPER, JSON.stringify(p)); }
let paper = loadPaper();

function priceOf(sym) {
  const p = state.prices[apiSym(sym)];
  return p ? p.price : null;
}
function positionValue(pos) {
  const margin = pos.margin ?? pos.size ?? 0;
  return Math.max(0, margin + positionPnl(pos)); // floor at zero: liquidation caps the loss
}
function positionPnl(pos) {
  const px = priceOf(pos.symbol);
  if (px == null) return 0;
  const margin = pos.margin ?? pos.size ?? 0;
  const lev = pos.leverage || 1;
  const qty = (margin * lev) / pos.entry;
  const raw = pos.side === 'LONG' ? (px - pos.entry) * qty : (pos.entry - px) * qty;
  return Math.max(-margin, raw); // can't lose more than the margin put up
}
/** Simplified liquidation estimate: the price where losses would eat the whole margin. */
function estLiqPrice(side, entry, lev) {
  return side === 'LONG' ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
}
function liqPrice(p) { return estLiqPrice(p.side, p.entry, p.leverage || 1); }
function initPaper() {
  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.paperSide = b.dataset.side;
      renderPaperForm(); // refresh the liquidation hint for the new side
    }));
  const levInput = $('paper-lev');
  levInput.value = state.paperLev;
  const syncLev = () => {
    state.paperLev = Math.min(50, Math.max(1, Number(levInput.value) || 1));
    localStorage.setItem(LS_PAPER_LEV, String(state.paperLev));
    $('paper-lev-val').textContent = state.paperLev + 'x';
    renderPaperForm();
  };
  levInput.addEventListener('input', syncLev);
  syncLev();
  $('paper-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const size = parseFloat($('paper-size').value);
    const px = priceOf(state.symbol);
    if (!isFinite(size) || size <= 0) return;
    if (px == null) { alert('No live price yet — wait for the dashboard to load.'); return; }
    if (size > paper.cash) { alert('Not enough virtual cash for that margin.'); return; }
    const lev = state.paperLev || 1;
    const tp = parseFloat($('paper-tp').value), sl = parseFloat($('paper-sl').value);
    const hasTp = isFinite(tp) && tp > 0, hasSl = isFinite(sl) && sl > 0;
    if (hasTp && (state.paperSide === 'LONG' ? tp <= px : tp >= px)) {
      alert('Take profit must be above the entry for LONG, below it for SHORT.');
      return;
    }
    if (hasSl && (state.paperSide === 'LONG' ? sl >= px : sl <= px)) {
      alert('Stop loss must be below the entry for LONG, above it for SHORT.');
      return;
    }
    paper.cash -= size;
    paper.positions.push({
      id: 'p' + Date.now().toString(36),
      symbol: state.symbol, side: state.paperSide,
      entry: px, qty: (size * lev) / px, margin: size, leverage: lev,
      tp: hasTp ? tp : null, sl: hasSl ? sl : null,
      openedAt: Date.now(),
    });
    $('paper-size').value = '';
    $('paper-tp').value = '';
    $('paper-sl').value = '';
    savePaper(paper);
    renderPaper();
  });
  $('paper-reset').addEventListener('click', () => {
    if (!confirm('Reset paper account to $10,000 virtual? This clears positions and history.')) return;
    paper = { cash: 10000, positions: [], history: [] };
    savePaper(paper);
    renderPaper();
  });
  renderPaper();
}
function renderPaperForm() {
  const cur = state.prices[apiSym(state.symbol)];
  const px = cur ? cur.price : null;
  $('paper-at').textContent = px ? fmtPrice(px) : '—';
  const lev = state.paperLev || 1;
  $('paper-liq').textContent = px
    ? 'Est. liquidation @ ' + lev + 'x ' + state.paperSide + ': ' + fmtPrice(estLiqPrice(state.paperSide, px, lev))
    : '';
}
function markPositions() { // light refresh of live P&L numbers on price ticks
  if ($('app').hidden) return;
  checkPaperTriggers(); // auto-close on TP / SL / liquidation
  // With no positions or history the panel is static — rebuilding its DOM
  // every 10s is pure jank. (checkPaperTriggers ran first, so a fresh
  // auto-close still renders via the history it just wrote.)
  if (paper.positions.length || paper.history.length) renderPaper();
}
/** Close positions whose take-profit, stop-loss, or liquidation level was hit. */
function checkPaperTriggers() {
  if (!paper.positions.length) return;
  for (const p of [...paper.positions]) {
    const px = priceOf(p.symbol);
    if (px == null) continue;
    const liq = liqPrice(p);
    let reason = null;
    if (p.side === 'LONG') {
      if (px <= liq) reason = 'Liquidated';
      else if (p.sl && px <= p.sl) reason = 'Stop loss';
      else if (p.tp && px >= p.tp) reason = 'Take profit';
    } else {
      if (px >= liq) reason = 'Liquidated';
      else if (p.sl && px >= p.sl) reason = 'Stop loss';
      else if (p.tp && px <= p.tp) reason = 'Take profit';
    }
    if (reason) closePosition(p.id, reason);
  }
}
function renderPaper() {
  const openPnl = paper.positions.reduce((s, p) => s + positionPnl(p), 0);
  const equity = paper.cash + paper.positions.reduce((s, p) => s + positionValue(p), 0);
  $('paper-cash').textContent = fmtPrice(paper.cash);
  const opEl = $('paper-openpnl');
  opEl.textContent = fmtSigned(openPnl);
  opEl.className = 'mono ' + (openPnl >= 0 ? 'pnl-up' : 'pnl-down');
  $('paper-equity').textContent = fmtPrice(equity);

  const posEl = $('paper-positions');
  posEl.innerHTML = '';
  if (!paper.positions.length) posEl.innerHTML = '<div class="empty-state">No open positions. Open a simulated LONG or SHORT above.</div>';
  paper.positions.forEach((p) => {
    const pnl = positionPnl(p), px = priceOf(p.symbol);
    const lev = p.leverage || 1;
    const detLine = '<span style="color:var(--muted);font-size:12px">' + lev + 'x' +
      (p.tp ? ' · TP <span class="mono">' + fmtPrice(p.tp) + '</span>' : '') +
      (p.sl ? ' · SL <span class="mono">' + fmtPrice(p.sl) + '</span>' : '') +
      ' · Liq <span class="mono">' + fmtPrice(liqPrice(p)) + '</span></span>';
    const row = document.createElement('div');
    row.className = 'pos-row';
    row.innerHTML =
      '<span class="side-' + p.side + '">' + p.side + '</span>' +
      '<span class="grow"><b>' + esc(p.symbol) + '</b> · ' + fmtNum(p.qty, 6) + ' @ <span class="mono">' + fmtPrice(p.entry) + '</span><br>' +
      '<span style="color:var(--muted);font-size:12px">now <span class="mono">' + fmtPrice(px) + '</span> · ' + timeAgo(p.openedAt) + '</span><br>' +
      detLine + '</span>' +
      '<span class="mono ' + (pnl >= 0 ? 'pnl-up' : 'pnl-down') + '">' + fmtSigned(pnl) + '</span>';
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Close';
    btn.addEventListener('click', () => closePosition(p.id));
    row.appendChild(btn);
    posEl.appendChild(row);
  });

  const hEl = $('paper-history');
  hEl.innerHTML = '';
  if (!paper.history.length) hEl.innerHTML = '<div class="empty-state">No closed trades yet.</div>';
  paper.history.slice(0, 50).forEach((t) => {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML =
      '<span class="side-' + t.side + '">' + t.side + '</span>' +
      '<span class="grow"><b>' + esc(t.symbol) + '</b> <span class="mono">' + fmtPrice(t.entry) + ' → ' + fmtPrice(t.exit) + '</span><br>' +
      '<span style="color:var(--muted);font-size:12px">' + fmtDate(t.openedAt) + ' → ' + fmtDate(t.closedAt) +
      (t.reason && t.reason !== 'Manual' ? ' · ' + esc(t.reason) : '') + '</span></span>' +
      '<span class="mono ' + (t.pnl >= 0 ? 'pnl-up' : 'pnl-down') + '">' + fmtSigned(t.pnl) + '</span>';
    hEl.appendChild(row);
  });
}
function closePosition(id, reason) {
  const i = paper.positions.findIndex((p) => p.id === id);
  if (i < 0) return;
  const p = paper.positions[i];
  const px = priceOf(p.symbol);
  if (px == null) { alert('No live price — cannot close right now.'); return; }
  const val = positionValue(p);
  const pnl = positionPnl(p);
  paper.cash += val;
  paper.history.unshift({ ...p, exit: px, closedAt: Date.now(), pnl, reason: reason || 'Manual' });
  if (paper.history.length > 200) paper.history.length = 200; // cap: localStorage hygiene
  paper.positions.splice(i, 1);
  savePaper(paper);
  renderPaper();
}

/* ---------- 10. News feed ---------- */
async function refreshNews() {
  const el = $('news-list');
  loadingOnce(el, '<div class="empty-state">Loading news…</div>');
  try {
    const data = await fetchJson('/api/news');
    const items = data.items || [];
    $('news-updated').textContent = data.updatedAt ? 'Updated ' + timeAgo(msOf(data.updatedAt)) : '';
    el.innerHTML = '';
    markLoaded(el);
    if (!items.length) { el.innerHTML = '<div class="empty-state">No news items right now.</div>'; return; }
    items.forEach((n) => {
      const d = document.createElement('div');
      d.className = 'news-item';
      const tags = (n.assets || []).map((a) => '<span class="asset-tag">' + esc(a) + '</span>').join('');
      d.innerHTML =
        '<h3><a href="' + esc(n.link) + '" target="_blank" rel="noopener">' + esc(n.title) + '</a></h3>' +
        '<div class="news-meta"><span class="impact ' + esc(n.impact || 'low') + '">' + esc(n.impact || 'low') + '</span>' +
        tags +
        '<span>' + esc(n.source || '') + (n.publishedAt ? ' · ' + timeAgo(msOf(n.publishedAt)) : '') + '</span></div>';
      el.appendChild(d);
    });
  } catch (err) {
    loadingOnce(el, '<div class="empty-state">Could not load news. Check your connection and try again.</div>');
  }
}

/* ---------- 11. PWA install, SW, init ---------- */
function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    $('install-btn').hidden = false;
    $('install-now').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null;
    $('install-btn').hidden = true;
  });
  $('install-btn').addEventListener('click', () => { $('install-modal').hidden = false; });
  $('install-close').addEventListener('click', () => { $('install-modal').hidden = true; });
  $('install-modal').addEventListener('click', (e) => { if (e.target === $('install-modal')) $('install-modal').hidden = true; });
  $('install-now').addEventListener('click', async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    $('install-now').hidden = true;
  });
  // show topbar install button as info entry even without prompt (opens instructions)
  if ($('install-btn').hidden) {
    // keep hidden until prompt OR allow manual open on mobile where no prompt fires:
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) $('install-btn').hidden = false;
  }
}
function initSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell optional */ });
    });
  }
}

let booted = false;
/* ---------- collapsible window panels ---------- */
const PANEL_KEY = 'cs_panels';
function loadPanelState() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) || '{}'); } catch (e) { return {}; }
}
function savePanelState(st) {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(st)); } catch (e) {}
}
function redrawPanel(id) {
  // Charts drawn while collapsed measure 0px; re-render after expanding.
  if (id === 'patterns') refreshPatterns();
  else if (id === 'rainbow') { if (rb.candles.length) drawRainbow(); }
  else if (id === 'ribbon') initRibbon();
}
function setPanelCollapsed(sec, collapsed, st) {
  const was = sec.classList.contains('collapsed');
  sec.classList.toggle('collapsed', collapsed);
  st[sec.id] = collapsed;
  savePanelState(st);
  if (was && !collapsed) redrawPanel(sec.id);
  syncCollapseAllBtn(st);
}
function syncCollapseAllBtn(st) {
  const btn = $('collapse-all');
  if (!btn) return;
  const secs = [...document.querySelectorAll('main.wrap section.card')];
  const anyOpen = secs.some((s) => !s.classList.contains('collapsed'));
  btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
}
function initPanels() {
  const st = loadPanelState();
  const secs = [...document.querySelectorAll('main.wrap section.card')];
  secs.forEach((sec) => {
    if (st[sec.id]) sec.classList.add('collapsed');
    const head = sec.querySelector('.card-head');
    if (!head) return;
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', String(!sec.classList.contains('collapsed')));
    const toggle = (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return; // let controls work
      setPanelCollapsed(sec, !sec.classList.contains('collapsed'), st);
      head.setAttribute('aria-expanded', String(!sec.classList.contains('collapsed')));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
    });
  });
  const btn = $('collapse-all');
  if (btn) btn.addEventListener('click', () => {
    const anyOpen = secs.some((s) => !s.classList.contains('collapsed'));
    secs.forEach((sec) => {
      const head = sec.querySelector('.card-head');
      setPanelCollapsed(sec, anyOpen, st);
      if (head) head.setAttribute('aria-expanded', String(!anyOpen));
    });
  });
  // Jumping to a collapsed section from the nav expands it first.
  document.querySelectorAll('.section-nav a[href^="#"]').forEach((a) => {
    a.addEventListener('click', () => {
      const sec = document.getElementById(a.getAttribute('href').slice(1));
      if (sec && sec.classList.contains('collapsed')) {
        const head = sec.querySelector('.card-head');
        setPanelCollapsed(sec, false, st);
        if (head) head.setAttribute('aria-expanded', 'true');
      }
    });
  });
  syncCollapseAllBtn(st);
}

/* Logo intro animation: plays once when the app opens. */
function playLogoIntro() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const brand = $('brand'), word = $('brand-word');
  if (!brand || !word || brand.dataset.introDone) return;
  brand.dataset.introDone = '1';
  let i = 0;
  const splitNode = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === 3) {
        const frag = document.createDocumentFragment();
        Array.from(child.textContent).forEach((ch) => {
          const s = document.createElement('span');
          s.className = 'bl';
          s.textContent = ch === ' ' ? '\u00A0' : ch;
          s.style.animationDelay = (200 + i * 35) + 'ms';
          i++;
          frag.appendChild(s);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1) splitNode(child);
    });
  };
  splitNode(word);
  // add the class after paint so the animation starts from its 0% keyframe
  requestAnimationFrame(() => requestAnimationFrame(() => brand.classList.add('logo-intro')));
}

function bootApp() {
  if (booted) return;
  booted = true;
  playLogoIntro();
  initPanels();
  renderCoinList();
  renderPaperForm();
  refreshPrices();
  refreshSignals();
  refreshPatterns();
  loadTradingView();
  initRainbow();
  initRibbon();
  refreshNews();
  initPaper();
  initVoice();
  $('refresh-btn').addEventListener('click', () => {
    refreshPrices(); refreshSignals(); refreshPatterns(); refreshRibbon(); refreshNews();
  });
  setInterval(() => { refreshPrices(); }, REFRESH_MS);       // 10s price auto-refresh
  setInterval(() => { refreshSignals(); refreshNews(); }, 120000); // slower cycle for signals/news
  // Debounced: on mobile the address bar showing/hiding fires resize in
  // bursts; without this each burst re-fetched pattern + ribbon candles
  // and flashed "Loading…" over the charts.
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      refreshPatterns();
      if (rb.candles.length) drawRainbow();
      initRibbon();
    }, 300);
  });
}

/* ---------- entry ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initGate();
  initInstall();
  initSW();
  if (isUnlocked()) bootApp();
});
