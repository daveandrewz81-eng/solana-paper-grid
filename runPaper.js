/**
 * runPaper.js — DARK LADDER UI + % GRID (ASYMMETRIC) + MORE RELIABLE PRICE
 * ----------------------------------------------------------------------
 * This is a full rewrite of the script you tried, BUT with the key fix:
 * ✅ Price fetching is hardened for Render (CG first + Binance fallback + JUP + optional Birdeye)
 * ✅ Longer timeouts + retry/backoff so it actually boots and sets Anchor/NOW
 *
 * Strategy changes you asked for:
 * ✅ #1 Percent spacing (not $0.50)
 * ✅ #2 Asymmetric spacing (buys wider, sells tighter)
 *
 * UI:
 * ✅ Dark ladder layout (guard/packets + NOW + last trades + ladder)
 *
 * Run:
 *   node runPaper.js
 *
 * Render:
 *   Start command: node runPaper.js
 *   Uses PORT env if present, else 3000.
 *
 * Optional ENV:
 *   BIRDEYE_API_KEY=xxxx
 */

import axios from "axios";
import http from "http";
import fs from "fs";

// =====================
// CONFIG
// =====================
const TIMEOUT_MS = 25_000;          // was 15s; Render often needs longer
const TICK_MS = 30_000;
const UI_REFRESH_HINT_MS = 3000;

// Packets (capacity)
const BUY_PACKETS = 6;
const SELL_PACKETS = 6;

// Ladder depth shown
const LEVELS_EACH_SIDE = 10;

// ✅ Your chosen improvements
const BUY_STEP_PCT = 0.008;   // 0.8% between buy rungs (wider)
const SELL_STEP_PCT = 0.006;  // 0.6% between sell rungs (tighter)

// Order sizing (paper)
const ORDER_NOTIONAL_USD = 25;

// Starting balances
const START_USD = 1000;
const START_SOL = 0;

// Sim slippage (paper)
const SIM_SLIPPAGE_PCT = 0.0;

// Web server
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Persistence
const STATE_FILE = "./paper_state_dark.json";

// =====================
// PRICE SOURCES
// =====================
// Jupiter quote (SOL -> USDC)
const JUP_URL = "https://quote-api.jup.ag/v6/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// CoinGecko (public)
const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Binance (public) — SOLUSDT ~ USD, very reliable on hosts
const BINANCE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT";

// Birdeye (optional)
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const BIRDEYE_URL =
  "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112";

// Axios instance
const ax = axios.create({
  timeout: TIMEOUT_MS,
  headers: { "User-Agent": "paper-grid/1.1", Accept: "application/json" },
});

// =====================
// STATE
// =====================
let anchor = null;
let nowPrice = null;
let priceSource = "N/A";
let lastTickAt = 0;
let lastPriceError = ""; // show something useful in /status if it fails

let openPositions = []; // [{ id, entryPrice, qtySol, costUsd, openedAt }]
let trades = [];        // last 10 trades [{ ts, side, price, qtySol, pnlUsd? }]

let ladderBuys = [];    // [{ price, state:'WAIT'|'FILLED' }]
let ladderSells = [];   // [{ price, state:'WAIT'|'FILLED' }]

let balances = { usd: START_USD, sol: START_SOL };

let stats = {
  trades: 0,
  buys: 0,
  sells: 0,
  realizedPnlUsd: 0,
  avgEntry: null,
};

let nextId = 1;

