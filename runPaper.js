/**
 * runPaper.js — DARK LADDER UI + % GRID + ASYMMETRIC STEPS
 * --------------------------------------------------------
 * This is a full, self-contained script that restores a “dark ladder dashboard”
 * style UI and implements:
 *
 * ✅ #1 Percent spacing (not $0.50)
 * ✅ #2 Asymmetric spacing (buys wider, sells tighter)
 * ✅ Packet cap + guard (won’t buy beyond sell coverage)
 * ✅ Paper fills + simple PnL (avg entry / breakeven)
 * ✅ Web UI on Render (/) + JSON (/status)
 *
 * Run locally:
 *   node runPaper.js
 *
 * Render:
 *   Start command: node runPaper.js
 *   Uses PORT env if provided, else 3000
 *
 * Optional ENV:
 *   BIRDEYE_API_KEY=xxxx
 */

import axios from "axios";
import http from "http";
import fs from "fs";

// =====================
// CONFIG (YOUR CHOICES)
// =====================
const TIMEOUT_MS = 15000;

// Loop intervals
const TICK_MS = 30_000;
const UI_REFRESH_HINT_MS = 3000;

// Packets (capacity)
const BUY_PACKETS = 6;
const SELL_PACKETS = 6;

// Ladder depth shown on page
const LEVELS_EACH_SIDE = 10;

// ✅ #1 + #2 (the improvements you chose)
const BUY_STEP_PCT = 0.008;  // 0.8% between buy rungs (wider)
const SELL_STEP_PCT = 0.006; // 0.6% between sell rungs (tighter)

// Order sizing (paper)
const ORDER_NOTIONAL_USD = 25;

// Starting balances
const START_USD = 1000;
const START_SOL = 0;

// If you want a tiny simulated slippage, set > 0
const SIM_SLIPPAGE_PCT = 0.0;

// Web server
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Persistence
const STATE_FILE = "./paper_state_dark.json";

// =====================
// PRICE SOURCES
// =====================
const JUP_URL = "https://quote-api.jup.ag/v6/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const BIRDEYE_URL =
  "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112";

const ax = axios.create({
  timeout: TIMEOUT_MS,
  headers: { "User-Agent": "paper-grid/1.0", Accept: "application/json" },
});

// =====================
// STATE
// =====================
let anchor = null;
let nowPrice = null;
let priceSource = "N/A";
let lastTickAt = 0;

// “Packets” are just how many open positions are allowed.
// Each fill creates an open position. Each sell closes one.
let openPositions = []; // [{ id, entryPrice, qtySol, costUsd, openedAt }]
let trades = [];        // last N trades [{ ts, side, price, qtySol, pnlUsd? }]

// Ladder rungs tracked as stateful "slots" for UI
let ladderBuys = [];  // [{ price, state:'WAIT'|'FILLED' }]
let ladderSells = []; // [{ price, state:'WAIT'|'FILLED' }]

// Balances + stats
let balances = {
  usd: START_USD,
  sol: START_SOL,
};

