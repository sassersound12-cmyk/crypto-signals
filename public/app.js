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
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK'];
const apiSym = (s) => s + '-USD';
const tvSym = (s) => 'COINBASE:' + s + 'USD';
const LS_UNLOCKED = 'cs_unlocked';
const LS_PAPER = 'cs_paper';
const LS_DISCLOSURE = 'cs_disclosure';
const REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);
const state = { symbol: 'BTC', prices: {}, lastSignals: null, deferredPrompt: null, paperSide: 'LONG' };

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

/* ---------- 3. Symbols & dashboard ---------- */
function renderPills() {
  const nav = $('symbol-pills');
  nav.innerHTML = '';
  SYMBOLS.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'pill' + (s === state.symbol ? ' active' : '');
    b.textContent = s;
    b.addEventListener('click', () => setSymbol(s));
    nav.appendChild(b);
  });
}
function setSymbol(s) {
  if (state.symbol === s) return;
  state.symbol = s;
  renderPills();
  refreshDashboard();
  refreshSignals();
  refreshPatterns();
  loadRainbow(s);
  loadTradingView();
  renderPaperForm();
}
async function refreshPrices() {
  try {
    const data = await fetchJson('/api/prices');
    state.prices = data.prices || {};
    renderTickers(data.updatedAt);
  } catch (err) {
    $('ticker-grid').innerHTML = '<div class="empty-state">Could not load prices. Check your connection and press Refresh.</div>';
  }
}
function renderTickers(updatedAt) {
  $('dash-symbol').textContent = state.symbol;
  const cur = state.prices[apiSym(state.symbol)];
  $('dash-price').textContent = cur ? fmtPrice(cur.price) : '—';
  const chg = $('dash-change');
  if (cur && isFinite(cur.change24hPct)) {
    chg.textContent = (cur.change24hPct >= 0 ? '▲ +' : '▼ ') + fmtNum(cur.change24hPct) + '%';
    chg.className = 'chg-pill mono ' + (cur.change24hPct >= 0 ? 'up' : 'down');
  } else { chg.textContent = '—'; chg.className = 'chg-pill mono'; }
  $('dash-updated').textContent = updatedAt ? 'Updated ' + timeAgo(msOf(updatedAt)) : '';

  const grid = $('ticker-grid');
  grid.innerHTML = '';
  SYMBOLS.forEach((s) => {
    const p = state.prices[apiSym(s)];
    const b = document.createElement('button');
    b.className = 'ticker';
    const up = p && p.change24hPct >= 0;
    b.innerHTML =
      '<div class="tk-sym">' + esc(s) + '/USD</div>' +
      '<div class="tk-price">' + (p ? fmtPrice(p.price) : '—') + '</div>' +
      '<div class="tk-chg ' + (up ? 'up' : 'down') + '">' + (p ? (up ? '+' : '') + fmtNum(p.change24hPct) + '%' : '—') + '</div>';
    b.addEventListener('click', () => setSymbol(s));
    grid.appendChild(b);
  });
  // keep paper-trading "open at" price fresh
  $('paper-at').textContent = cur ? fmtPrice(cur.price) : '—';
  markPositions();
}
function refreshDashboard() { refreshPrices(); }

