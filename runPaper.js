/**
 * runPaper.js (FULL REWRITE)
 * -------------------------
 * Paper grid bot + web UI status endpoint that includes anchor changes.
 *
 * Features:
 * - SOL/USD price fetch (Jupiter + CoinGecko fallback + optional Birdeye)
 * - Symmetric grid around an anchor
 * - Paper fills
 * - Auto re-anchor with guardrails (drift + cooldown + no recent fills + usage cap)
 * - Web endpoint:
 *    GET /status  -> JSON including anchorPrice, lastReanchorAt, anchorDriftPct, recentlyReanchored
 *    GET /        -> simple HTML page showing live status (including anchor changes)
 *
 * Run:
 *   node runPaper.js
 *
 * Optional ENV:
 *   BIRDEYE_API_KEY=xxxx
 */

import axios from "axios";
import http from "http";
import dns from "dns";
import fs from "fs";

// =====================
// CONFIG (easy tweaks)
// =====================
const TIMEOUT_MS = 15000;

// intervals
const PRICE_INTERVAL_MS = 30_000; // price + strategy tick
const HEARTBEAT_MS = 60_000;      // less spam
const KEEPALIVE_MS = 60_000;      // keeps local loop active too

// web server
const WEB_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// grid settings
const GRID_LEVELS_EACH_SIDE = 10;  // number of buy levels + number of sell levels
const GRID_STEP_PCT = 0.01;        // 1% spacing
const ORDER_NOTIONAL_USD = 25;     // per packet size (paper)
const MAX_OPEN_PER_SIDE = 10;      // cap open orders each side

// paper balances
const START_USD = 1000;
const START_SOL = 0;

// paper fill behavior
const SIM_SLIPPAGE_PCT = 0.0; // fills at level price by default

// =====================
// AUTO RE-ANCHOR CONFIG
// =====================
const AUTO_REANCHOR_ENABLED = true;
const REANCHOR_TRIGGER_PCT = 0.04;                 // 4% drift from anchor
const REANCHOR_COOLDOWN_MS = 45 * 60 * 1000;        // 45 minutes
const REANCHOR_NO_FILL_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes since last fill
const REANCHOR_MAX_USAGE_PCT = 0.80;                // 80% open order usage
const REANCHOR_RECENT_BADGE_MS = 30_000;            // "recently re-anchored" badge window

// =====================
// PRICE SOURCES
// =====================
// Jupiter quote (SOL -> USDC)
const JUP_URL = "https://quote-api.jup.ag/v6/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// CoinGecko (public fallback)
const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Birdeye (optional)
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const BIRDEYE_URL =
  "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112";

// =====================
// STATE
// =====================
let anchorPrice = null;
let lastReanchorAt = 0;
let lastFillAt = 0;

let lastPrice = null;
let lastPriceSource = "N/A";

let openOrders = []; // {id, side:'BUY'|'SELL', price, qtySol, notionalUsd, createdAt}
let nextOrderId = 1;

let balances = {
  usd: START_USD,
  sol: START_SOL,
  startUsd: START_USD,
  startSol: START_SOL,
};

let stats = {
  fills: 0,
  buys: 0,
  sells: 0,
  realizedPnlUsd: 0,
  avgCostUsdPerSol: 0, // moving avg cost of current SOL position
};

const STATE_FILE = "./paper_state.json";

// =====================
// UTIL
// =====================
function nowIso() {
  return new Date().toISOString();
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function pctDiff(a, b) {
  if (!a || !b) return 0;
  return Math.abs(a - b) / b;
}
function round(n, dp = 4) {
  if (!Number.isFinite(n)) return n;
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

// =====================
// PERSISTENCE
// =====================
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);

    anchorPrice = s.anchorPrice ?? anchorPrice;
    lastReanchorAt = s.lastReanchorAt ?? lastReanchorAt;
    lastFillAt = s.lastFillAt ?? lastFillAt;

    openOrders = Array.isArray(s.openOrders) ? s.openOrders : openOrders;
    nextOrderId = s.nextOrderId ?? nextOrderId;

    balances = s.balances ?? balances;
    stats = s.stats ?? stats;

    lastPrice = s.lastPrice ?? lastPrice;
    lastPriceSource = s.lastPriceSource ?? lastPriceSource;

    console.log(nowIso(), "STATE_LOADED");
  } catch (e) {
    console.log(nowIso(), "STATE_LOAD_FAILED", e?.message || e);
  }
}

