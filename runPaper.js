/**
 * runPaper.js
 * -----------
 * Paper grid bot with:
 * - Robust SOL price fetch (Jupiter + CoinGecko fallback + optional Birdeye)
 * - Auto re-anchor (trailing anchor) with guardrails
 * - Simple paper grid execution (buy/sell “packets”)
 * - Console table UI
 *
 * ✅ Paste this whole file as runPaper.js (replace your existing one).
 * ✅ Then run: node runPaper.js
 *
 * ENV (optional):
 * - BIRDEYE_API_KEY=xxxx   (only if you want Birdeye)
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
const KEEPALIVE_MS = 60_000;      // keeps local loop active

// grid basics
const GRID_LEVELS_EACH_SIDE = 10;     // number of buys + sells
const GRID_STEP_PCT = 0.01;           // 1% spacing
const ORDER_NOTIONAL_USD = 25;        // per packet size (paper)
const MAX_OPEN_PER_SIDE = 10;         // open orders cap per side

// paper balances
const START_USD = 1000;
const START_SOL = 0;

// slippage simulation (paper only): fill at level price (no slippage by default)
const SIM_SLIPPAGE_PCT = 0.0;

// =====================
// AUTO RE-ANCHOR CONFIG
// =====================
const AUTO_REANCHOR_ENABLED = true;
const REANCHOR_TRIGGER_PCT = 0.04;               // 4%
const REANCHOR_COOLDOWN_MS = 45 * 60 * 1000;      // 45 min
const REANCHOR_NO_FILL_WINDOW_MS = 10 * 60 * 1000;// 10 min
const REANCHOR_MAX_USAGE_PCT = 0.80;              // 80%

// =====================
// Price sources
// =====================
// Jupiter quote (SOL -> USDC)
const JUP_URL = "https://quote-api.jup.ag/v6/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// CoinGecko (public fallback)
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Birdeye (optional)
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const BIRDEYE_URL = "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112";

// =====================
// State
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
  realizedPnlUsd: 0, // simplistic: assumes FIFO by average cost below
  avgCostUsdPerSol: 0, // moving average cost for SOL position
};

const STATE_FILE = "./paper_state.json";

// =====================
// Utilities
// =====================
function nowIso() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function pctDiff(a, b) {
  if (!a || !b) return 0;
  return Math.abs(a - b) / b;
}
function round(n, dp = 4) {
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}
function safeNum(n) {
  return Number.isFinite(n) ? n : 0;
}

// =====================
// Persistence (optional)
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
// Network helpers
// =====================
function ensureDnsOnce() {
  // Avoid rare ENOTFOUND flakiness by forcing a DNS resolve early.
  return new Promise((resolve) => {
    dns.lookup("quote-api.jup.ag", () => resolve());
  });
}

function makeAxios() {
  return axios.create({
    timeout: TIMEOUT_MS,
    headers: {
      "User-Agent": "sol-paper-grid/1.0",
      Accept: "application/json",
    },
  });
}

const ax = makeAxios();

// =====================
// Price fetchers
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
  const data = r?.data;
  const outAmount = Number(data?.outAmount); // USDC has 6 decimals
  if (!Number.isFinite(outAmount) || outAmount <= 0) {
    throw new Error("Bad outAmount from Jupiter");
  }
  const usd = outAmount / 1e6;
  return usd;
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
  // Try Jupiter, then CoinGecko, then Birdeye (or swap Birdeye before CG if you prefer)
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
// Grid building
// =====================
function buildGrid(anchor) {
  // Build symmetric levels around anchor:
  // BUY: anchor*(1 - step*i), SELL: anchor*(1 + step*i), i=1..N
  const levels = [];
  for (let i = 1; i <= GRID_LEVELS_EACH_SIDE; i++) {
    levels.push({ side: "BUY", price: anchor * (1 - GRID_STEP_PCT * i) });
    levels.push({ side: "SELL", price: anchor * (1 + GRID_STEP_PCT * i) });
  }
  // Sort buys descending (closest first), sells ascending (closest first)
  const buys = levels.filter(l => l.side === "BUY").sort((a,b) => b.price - a.price);
  const sells = levels.filter(l => l.side === "SELL").sort((a,b) => a.price - b.price);
  return { buys, sells };
}

function getUsagePct() {
  // % of open orders used on each side relative to max
  const buysOpen = openOrders.filter(o => o.side === "BUY").length;
  const sellsOpen = openOrders.filter(o => o.side === "SELL").length;
  return {
    buysUsedPct: clamp(buysOpen / Math.max(1, MAX_OPEN_PER_SIDE), 0, 1),
    sellsUsedPct: clamp(sellsOpen / Math.max(1, MAX_OPEN_PER_SIDE), 0, 1),
  };
}

function clearOpenOrders() {
  openOrders = [];
}

function seedOpenOrdersFromGrid(anchor) {
  const { buys, sells } = buildGrid(anchor);

  // Keep up to MAX_OPEN_PER_SIDE per side
  const wantBuys = buys.slice(0, MAX_OPEN_PER_SIDE);
  const wantSells = sells.slice(0, MAX_OPEN_PER_SIDE);

  const newOrders = [];

  for (const lvl of wantBuys) {
    newOrders.push(makeOrder("BUY", lvl.price));
  }
  for (const lvl of wantSells) {
    newOrders.push(makeOrder("SELL", lvl.price));
  }

  openOrders = newOrders;
}

function makeOrder(side, price) {
  // notional USD fixed; qtySol = usd / price
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

// =====================
// Auto re-anchor logic
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

  console.log(
    nowIso(),
    `AUTO_REANCHOR: new_anchor=${round(anchorPrice, 4)}`
  );
}

// =====================
// Paper fills
// =====================
function tryFillOrders(currentPrice) {
  // Fill rules:
  // - BUY fills if currentPrice <= order.price
  // - SELL fills if currentPrice >= order.price
  // Fill in “best first” order to simulate realistic behaviour
  const buys = openOrders
    .filter(o => o.side === "BUY")
    .sort((a, b) => b.price - a.price); // highest buy first
  const sells = openOrders
    .filter(o => o.side === "SELL")
    .sort((a, b) => a.price - b.price); // lowest sell first

  const filledIds = new Set();

  // BUY fills
  for (const o of buys) {
    if (currentPrice > o.price) continue;

    const fillPrice = o.price * (1 + SIM_SLIPPAGE_PCT);
    const costUsd = o.qtySol * fillPrice;

    if (balances.usd >= costUsd) {
      balances.usd -= costUsd;
      balances.sol += o.qtySol;

      // Update avg cost
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

      // Realized pnl vs avg cost
      const costBasis = qty * stats.avgCostUsdPerSol;
      const pnl = proceedsUsd - costBasis;
      stats.realizedPnlUsd += pnl;

      // avg cost remains for remaining sol (moving avg approximation)
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
    // Replenish orders to keep grid topped up
    topUpOrders();
  }
}

function topUpOrders() {
  if (!anchorPrice) return;

  const { buys, sells } = buildGrid(anchorPrice);

  const buysOpen = openOrders.filter(o => o.side === "BUY");
  const sellsOpen = openOrders.filter(o => o.side === "SELL");

  // Prices already covered (avoid duplicates)
  const openBuyPrices = new Set(buysOpen.map(o => round(o.price, 6)));
  const openSellPrices = new Set(sellsOpen.map(o => round(o.price, 6)));

  // Add missing buys up to cap
  for (const lvl of buys) {
    if (buysOpen.length >= MAX_OPEN_PER_SIDE) break;
    const p = round(lvl.price, 6);
    if (openBuyPrices.has(p)) continue;
    openOrders.push(makeOrder("BUY", lvl.price));
    buysOpen.push(openOrders[openOrders.length - 1]);
    openBuyPrices.add(p);
  }

  // Add missing sells up to cap
  for (const lvl of sells) {
    if (sellsOpen.length >= MAX_OPEN_PER_SIDE) break;
    const p = round(lvl.price, 6);
    if (openSellPrices.has(p)) continue;
    openOrders.push(makeOrder("SELL", lvl.price));
    sellsOpen.push(openOrders[openOrders.length - 1]);
    openSellPrices.add(p);
  }
}

// =====================
// UI / reporting
// =====================
function portfolioValueUsd(markPrice) {
  return balances.usd + balances.sol * markPrice;
}

function printStatus(markPrice) {
  const pv = portfolioValueUsd(markPrice);
  const startPv = balances.startUsd + balances.startSol * markPrice;
  const unrealized = pv - (balances.usd + balances.sol * stats.avgCostUsdPerSol); // rough
  const totalPnl = pv - startPv;

  const { buysUsedPct, sellsUsedPct } = getUsagePct();

  const buys = openOrders.filter(o => o.side === "BUY").sort((a,b) => b.price - a.price);
  const sells = openOrders.filter(o => o.side === "SELL").sort((a,b) => a.price - b.price);

  const rows = [];

  const maxRows = Math.max(buys.length, sells.length, 8);
  for (let i = 0; i < maxRows; i++) {
    const b = buys[i];
    const s = sells[i];
    rows.push({
      BUY_price: b ? round(b.price, 4) : "",
      BUY_qty: b ? round(b.qtySol, 6) : "",
      SOL_price: i === 0 ? round(markPrice, 4) : "",
      SELL_price: s ? round(s.price, 4) : "",
      SELL_qty: s ? round(s.qtySol, 6) : "",
    });
  }

  console.log("\n" + nowIso(), `PRICE=${round(markPrice, 4)} src=${lastPriceSource} anchor=${anchorPrice ? round(anchorPrice, 4) : "N/A"}`);
  console.log(`Bal: USD=${round(balances.usd, 2)} SOL=${round(balances.sol, 6)}  PV=$${round(pv, 2)}  TotalPnL=$${round(totalPnl, 2)}`);
  console.log(`Fills=${stats.fills} (buys=${stats.buys}, sells=${stats.sells})  RealizedPnL=$${round(stats.realizedPnlUsd, 2)} AvgCost=$${round(stats.avgCostUsdPerSol, 4)}`);
  console.log(`OpenOrders: BUY=${buys.length}/${MAX_OPEN_PER_SIDE} SELL=${sells.length}/${MAX_OPEN_PER_SIDE} usage(b/s)=${Math.round(buysUsedPct*100)}%/${Math.round(sellsUsedPct*100)}%`);

  console.table(rows);
}

function heartbeat() {
  console.log(nowIso(), "HEARTBEAT", `price=${lastPrice ? round(lastPrice, 4) : "N/A"} openOrders=${openOrders.length}`);
}

// =====================
// Keepalive server (optional)
// =====================
function startKeepAliveServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
  });
  server.listen(0, () => {
    const addr = server.address();
    console.log(nowIso(), `KEEPALIVE listening on port ${addr.port}`);
  });
}

// =====================
// Main loop
// =====================
async function priceAndStrategyTick() {
  try {
    const { price, source } = await fetchSolPrice();
    lastPrice = price;
    lastPriceSource = source;

    // Initialize anchor + grid once
    if (!anchorPrice) {
      anchorPrice = price;
      clearOpenOrders();
      seedOpenOrdersFromGrid(anchorPrice);
      console.log(nowIso(), `INIT anchor=${round(anchorPrice, 4)}`);
    }

    // Auto re-anchor check
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
      // After reanchor, skip fills this tick (optional safety)
      printStatus(price);
      saveState();
      return;
    }

    // Try fills, then show status
    tryFillOrders(price);
    printStatus(price);

    saveState();
  } catch (e) {
    console.log(nowIso(), "PRICE_FETCH_FAILED", e?.message || e);
  }
}

// =====================
// Boot
// =====================
async function main() {
  console.log("Paper bot started");
  loadState();

  await ensureDnsOnce();

  startKeepAliveServer();

  // First tick immediately
  await priceAndStrategyTick();

  // Strategy tick
  setInterval(() => {
    priceAndStrategyTick().catch(() => {});
  }, PRICE_INTERVAL_MS);

  // Heartbeat
  setInterval(() => {
    heartbeat();
  }, HEARTBEAT_MS);

  // Keepalive no-op
  setInterval(() => {}, KEEPALIVE_MS);
}

main().catch((e) => {
  console.log(nowIso(), "FATAL", e?.message || e);
  process.exit(1);
});