/* ---------- 4. Signals panel ---------- */
async function refreshSignals() {
  const list = $('signal-list');
  list.innerHTML = '<div class="empty-state">Loading signals…</div>';
  try {
    const data = await fetchJson('/api/signals?symbol=' + encodeURIComponent(apiSym(state.symbol)));
    state.lastSignals = data;
    renderRegime(data.regime);
    renderRsi(data.rsi);
    renderLevels(data);
    renderSignalCards(data.signals);
  } catch (err) {
    list.innerHTML = '<div class="empty-state">Could not load signals. Check your connection and try again.</div>';
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

/* ---------- candle fetching (with history stitching) ---------- */
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
async function refreshPatterns() {
  const canvas = $('pattern-chart');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
  ctx.fillText('Loading candles…', 20, 40);
  try {
    // The endpoint returns the exact candle window the patterns were
    // detected on, so startIndex/endIndex overlay without misalignment.
    const pat = await fetchJson('/api/patterns?symbol=' + encodeURIComponent(apiSym(state.symbol)));
    const candles = pat.candles || [];
    // Re-fit after the fetch: an overlapping refresh may have drawn since,
    // which would otherwise leave doubled-up gridlines and labels.
    const f = fitCanvas(canvas);
    drawPatternChart(f.ctx, f.w, f.h, candles, pat.patterns || []);
    renderPatternCards(pat.patterns || [], pat.note);
  } catch (err) {
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
    ctx.fillText(p.label || p.name || ('pattern ' + (pi + 1)), x0 + 6, PC.top + 18);
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
  const { ctx, w, h } = fitCanvas(canvas);
  const title = $('rainbow-title');
  if (title) title.textContent = sym + ' rainbow chart';
  // Generation guard: rapid symbol taps must not let an older fetch
  // draw over (or leave stale data under) a newer one.
  const gen = ++rbGen;
  rb.candles = []; rb.fit = null; rb.view = [0, 0]; rb.range = 'all';
  ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
  ctx.fillText('Loading ' + sym + ' history…', 20, 40);
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
async function initRibbon() {
  const canvas = $('ribbon-chart');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#8b98ab'; ctx.font = '13px sans-serif';
  ctx.fillText('Loading EMAs…', 20, 40);
  try {
    const candles = await fetchCandles(apiSym(state.symbol), 3600, 2);
    if (!candles.length) throw new Error('no candles');
    // Re-fit after the fetch: an overlapping refresh may have drawn since.
    const f = fitCanvas(canvas);
    drawRibbon(f.ctx, f.w, f.h, candles.slice(-240));
  } catch (err) {
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
    if (d && isFinite(d.cash)) return { cash: d.cash, positions: d.positions || [], history: d.history || [] };
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
  const px = priceOf(pos.symbol);
  if (px == null) return pos.size;
  return pos.side === 'LONG' ? pos.qty * px : pos.size + (pos.entry - px) * pos.qty;
}
function positionPnl(pos) {
  const px = priceOf(pos.symbol);
  if (px == null) return 0;
  return pos.side === 'LONG' ? (px - pos.entry) * pos.qty : (pos.entry - px) * pos.qty;
}
function initPaper() {
  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.paperSide = b.dataset.side;
    }));
  $('paper-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const size = parseFloat($('paper-size').value);
    const px = priceOf(state.symbol);
    if (!isFinite(size) || size <= 0) return;
    if (px == null) { alert('No live price yet — wait for the dashboard to load.'); return; }
    if (size > paper.cash) { alert('Not enough virtual cash for that size.'); return; }
    paper.cash -= size;
    paper.positions.push({
      id: 'p' + Date.now().toString(36),
      symbol: state.symbol, side: state.paperSide,
      entry: px, qty: size / px, size,
      openedAt: Date.now(),
    });
    $('paper-size').value = '';
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
  $('paper-at').textContent = cur ? fmtPrice(cur.price) : '—';
}
function markPositions() { // light refresh of live P&L numbers on price ticks
  if ($('app').hidden) return;
  renderPaper();
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
    const row = document.createElement('div');
    row.className = 'pos-row';
    row.innerHTML =
      '<span class="side-' + p.side + '">' + p.side + '</span>' +
      '<span class="grow"><b>' + esc(p.symbol) + '</b> · ' + fmtNum(p.qty, 6) + ' @ <span class="mono">' + fmtPrice(p.entry) + '</span><br>' +
      '<span style="color:var(--muted);font-size:12px">now <span class="mono">' + fmtPrice(px) + '</span> · ' + timeAgo(p.openedAt) + '</span></span>' +
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
      '<span style="color:var(--muted);font-size:12px">' + fmtDate(t.openedAt) + ' → ' + fmtDate(t.closedAt) + '</span></span>' +
      '<span class="mono ' + (t.pnl >= 0 ? 'pnl-up' : 'pnl-down') + '">' + fmtSigned(t.pnl) + '</span>';
    hEl.appendChild(row);
  });
}
function closePosition(id) {
  const i = paper.positions.findIndex((p) => p.id === id);
  if (i < 0) return;
  const p = paper.positions[i];
  const px = priceOf(p.symbol);
  if (px == null) { alert('No live price — cannot close right now.'); return; }
  const val = positionValue(p);
  const pnl = positionPnl(p);
  paper.cash += val;
  paper.history.unshift({ ...p, exit: px, closedAt: Date.now(), pnl });
  paper.positions.splice(i, 1);
  savePaper(paper);
  renderPaper();
}

/* ---------- 10. News feed ---------- */
async function refreshNews() {
  const el = $('news-list');
  el.innerHTML = '<div class="empty-state">Loading news…</div>';
  try {
    const data = await fetchJson('/api/news');
    const items = data.items || [];
    $('news-updated').textContent = data.updatedAt ? 'Updated ' + timeAgo(msOf(data.updatedAt)) : '';
    el.innerHTML = '';
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
    el.innerHTML = '<div class="empty-state">Could not load news. Check your connection and try again.</div>';
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
function bootApp() {
  if (booted) return;
  booted = true;
  renderPills();
  renderPaperForm();
  refreshPrices();
  refreshSignals();
  refreshPatterns();
  loadTradingView();
  initRainbow();
  initRibbon();
  refreshNews();
  initPaper();
  $('refresh-btn').addEventListener('click', () => {
    refreshPrices(); refreshSignals(); refreshPatterns(); refreshRibbon(); refreshNews();
  });
  setInterval(() => { refreshPrices(); }, REFRESH_MS);       // 30s price auto-refresh
  setInterval(() => { refreshSignals(); refreshNews(); }, 120000); // slower cycle for signals/news
  window.addEventListener('resize', () => {
    refreshPatterns();
    if (rb.candles.length) drawRainbow();
    initRibbon();
  });
}

/* ---------- entry ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initGate();
  initInstall();
  initSW();
  if (isUnlocked()) bootApp();
});