function saveState() {
  try {
    const s = {
      anchorPrice,
      lastReanchorAt,
      lastFillAt,
      openOrders,
      nextOrderId,
      balances,
      stats,
      lastPrice,
      lastPriceSource,
      savedAt: Date.now(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.log(nowIso(), "STATE_SAVE_FAILED", e?.message || e);
  }
}

// =====================
// NETWORK HELPERS
// =====================
async function ensureDnsOnce() {
  return new Promise((resolve) => {
    dns.lookup("quote-api.jup.ag", () => resolve());
  });
}

const ax = axios.create({
  timeout: TIMEOUT_MS,
  headers: {
    "User-Agent": "sol-paper-grid/1.0",
    Accept: "application/json",
  },
});

// =====================
// PRICE FETCHERS
// =====================
async function fetchPriceFromJupiter() {
  // 1 SOL = 1e9 lamports
  const inAmount = "1000000000";
  const params = {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount,
    swapMode: "ExactIn",
    slippageBps: 50,
  };

  const r = await ax.get(JUP_URL, { params });
  const outAmount = Number(r?.data?.outAmount); // USDC has 6 decimals
  if (!Number.isFinite(outAmount) || outAmount <= 0) {
    throw new Error("Bad outAmount from Jupiter");
  }
  return outAmount / 1e6;
}

async function fetchPriceFromCoinGecko() {
  const r = await ax.get(CG_URL);
  const usd = Number(r?.data?.solana?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("Bad CoinGecko price");
  return usd;
}

async function fetchPriceFromBirdeye() {
  if (!BIRDEYE_API_KEY) throw new Error("No Birdeye API key set");
  const r = await ax.get(BIRDEYE_URL, {
    headers: { "X-API-KEY": BIRDEYE_API_KEY },
  });
  const usd = Number(r?.data?.data?.value);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("Bad Birdeye price");
  return usd;
}

async function fetchSolPrice() {
  const attempts = [
    { name: "JUP", fn: fetchPriceFromJupiter },
    { name: "CG", fn: fetchPriceFromCoinGecko },
    ...(BIRDEYE_API_KEY ? [{ name: "BIRDEYE", fn: fetchPriceFromBirdeye }] : []),
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      const p = await a.fn();
      return { price: p, source: a.name };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All price sources failed");
}

// =====================
// GRID
// =====================
function buildGrid(anchor) {
  const levels = [];
  for (let i = 1; i <= GRID_LEVELS_EACH_SIDE; i++) {
    levels.push({ side: "BUY", price: anchor * (1 - GRID_STEP_PCT * i) });
    levels.push({ side: "SELL", price: anchor * (1 + GRID_STEP_PCT * i) });
  }

  const buys = levels.filter(l => l.side === "BUY").sort((a, b) => b.price - a.price);
  const sells = levels.filter(l => l.side === "SELL").sort((a, b) => a.price - b.price);
  return { buys, sells };
}

function makeOrder(side, price) {
  const notionalUsd = ORDER_NOTIONAL_USD;
  const qtySol = notionalUsd / price;
  return {
    id: nextOrderId++,
    side,
    price,
    qtySol,
    notionalUsd,
    createdAt: Date.now(),
  };
}

function clearOpenOrders() {
  openOrders = [];
}

function seedOpenOrdersFromGrid(anchor) {
  const { buys, sells } = buildGrid(anchor);

  const wantBuys = buys.slice(0, MAX_OPEN_PER_SIDE);
  const wantSells = sells.slice(0, MAX_OPEN_PER_SIDE);

  const newOrders = [];

  for (const lvl of wantBuys) newOrders.push(makeOrder("BUY", lvl.price));
  for (const lvl of wantSells) newOrders.push(makeOrder("SELL", lvl.price));

  openOrders = newOrders;
}

function getUsagePct() {
  const buysOpen = openOrders.filter(o => o.side === "BUY").length;
  const sellsOpen = openOrders.filter(o => o.side === "SELL").length;
  return {
    buysUsedPct: clamp(buysOpen / Math.max(1, MAX_OPEN_PER_SIDE), 0, 1),
    sellsUsedPct: clamp(sellsOpen / Math.max(1, MAX_OPEN_PER_SIDE), 0, 1),
  };
}

function topUpOrders() {
  if (!anchorPrice) return;

  const { buys, sells } = buildGrid(anchorPrice);

  const buysOpen = openOrders.filter(o => o.side === "BUY");
  const sellsOpen = openOrders.filter(o => o.side === "SELL");

  const openBuyPrices = new Set(buysOpen.map(o => round(o.price, 6)));
  const openSellPrices = new Set(sellsOpen.map(o => round(o.price, 6)));

  for (const lvl of buys) {
    if (buysOpen.length >= MAX_OPEN_PER_SIDE) break;
    const p = round(lvl.price, 6);
    if (openBuyPrices.has(p)) continue;
    const o = makeOrder("BUY", lvl.price);
    openOrders.push(o);
    buysOpen.push(o);
    openBuyPrices.add(p);
  }

  for (const lvl of sells) {
    if (sellsOpen.length >= MAX_OPEN_PER_SIDE) break;
    const p = round(lvl.price, 6);
    if (openSellPrices.has(p)) continue;
    const o = makeOrder("SELL", lvl.price);
    openOrders.push(o);
    sellsOpen.push(o);
    openSellPrices.add(p);
  }
}

// =====================
// AUTO RE-ANCHOR
// =====================
function shouldReanchor({
  now,
  currentPrice,
  anchorPrice,
  lastReanchorAt,
  lastFillAt,
  buysUsedPct,
  sellsUsedPct,
}) {
  if (!AUTO_REANCHOR_ENABLED) return { ok: false, reason: "disabled" };
  if (!anchorPrice || !Number.isFinite(anchorPrice)) return { ok: false, reason: "no_anchor" };
  if (!currentPrice || !Number.isFinite(currentPrice)) return { ok: false, reason: "bad_price" };

  const drift = pctDiff(currentPrice, anchorPrice);
  if (drift < REANCHOR_TRIGGER_PCT) return { ok: false, reason: "drift_small", drift };

  if (now - lastReanchorAt < REANCHOR_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", drift };
  }

  if (now - lastFillAt < REANCHOR_NO_FILL_WINDOW_MS) {
    return { ok: false, reason: "recent_fill", drift };
  }

  if (buysUsedPct >= REANCHOR_MAX_USAGE_PCT || sellsUsedPct >= REANCHOR_MAX_USAGE_PCT) {
    return { ok: false, reason: "usage_high", drift, buysUsedPct, sellsUsedPct };
  }

  return { ok: true, reason: "reanchor", drift };
}

function reanchorGrid(currentPrice) {
  anchorPrice = currentPrice;
  lastReanchorAt = Date.now();

  clearOpenOrders();
  seedOpenOrdersFromGrid(anchorPrice);

  console.log(nowIso(), `AUTO_REANCHOR: new_anchor=${round(anchorPrice, 4)}`);
}

// =====================
// PAPER FILLS
// =====================
function tryFillOrders(currentPrice) {
  const buys = openOrders
    .filter(o => o.side === "BUY")
    .sort((a, b) => b.price - a.price);
  const sells = openOrders
    .filter(o => o.side === "SELL")
    .sort((a, b) => a.price - b.price);

  const filledIds = new Set();

  // BUY fills
  for (const o of buys) {
    if (currentPrice > o.price) continue;

    const fillPrice = o.price * (1 + SIM_SLIPPAGE_PCT);
    const costUsd = o.qtySol * fillPrice;

    if (balances.usd >= costUsd) {
      balances.usd -= costUsd;
      balances.sol += o.qtySol;

      // moving avg cost update
      const prevSol = balances.sol - o.qtySol;
      const prevCost = stats.avgCostUsdPerSol * prevSol;
      const newCost = prevCost + costUsd;
      stats.avgCostUsdPerSol = balances.sol > 0 ? newCost / balances.sol : 0;

      stats.fills++;
      stats.buys++;
      lastFillAt = Date.now();
      filledIds.add(o.id);

      console.log(nowIso(), `FILL BUY  id=${o.id} price=${round(fillPrice, 4)} qty=${round(o.qtySol, 6)}`);
    }
  }

  // SELL fills
  for (const o of sells) {
    if (currentPrice < o.price) continue;

    const fillPrice = o.price * (1 - SIM_SLIPPAGE_PCT);
    const qty = o.qtySol;

    if (balances.sol >= qty) {
      balances.sol -= qty;
      const proceedsUsd = qty * fillPrice;
      balances.usd += proceedsUsd;

      const costBasis = qty * stats.avgCostUsdPerSol;
      const pnl = proceedsUsd - costBasis;
      stats.realizedPnlUsd += pnl;

      if (balances.sol <= 0) stats.avgCostUsdPerSol = 0;

      stats.fills++;
      stats.sells++;
      lastFillAt = Date.now();
      filledIds.add(o.id);

      console.log(nowIso(), `FILL SELL id=${o.id} price=${round(fillPrice, 4)} qty=${round(qty, 6)} pnl=${round(pnl, 2)}`);
    }
  }

  if (filledIds.size > 0) {
    openOrders = openOrders.filter(o => !filledIds.has(o.id));
    topUpOrders();
  }
}

// =====================
// STATUS HELPERS
// =====================
function portfolioValueUsd(markPrice) {
  return balances.usd + balances.sol * markPrice;
}

function computeStatus() {
  const driftPct =
    anchorPrice && lastPrice
      ? Math.abs(lastPrice - anchorPrice) / anchorPrice
      : null;

  const recentlyReanchored = Date.now() - lastReanchorAt < REANCHOR_RECENT_BADGE_MS;

  const pv = lastPrice ? portfolioValueUsd(lastPrice) : null;
  const startPv = lastPrice
    ? balances.startUsd + balances.startSol * lastPrice
    : null;

  const totalPnl = (pv != null && startPv != null) ? (pv - startPv) : null;

  const buysOpen = openOrders.filter(o => o.side === "BUY").length;
  const sellsOpen = openOrders.filter(o => o.side === "SELL").length;

  return {
    ts: Date.now(),
    iso: nowIso(),

    price: lastPrice,
    priceSource: lastPriceSource,

    anchorPrice,
    lastReanchorAt,
    anchorDriftPct: driftPct,
    recentlyReanchored,

    balances,
    stats,

    openOrders: {
      total: openOrders.length,
      buys: buysOpen,
      sells: sellsOpen,
    },

    pvUsd: pv,
    totalPnlUsd: totalPnl,
  };
}

function printConsoleStatus() {
  if (!lastPrice) {
    console.log(nowIso(), "STATUS price=N/A");
    return;
  }

  const s = computeStatus();
  const driftStr = s.anchorDriftPct == null ? "–" : `${round(s.anchorDriftPct * 100, 2)}%`;
  const badge = s.recentlyReanchored ? " 🔁" : "";

  console.log(
    "\n" +
      s.iso,
    `PRICE=${round(s.price, 4)} src=${s.priceSource} anchor=${s.anchorPrice ? round(s.anchorPrice, 4) : "N/A"} drift=${driftStr}${badge}`
  );

  console.log(
    `Bal: USD=${round(balances.usd, 2)} SOL=${round(balances.sol, 6)} PV=$${round(s.pvUsd, 2)} TotalPnL=$${round(s.totalPnlUsd, 2)}`
  );

  console.log(
    `Fills=${stats.fills} (buys=${stats.buys}, sells=${stats.sells}) RealizedPnL=$${round(stats.realizedPnlUsd, 2)} AvgCost=$${round(stats.avgCostUsdPerSol, 4)}`
  );

  console.log(
    `OpenOrders: total=${s.openOrders.total} BUY=${s.openOrders.buys}/${MAX_OPEN_PER_SIDE} SELL=${s.openOrders.sells}/${MAX_OPEN_PER_SIDE}`
  );
}

// =====================
// WEB UI
// =====================
function htmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Paper Grid Bot</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 16px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .k { opacity: 0.7; font-size: 12px; }
    .v { font-size: 20px; font-weight: 700; }
    .badge { display:inline-block; padding: 3px 8px; border-radius: 999px; border: 1px solid #ddd; font-size: 12px; margin-left: 8px; }
    .muted { opacity: 0.7; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h2>Paper Grid Bot</h2>

  <div class="card">
    <div class="row">
      <div>
        <div class="k">SOL Price</div>
        <div class="v" id="price">–</div>
        <div class="muted" id="source">–</div>
      </div>
      <div>
        <div class="k">Anchor</div>
        <div class="v" id="anchor">–</div>
        <div class="muted">Drift: <span id="drift">–</span><span class="badge" id="reanchorBadge" style="display:none;">re-anchored</span></div>
      </div>
      <div>
        <div class="k">Portfolio Value</div>
        <div class="v" id="pv">–</div>
        <div class="muted">Total PnL: <span id="pnl">–</span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <div class="k">USD</div>
        <div class="v" id="usd">–</div>
      </div>
      <div>
        <div class="k">SOL</div>
        <div class="v" id="sol">–</div>
      </div>
      <div>
        <div class="k">Open BUY / SELL</div>
        <div class="v"><span id="buys">–</span> / <span id="sells">–</span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="k">Raw /status</div>
    <pre id="raw">–</pre>
  </div>

<script>
async function refresh() {
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    const s = await r.json();

    const fmt = (n, dp=4) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(dp) : '–';
    const money = (n) => (typeof n === 'number' && isFinite(n)) ? ('$' + n.toFixed(2)) : '–';

    document.getElementById('price').innerText = fmt(s.price, 4);
    document.getElementById('source').innerText = 'src: ' + (s.priceSource || '–');

    document.getElementById('anchor').innerText = fmt(s.anchorPrice, 4);
    document.getElementById('drift').innerText =
      (typeof s.anchorDriftPct === 'number' && isFinite(s.anchorDriftPct))
        ? (s.anchorDriftPct * 100).toFixed(2) + '%'
        : '–';

    const badge = document.getElementById('reanchorBadge');
    badge.style.display = s.recentlyReanchored ? 'inline-block' : 'none';

    document.getElementById('usd').innerText = money(s.balances?.usd);
    document.getElementById('sol').innerText = fmt(s.balances?.sol, 6);

    document.getElementById('buys').innerText = s.openOrders?.buys ?? '–';
    document.getElementById('sells').innerText = s.openOrders?.sells ?? '–';

    document.getElementById('pv').innerText = money(s.pvUsd);
    document.getElementById('pnl').innerText = money(s.totalPnlUsd);

    document.getElementById('raw').innerText = JSON.stringify(s, null, 2);
  } catch (e) {
    document.getElementById('raw').innerText = 'refresh failed: ' + (e && e.message ? e.message : e);
  }
}
setInterval(refresh, 3000);
refresh();
</script>
</body>
</html>`;
}

function startWebServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      const s = computeStatus();
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
      res.end(htmlPage());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  });

  server.listen(WEB_PORT, () => {
    console.log(nowIso(), `WEB listening on http://localhost:${WEB_PORT}  (/) and (/status)`);
  });
}

// =====================
// HEARTBEAT
// =====================
function heartbeat() {
  console.log(
    nowIso(),
    "HEARTBEAT",
    `price=${lastPrice ? round(lastPrice, 4) : "N/A"} openOrders=${openOrders.length}`
  );
}

// =====================
// MAIN TICK
// =====================
async function priceAndStrategyTick() {
  try {
    const { price, source } = await fetchSolPrice();
    lastPrice = price;
    lastPriceSource = source;

    // init anchor + seed orders once
    if (!anchorPrice) {
      anchorPrice = price;
      clearOpenOrders();
      seedOpenOrdersFromGrid(anchorPrice);
      console.log(nowIso(), `INIT anchor=${round(anchorPrice, 4)}`);
    }

    // auto re-anchor
    const { buysUsedPct, sellsUsedPct } = getUsagePct();
    const decision = shouldReanchor({
      now: Date.now(),
      currentPrice: price,
      anchorPrice,
      lastReanchorAt,
      lastFillAt,
      buysUsedPct,
      sellsUsedPct,
    });

    if (decision.ok) {
      console.log(nowIso(), `AUTO_REANCHOR_TRIGGER drift=${round(decision.drift * 100, 2)}%`);
      reanchorGrid(price);

      // optional: skip fills on same tick as re-anchor for safety
      printConsoleStatus();
      saveState();
      return;
    }

    // fills + top-up
    tryFillOrders(price);

    // status
    printConsoleStatus();
    saveState();
  } catch (e) {
    console.log(nowIso(), "PRICE_FETCH_FAILED", e?.message || e);
  }
}

// =====================
// BOOT
// =====================
async function main() {
  console.log("Paper bot started");
  loadState();

  await ensureDnsOnce();

  startWebServer();

  // first tick immediately
  await priceAndStrategyTick();

  // strategy loop
  setInterval(() => {
    priceAndStrategyTick().catch(() => {});
  }, PRICE_INTERVAL_MS);

  // heartbeat
  setInterval(() => {
    heartbeat();
  }, HEARTBEAT_MS);

  // keepalive no-op
  setInterval(() => {}, KEEPALIVE_MS);
}

main().catch((e) => {
  console.log(nowIso(), "FATAL", e?.message || e);
  process.exit(1);
});