let stats = {
  trades: 0,
  buys: 0,
  sells: 0,
  realizedPnlUsd: 0,
  avgEntry: null, // avg entry across open positions
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
function pct(n, dp = 2) {
  return Number.isFinite(n) ? (n * 100).toFixed(dp) + "%" : "—";
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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
// PRICE FETCH
// =====================
async function fetchPriceFromJupiter() {
  const inAmount = "1000000000"; // 1 SOL (lamports)
  const params = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount,
    swapMode: "ExactIn",
    slippageBps: 50,
  };
  const r = await ax.get(JUP_URL, { params });
  const outAmount = Number(r?.data?.outAmount); // USDC 6 decimals
  if (!Number.isFinite(outAmount) || outAmount <= 0) throw new Error("Bad Jupiter outAmount");
  return outAmount / 1e6;
}

async function fetchPriceFromCoinGecko() {
  const r = await ax.get(CG_URL);
  const p = Number(r?.data?.solana?.usd);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Bad CoinGecko price");
  return p;
}

async function fetchPriceFromBirdeye() {
  if (!BIRDEYE_API_KEY) throw new Error("No Birdeye key");
  const r = await ax.get(BIRDEYE_URL, {
    headers: { "X-API-KEY": BIRDEYE_API_KEY },
  });
  const p = Number(r?.data?.data?.value);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Bad Birdeye price");
  return p;
}

async function fetchSolPrice() {
  const sources = [
    { name: "JUP", fn: fetchPriceFromJupiter },
    { name: "CG", fn: fetchPriceFromCoinGecko },
    ...(BIRDEYE_API_KEY ? [{ name: "BIRDEYE", fn: fetchPriceFromBirdeye }] : []),
  ];

  let lastErr = null;
  for (const s of sources) {
    try {
      const price = await s.fn();
      return { price, source: s.name };
    } catch (e) {
      lastErr = e;
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
    const buyPrice = a * (1 - BUY_STEP_PCT * i);
    const sellPrice = a * (1 + SELL_STEP_PCT * i);
    buys.push({ price: buyPrice, state: "WAIT" });
    sells.push({ price: sellPrice, state: "WAIT" });
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
function buyPacketsRemaining() {
  return Math.max(0, BUY_PACKETS - openCount());
}
function sellPacketsRemaining() {
  // Sell packets represent how many exits are planned.
  // In this model, each open position consumes a sell packet capacity.
  return Math.max(0, SELL_PACKETS - openCount());
}
function guardBlocksBuyNext() {
  // "blocks BUY when open+1 > sell packets"
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
  // For paper, use avg entry as breakeven (ignoring fees)
  return stats.avgEntry;
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

  trades.unshift({
    ts: Date.now(),
    side: "BUY",
    price: fillPrice,
    qtySol,
  });
  trades = trades.slice(0, 10);

  recomputeAvgEntry();
  return true;
}

function placeSellAtPrice(fillPrice) {
  if (!openPositions.length) return false;

  // Close the oldest position (FIFO-ish)
  const pos = openPositions.shift();
  const qtySol = pos.qtySol;

  if (balances.sol < qtySol) {
    // Shouldn't happen in paper, but guard it
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

  trades.unshift({
    ts: Date.now(),
    side: "SELL",
    price: fillPrice,
    qtySol,
    pnlUsd: pnl,
  });
  trades = trades.slice(0, 10);

  recomputeAvgEntry();
  return true;
}

function simulateFills() {
  if (!nowPrice || !anchor) return;
  ensureLadder();

  // BUY: fill if now <= rung price
  // Fill from closest rung outward to simulate realistic sweep
  for (const rung of ladderBuys) {
    if (rung.state === "FILLED") continue;
    if (nowPrice <= rung.price) {
      const fillPrice = rung.price * (1 + SIM_SLIPPAGE_PCT);
      const ok = placeBuyAtPrice(fillPrice);
      if (ok) rung.state = "FILLED";
      else break; // if we couldn't buy (guard/cash), stop
    }
  }

  // SELL: fill if now >= rung price
  for (const rung of ladderSells) {
    if (rung.state === "FILLED") continue;
    if (nowPrice >= rung.price) {
      const fillPrice = rung.price * (1 - SIM_SLIPPAGE_PCT);
      const ok = placeSellAtPrice(fillPrice);
      if (ok) rung.state = "FILLED";
      else break; // no positions to sell
    }
  }
}

// =====================
// RESET / RE-ANCHOR (MANUAL ONLY IN THIS VERSION)
// =====================
function resetAndReanchor(newAnchor) {
  anchor = newAnchor;
  ladderBuys = [];
  ladderSells = [];
  ensureLadder();

  // Reset rung states based on current positions (keep positions)
  // We keep openPositions intact; rung "FILLED" is just UI history.
  console.log(iso(), "REANCHOR_MANUAL", "anchor=", round(anchor, 4));
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

    config: {
      BUY_PACKETS,
      SELL_PACKETS,
      LEVELS_EACH_SIDE,
      BUY_STEP_PCT,
      SELL_STEP_PCT,
      ORDER_NOTIONAL_USD,
    },

    balances,
    stats: {
      ...stats,
      openPositions: openCount(),
      buyPackets: BUY_PACKETS,
      sellPackets: SELL_PACKETS,
      buyPacketsRemaining: buyPacketsRemaining(),
      sellPacketsRemaining: sellPacketsRemaining(),
      guard: "blocks BUY when open+1 > sell packets",
      guardBlocked: guardBlocksBuyNext(),
      breakeven: breakeven(),
      portfolioValueUsd: pv,
    },

    ladder: {
      buys: ladderBuys,
      sells: ladderSells,
    },

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
      --card2:#0d1730;
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
    .sub{ font-size: 12px; color: var(--muted); margin-top: 4px; }
    .pill{
      display:inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
    }
    .pill.good{ color: var(--good); border-color: rgba(46,229,157,.35); }
    .pill.bad{ color: var(--bad); border-color: rgba(255,92,122,.35); }
    .ladder{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
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
    .state.wait{ color: var(--muted); }
    .price{ font-weight: 800; }
    .mid{
      text-align:center;
      padding: 16px 8px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(46,229,157,.07), rgba(60,120,255,.06));
    }
    .mid .big{ font-size: 26px; font-weight: 900; margin-top: 6px; }
    .mid .small{ font-size: 12px; color: var(--muted); margin-top: 4px; }
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
        <div class="small" id="anchorLine">Anchor: — • Steps: — / —</div>
        <div class="small" id="driftLine">Drift: — · src: —</div>
      </div>

      <div class="card list">
        <div class="k">Last 10 trades</div>
        <div id="tradeList"></div>
      </div>
    </div>

    <div class="card" style="margin-top:12px;">
      <div class="k">Ladder (fixed levels; colour/state changes)</div>
      <div class="sub">Re-centering / movable anchor can be added later — this version is stable.</div>
      <div class="ladder" style="margin-top:10px;">
        <div>
          <div class="coltitle">BUY (wider, ${ (BUY_STEP_PCT*100).toFixed(2) }% steps)</div>
          <div id="buyCol"></div>
        </div>
        <div>
          <div class="coltitle">SELL (tighter, ${ (SELL_STEP_PCT*100).toFixed(2) }% steps)</div>
          <div id="sellCol"></div>
        </div>
      </div>
      <div class="footer">
        JSON endpoint: <a href="/status">/status</a> · Refresh hint: ${UI_REFRESH_HINT_MS/1000}s
      </div>
    </div>
  </div>

<script>
  const fmt = (n, dp=2) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(dp) : '—';
  const money = (n) => (typeof n === 'number' && isFinite(n)) ? ('$' + n.toFixed(2)) : '—';

  function rungHtml(p, state){
    const st = state === 'FILLED' ? 'filled' : 'wait';
    return \`
      <div class="rung">
        <div class="price">\${fmt(p, 2)}</div>
        <div class="state \${st}">\${state}</div>
      </div>\`;
  }

  function tradeHtml(t){
    const sideClass = t.side === 'BUY' ? 'sidebuy' : 'sidesell';
    const sideLabel = t.side === 'BUY' ? 'BUY' : 'SELL';
    const pnl = (typeof t.pnlUsd === 'number') ? t.pnlUsd : null;
    const pnlClass = pnl == null ? '' : (pnl >= 0 ? 'pos' : 'neg');

    return \`
      <div class="item">
        <div class="row">
          <div class="\${sideClass}">\${sideLabel}</div>
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

    // Top stats
    document.getElementById('trades').innerText = s.stats.trades ?? '—';
    document.getElementById('buys').innerText = s.stats.buys ?? '—';
    document.getElementById('sells').innerText = s.stats.sells ?? '—';
    document.getElementById('openPos').innerText = s.stats.openPositions ?? '—';
    document.getElementById('sellPackets').innerText = s.stats.sellPackets ?? '—';
    document.getElementById('buyPackets').innerText = s.stats.buyPackets ?? '—';

    const guard = s.stats.guard ?? '—';
    const blocked = !!s.stats.guardBlocked;
    document.getElementById('guardText').innerText = guard + (blocked ? ' (BLOCKING)' : '');
    document.getElementById('avgEntry').innerText = (typeof s.stats.avgEntry === 'number') ? fmt(s.stats.avgEntry, 2) : '—';
    document.getElementById('breakeven').innerText = (typeof s.stats.breakeven === 'number') ? fmt(s.stats.breakeven, 2) : '—';

    document.getElementById('usd').innerText = money(s.balances.usd);
    document.getElementById('sol').innerText = fmt(s.balances.sol, 6);
    document.getElementById('pv').innerText = money(s.stats.portfolioValueUsd);

    // Matched pill
    const matched = (s.stats.sellPackets >= s.stats.openPositions);
    const pill = document.getElementById('matchPill');
    pill.className = 'pill ' + (matched ? 'good' : 'bad');
    pill.innerText = matched ? '✅ Matched: sells can cover open positions' : '⚠ Not matched';

    // Middle panel
    document.getElementById('now').innerText = fmt(s.nowPrice, 2);
    document.getElementById('anchorLine').innerText =
      'Anchor: ' + fmt(s.anchor, 2) + ' • Steps: ' + (s.config.BUY_STEP_PCT*100).toFixed(2) + '% / ' + (s.config.SELL_STEP_PCT*100).toFixed(2) + '%';
    document.getElementById('driftLine').innerText =
      'Drift: ' + ((typeof s.drift === 'number') ? (s.drift*100).toFixed(2)+'%' : '—') + ' · src: ' + (s.priceSource || '—');

    // Ladder
    const buyCol = document.getElementById('buyCol');
    const sellCol = document.getElementById('sellCol');
    buyCol.innerHTML = (s.ladder.buys || []).map(x => rungHtml(x.price, x.state)).join('');
    sellCol.innerHTML = (s.ladder.sells || []).map(x => rungHtml(x.price, x.state)).join('');

    // Trades
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

    // Optional manual re-anchor endpoint (safe, but you can ignore)
    // Example: /reanchor  (sets anchor to current nowPrice and rebuilds ladder)
    if (req.url === "/reanchor") {
      if (Number.isFinite(nowPrice)) {
        resetAndReanchor(nowPrice);
        saveState();
      }
      res.writeHead(302, { Location: "/" });
      res.end();
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
    const { price, source } = await fetchSolPrice();
    nowPrice = price;
    priceSource = source;
    lastTickAt = Date.now();

    // Init anchor on first tick
    if (!anchor) {
      anchor = price;
      const { buys, sells } = buildLadder(anchor);
      ladderBuys = buys;
      ladderSells = sells;
      console.log(iso(), "INIT", "anchor=", round(anchor, 4));
    }

    // simulate fills + update
    simulateFills();
    saveState();

    // Console heartbeat (light)
    console.log(
      iso(),
      `NOW=${round(nowPrice, 2)} anchor=${round(anchor, 2)} open=${openCount()}/${BUY_PACKETS} usd=${round(balances.usd, 2)} sol=${round(balances.sol, 4)}`
    );
  } catch (e) {
    console.log(iso(), "PRICE_FETCH_FAILED", e?.message || e);
  }
}

async function main() {
  console.log("Paper bot started");
  loadState();
  startServer();

  await tick();
  setInterval(() => tick().catch(() => {}), TICK_MS);
}

main().catch((e) => {
  console.log(iso(), "FATAL", e?.message || e);
  process.exit(1);
});