// =====================
// UTIL
// =====================
function iso() {
  return new Date().toISOString();
}
function round(n, dp = 2) {
  if (!Number.isFinite(n)) return n;
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}
function fmt(n, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : "—";
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================
// SAVE / LOAD
// =====================
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    anchor = s.anchor ?? anchor;
    nowPrice = s.nowPrice ?? nowPrice;
    priceSource = s.priceSource ?? priceSource;
    lastTickAt = s.lastTickAt ?? lastTickAt;
    lastPriceError = s.lastPriceError ?? lastPriceError;

    openPositions = Array.isArray(s.openPositions) ? s.openPositions : openPositions;
    trades = Array.isArray(s.trades) ? s.trades : trades;

    ladderBuys = Array.isArray(s.ladderBuys) ? s.ladderBuys : ladderBuys;
    ladderSells = Array.isArray(s.ladderSells) ? s.ladderSells : ladderSells;

    balances = s.balances ?? balances;
    stats = s.stats ?? stats;
    nextId = s.nextId ?? nextId;

    console.log(iso(), "STATE_LOADED");
  } catch (e) {
    console.log(iso(), "STATE_LOAD_FAILED", e?.message || e);
  }
}

function saveState() {
  try {
    const s = {
      anchor,
      nowPrice,
      priceSource,
      lastTickAt,
      lastPriceError,
      openPositions,
      trades,
      ladderBuys,
      ladderSells,
      balances,
      stats,
      nextId,
      savedAt: Date.now(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.log(iso(), "STATE_SAVE_FAILED", e?.message || e);
  }
}

// =====================
// PRICE FETCHERS
// =====================
async function fetchPriceFromCoinGecko() {
  const r = await ax.get(CG_URL);
  const p = Number(r?.data?.solana?.usd);
  if (!Number.isFinite(p) || p <= 0) throw new Error("CoinGecko returned bad price");
  return p;
}

async function fetchPriceFromBinance() {
  const r = await ax.get(BINANCE_URL);
  const p = Number(r?.data?.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Binance returned bad price");
  return p; // USDT ~ USD
}

async function fetchPriceFromJupiter() {
  const inAmount = "1000000000"; // 1 SOL in lamports
  const params = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount,
    swapMode: "ExactIn",
    slippageBps: 50,
  };
  const r = await ax.get(JUP_URL, { params });
  const outAmount = Number(r?.data?.outAmount); // USDC 6 decimals
  if (!Number.isFinite(outAmount) || outAmount <= 0) throw new Error("Jupiter returned bad outAmount");
  return outAmount / 1e6;
}

async function fetchPriceFromBirdeye() {
  if (!BIRDEYE_API_KEY) throw new Error("No Birdeye key set");
  const r = await ax.get(BIRDEYE_URL, {
    headers: { "X-API-KEY": BIRDEYE_API_KEY },
  });
  const p = Number(r?.data?.data?.value);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Birdeye returned bad price");
  return p;
}

/**
 * Render-friendly price fetch:
 * - Prefer CoinGecko first (often works when JUP flakes)
 * - Then Binance (very reliable)
 * - Then Jupiter
 * - Then Birdeye (if key provided)
 * Includes retry/backoff.
 */
async function fetchSolPriceRobust() {
  const sources = [
    { name: "CG", fn: fetchPriceFromCoinGecko },
    { name: "BINANCE", fn: fetchPriceFromBinance },
    { name: "JUP", fn: fetchPriceFromJupiter },
    ...(BIRDEYE_API_KEY ? [{ name: "BIRDEYE", fn: fetchPriceFromBirdeye }] : []),
  ];

  // Retry rounds (fast then slightly slower)
  const backoffs = [0, 800, 1600];

  let lastErr = null;
  for (const waitMs of backoffs) {
    if (waitMs) await sleep(waitMs);

    for (const s of sources) {
      try {
        const price = await s.fn();
        return { price, source: s.name };
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error("All sources failed");
}

// =====================
// LADDER BUILD (PCT + ASYMMETRIC)
// =====================
function buildLadder(a) {
  const buys = [];
  const sells = [];

  for (let i = 1; i <= LEVELS_EACH_SIDE; i++) {
    buys.push({ price: a * (1 - BUY_STEP_PCT * i), state: "WAIT" });
    sells.push({ price: a * (1 + SELL_STEP_PCT * i), state: "WAIT" });
  }

  // Closest to anchor first
  buys.sort((x, y) => y.price - x.price);
  sells.sort((x, y) => x.price - y.price);

  return { buys, sells };
}

function ensureLadder() {
  if (!anchor) return;
  if (!ladderBuys.length || !ladderSells.length) {
    const { buys, sells } = buildLadder(anchor);
    ladderBuys = buys;
    ladderSells = sells;
  }
}

// =====================
// PACKETS / GUARD
// =====================
function openCount() {
  return openPositions.length;
}
function guardBlocksBuyNext() {
  // blocks BUY when open+1 > sell packets
  return (openCount() + 1) > SELL_PACKETS;
}

// =====================
// POSITION / PNL
// =====================
function recomputeAvgEntry() {
  if (!openPositions.length) {
    stats.avgEntry = null;
    return;
  }
  const totalQty = openPositions.reduce((s, p) => s + p.qtySol, 0);
  const totalCost = openPositions.reduce((s, p) => s + p.costUsd, 0);
  stats.avgEntry = totalQty > 0 ? (totalCost / totalQty) : null;
}
function breakeven() {
  return stats.avgEntry; // ignoring fees for paper
}

// =====================
// PAPER EXECUTION
// =====================
function placeBuyAtPrice(fillPrice) {
  const qtySol = ORDER_NOTIONAL_USD / fillPrice;
  const costUsd = qtySol * fillPrice;

  if (balances.usd < costUsd) return false;
  if (openCount() >= BUY_PACKETS) return false;
  if (guardBlocksBuyNext()) return false;

  balances.usd -= costUsd;
  balances.sol += qtySol;

  openPositions.push({
    id: nextId++,
    entryPrice: fillPrice,
    qtySol,
    costUsd,
    openedAt: Date.now(),
  });

  stats.trades++;
  stats.buys++;

  trades.unshift({ ts: Date.now(), side: "BUY", price: fillPrice, qtySol });
  trades = trades.slice(0, 10);

  recomputeAvgEntry();
  return true;
}

function placeSellAtPrice(fillPrice) {
  if (!openPositions.length) return false;

  // Close oldest (FIFO-ish)
  const pos = openPositions.shift();
  const qtySol = pos.qtySol;

  if (balances.sol < qtySol) {
    openPositions.unshift(pos);
    return false;
  }

  const proceedsUsd = qtySol * fillPrice;
  balances.sol -= qtySol;
  balances.usd += proceedsUsd;

  const pnl = proceedsUsd - pos.costUsd;
  stats.realizedPnlUsd += pnl;

  stats.trades++;
  stats.sells++;

  trades.unshift({ ts: Date.now(), side: "SELL", price: fillPrice, qtySol, pnlUsd: pnl });
  trades = trades.slice(0, 10);

  recomputeAvgEntry();
  return true;
}

function simulateFills() {
  if (!nowPrice || !anchor) return;
  ensureLadder();

  // BUY fills (closest outward)
  for (const rung of ladderBuys) {
    if (rung.state === "FILLED") continue;
    if (nowPrice <= rung.price) {
      const fillPrice = rung.price * (1 + SIM_SLIPPAGE_PCT);
      const ok = placeBuyAtPrice(fillPrice);
      if (ok) rung.state = "FILLED";
      else break;
    }
  }

  // SELL fills
  for (const rung of ladderSells) {
    if (rung.state === "FILLED") continue;
    if (nowPrice >= rung.price) {
      const fillPrice = rung.price * (1 - SIM_SLIPPAGE_PCT);
      const ok = placeSellAtPrice(fillPrice);
      if (ok) rung.state = "FILLED";
      else break;
    }
  }
}

// =====================
// STATUS
// =====================
function portfolioValueUsd() {
  if (!Number.isFinite(nowPrice)) return null;
  return balances.usd + balances.sol * nowPrice;
}

function statusObj() {
  const drift = (anchor && nowPrice) ? (Math.abs(nowPrice - anchor) / anchor) : null;
  const pv = portfolioValueUsd();

  return {
    ts: Date.now(),
    iso: iso(),
    nowPrice,
    priceSource,
    anchor,
    drift,
    lastPriceError,

    config: {
      BUY_PACKETS,
      SELL_PACKETS,
      LEVELS_EACH_SIDE,
      BUY_STEP_PCT,
      SELL_STEP_PCT,
      ORDER_NOTIONAL_USD,
      TICK_MS,
    },

    balances,
    stats: {
      ...stats,
      openPositions: openCount(),
      buyPackets: BUY_PACKETS,
      sellPackets: SELL_PACKETS,
      guard: "blocks BUY when open+1 > sell packets",
      guardBlocked: guardBlocksBuyNext(),
      breakeven: breakeven(),
      portfolioValueUsd: pv,
    },

    ladder: { buys: ladderBuys, sells: ladderSells },
    trades,
  };
}

// =====================
// DARK UI HTML
// =====================
function html() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Paper Grid Ladder</title>
  <style>
    :root{
      --bg:#0b1220;
      --card:#0f1a2e;
      --muted:rgba(255,255,255,.65);
      --line:rgba(255,255,255,.08);
      --good:#2ee59d;
      --warn:#ffcc66;
      --bad:#ff5c7a;
      --txt:#e9eefc;
    }
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(1200px 700px at 20% 10%, rgba(60,120,255,.18), transparent 60%),
                  radial-gradient(900px 600px at 90% 30%, rgba(46,229,157,.14), transparent 60%),
                  var(--bg);
      color: var(--txt);
    }
    .wrap{ max-width: 1020px; margin: 0 auto; padding: 16px; }
    h1{ font-size: 18px; margin: 0 0 10px; opacity: .95; }
    .pill{
      display:inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      margin-left: 8px;
    }
    .pill.good{ color: var(--good); border-color: rgba(46,229,157,.35); }
    .pill.bad{ color: var(--bad); border-color: rgba(255,92,122,.35); }

    .grid{
      display:grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 12px;
      align-items:start;
    }
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.04), transparent 40%), var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
    }
    .row{ display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
    .k{ font-size: 12px; color: var(--muted); }
    .v{ font-size: 20px; font-weight: 800; letter-spacing: .2px; }
    .sub{ font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.4; }

    .mid{
      text-align:center;
      padding: 16px 8px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(46,229,157,.07), rgba(60,120,255,.06));
    }
    .mid .big{ font-size: 26px; font-weight: 900; margin-top: 6px; }
    .mid .small{ font-size: 12px; color: var(--muted); margin-top: 6px; }

    .list .item{
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,.02);
      padding: 10px;
      margin-top: 8px;
    }
    .sidebuy{ color: var(--good); font-weight: 900; }
    .sidesell{ color: var(--warn); font-weight: 900; }
    .pnl{ font-weight: 900; }
    .pnl.pos{ color: var(--good); }
    .pnl.neg{ color: var(--bad); }

    .ladder{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }
    .coltitle{ font-size: 12px; color: var(--muted); margin: 2px 0 8px; }
    .rung{
      display:flex; justify-content:space-between; align-items:center;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      margin-bottom: 8px;
      background: rgba(255,255,255,.02);
    }
    .state{
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
    }
    .state.filled{ color: var(--good); border-color: rgba(46,229,157,.35); }
    .price{ font-weight: 800; }

    a{ color: var(--muted); text-decoration:none; }
    .footer{ margin-top: 10px; font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Paper Grid Ladder <span class="pill" id="matchPill">…</span></h1>

    <div class="grid">
      <div class="card">
        <div class="row">
          <div>
            <div class="k">Trades</div>
            <div class="v" id="trades">—</div>
          </div>
          <div>
            <div class="k">Buys / Sells</div>
            <div class="v"><span id="buys">—</span> / <span id="sells">—</span></div>
          </div>
        </div>

        <div class="sub">
          Open positions: <b id="openPos">—</b><br/>
          Sell packets: <b id="sellPackets">—</b> · Buy packets: <b id="buyPackets">—</b><br/>
          Guard: <span id="guardText">—</span>
        </div>

        <div class="sub">
          Avg entry: <b id="avgEntry">—</b> · Breakeven: <b id="breakeven">—</b><br/>
          USD: <b id="usd">—</b> · SOL: <b id="sol">—</b> · PV: <b id="pv">—</b>
        </div>
      </div>

      <div class="mid">
        <div class="k">NOW</div>
        <div class="big" id="now">—</div>
        <div class="small" id="anchorLine">Anchor: — • Steps: —</div>
        <div class="small" id="driftLine">Drift: — · src: —</div>
        <div class="small" id="errLine" style="opacity:.85;"></div>
      </div>

      <div class="card list">
        <div class="k">Last 10 trades</div>
        <div id="tradeList"></div>
      </div>
    </div>

    <div class="card" style="margin-top:12px;">
      <div class="k">Ladder (fixed levels; colour/state changes)</div>
      <div class="sub">Percent steps: BUY wider / SELL tighter. (Anchor is fixed in this version.)</div>

      <div class="ladder">
        <div>
          <div class="coltitle">BUY (wider, ${(BUY_STEP_PCT * 100).toFixed(2)}% steps)</div>
          <div id="buyCol"></div>
        </div>
        <div>
          <div class="coltitle">SELL (tighter, ${(SELL_STEP_PCT * 100).toFixed(2)}% steps)</div>
          <div id="sellCol"></div>
        </div>
      </div>

      <div class="footer">
        JSON endpoint: <a href="/status">/status</a> · Refresh hint: ${UI_REFRESH_HINT_MS / 1000}s
      </div>
    </div>
  </div>

<script>
  const fmt = (n, dp=2) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(dp) : '—';
  const money = (n) => (typeof n === 'number' && isFinite(n)) ? ('$' + n.toFixed(2)) : '—';

  function rungHtml(p, state){
    const st = state === 'FILLED' ? 'filled' : '';
    return \`
      <div class="rung">
        <div class="price">\${fmt(p, 2)}</div>
        <div class="state \${st}">\${state}</div>
      </div>\`;
  }

  function tradeHtml(t){
    const sideClass = t.side === 'BUY' ? 'sidebuy' : 'sidesell';
    const pnl = (typeof t.pnlUsd === 'number') ? t.pnlUsd : null;
    const pnlClass = pnl == null ? '' : (pnl >= 0 ? 'pos' : 'neg');

    return \`
      <div class="item">
        <div class="row">
          <div class="\${sideClass}">\${t.side}</div>
          <div class="k">\${new Date(t.ts).toLocaleTimeString()}</div>
        </div>
        <div class="row" style="margin-top:6px;">
          <div>Price: <b>\${fmt(t.price, 2)}</b></div>
          <div>Qty: <b>\${fmt(t.qtySol, 6)}</b></div>
        </div>
        \${pnl == null ? '' : \`<div class="row" style="margin-top:6px;">
          <div class="k">PnL</div>
          <div class="pnl \${pnlClass}">\${money(pnl)}</div>
        </div>\`}
      </div>\`;
  }

  async function refresh(){
    const r = await fetch('/status', { cache: 'no-store' });
    const s = await r.json();

    document.getElementById('trades').innerText = s.stats.trades ?? '—';
    document.getElementById('buys').innerText = s.stats.buys ?? '—';
    document.getElementById('sells').innerText = s.stats.sells ?? '—';
    document.getElementById('openPos').innerText = s.stats.openPositions ?? '—';
    document.getElementById('sellPackets').innerText = s.stats.sellPackets ?? '—';
    document.getElementById('buyPackets').innerText = s.stats.buyPackets ?? '—';

    const blocked = !!s.stats.guardBlocked;
    document.getElementById('guardText').innerText =
      (s.stats.guard || '—') + (blocked ? ' (BLOCKING)' : '');

    document.getElementById('avgEntry').innerText =
      (typeof s.stats.avgEntry === 'number') ? fmt(s.stats.avgEntry, 2) : '—';
    document.getElementById('breakeven').innerText =
      (typeof s.stats.breakeven === 'number') ? fmt(s.stats.breakeven, 2) : '—';

    document.getElementById('usd').innerText = money(s.balances.usd);
    document.getElementById('sol').innerText = fmt(s.balances.sol, 6);
    document.getElementById('pv').innerText = money(s.stats.portfolioValueUsd);

    const matched = (s.stats.sellPackets >= s.stats.openPositions);
    const pill = document.getElementById('matchPill');
    pill.className = 'pill ' + (matched ? 'good' : 'bad');
    pill.innerText = matched ? '✅ Matched: sells can cover open positions' : '⚠ Not matched';

    document.getElementById('now').innerText = fmt(s.nowPrice, 2);
    document.getElementById('anchorLine').innerText =
      'Anchor: ' + fmt(s.anchor, 2) + ' • Steps: ' +
      (s.config.BUY_STEP_PCT*100).toFixed(2) + '% / ' +
      (s.config.SELL_STEP_PCT*100).toFixed(2) + '%';

    document.getElementById('driftLine').innerText =
      'Drift: ' + ((typeof s.drift === 'number') ? (s.drift*100).toFixed(2)+'%' : '—') +
      ' · src: ' + (s.priceSource || '—');

    document.getElementById('errLine').innerText =
      s.lastPriceError ? ('Last price error: ' + s.lastPriceError) : '';

    const buyCol = document.getElementById('buyCol');
    const sellCol = document.getElementById('sellCol');
    buyCol.innerHTML = (s.ladder.buys || []).map(x => rungHtml(x.price, x.state)).join('');
    sellCol.innerHTML = (s.ladder.sells || []).map(x => rungHtml(x.price, x.state)).join('');

    const list = document.getElementById('tradeList');
    const t = s.trades || [];
    list.innerHTML = t.length ? t.map(tradeHtml).join('') : '<div class="item"><div class="k">No trades yet</div></div>';
  }

  setInterval(refresh, ${UI_REFRESH_HINT_MS});
  refresh().catch(()=>{});
</script>

</body>
</html>`;
}

// =====================
// WEB SERVER
// =====================
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      const s = statusObj();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(s, null, 2));
      return;
    }

    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  });

  server.listen(PORT, () => {
    console.log(iso(), `WEB listening on http://localhost:${PORT}`);
  });
}

// =====================
// MAIN LOOP
// =====================
async function tick() {
  try {
    const { price, source } = await fetchSolPriceRobust();
    nowPrice = price;
    priceSource = source;
    lastTickAt = Date.now();
    lastPriceError = "";

    // Init anchor on first successful price
    if (!anchor) {
      anchor = price;
      const { buys, sells } = buildLadder(anchor);
      ladderBuys = buys;
      ladderSells = sells;
      console.log(iso(), "INIT", "anchor=", round(anchor, 4), "src=", priceSource);
    }

    // simulate fills
    simulateFills();

    saveState();

    console.log(
      iso(),
      `NOW=${round(nowPrice, 2)} src=${priceSource} anchor=${anchor ? round(anchor, 2) : "—"} open=${openCount()}/${BUY_PACKETS} usd=${round(balances.usd, 2)} sol=${round(balances.sol, 4)}`
    );
  } catch (e) {
    lastPriceError = (e?.message || String(e)).slice(0, 180);
    console.log(iso(), "PRICE_FETCH_FAILED", lastPriceError);

    // Don’t wipe existing nowPrice/anchor; keep last known values if any
    saveState();
  }
}

async function main() {
  console.log("Paper bot started");
  loadState();
  startServer();

  // Run a few quick boot ticks so it initializes faster after sleep/wake
  await tick();
  await sleep(1500);
  await tick();

  setInterval(() => tick().catch(() => {}), TICK_MS);
}

main().catch((e) => {
  console.log(iso(), "FATAL", e?.message || e);
  process.exit(1);
});
