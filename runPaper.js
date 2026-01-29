import axios from "axios";
import http from "http";
import dns from "dns";
import fs from "fs";

// =====================
// CONFIG (easy tweaks)
// =====================
const TIMEOUT_MS = 15000;

// intervals
const PRICE_INTERVAL_MS = 30_000;   // price + strategy tick
const HEARTBEAT_MS = 60_000;        // less spam
const KEEPALIVE_MS = 60_000;        // uptime robot will do external; this keeps local loop active too

// grid settings (paper)
const GRID_STEP_USD = 0.50;         // distance between levels
const LEVELS_ABOVE = 6;             // sell levels above anchor
const LEVELS_BELOW = 6;             // buy levels below anchor

const START_USDC = 500;             // starting paper cash
const START_SOL = 0;                // starting paper SOL
const USD_PER_BUY = 25;             // buy size per level in USD

// PACKETS (capacity / guard)
const BUY_PACKETS = 6;
const SELL_PACKETS = 6;

// render web service
const PORT = process.env.PORT || 10000;

// optional: set this in Render env vars to your public URL
const SERVICE_URL = process.env.SERVICE_URL || "";

// state file
const STATE_FILE = "./state.json";

// =====================
// DNS hardening
// =====================
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// =====================
// In-memory state (persisted)
// =====================
let state = {
  anchor: null,
  step: GRID_STEP_USD,
  levelsAbove: LEVELS_ABOVE,
  levelsBelow: LEVELS_BELOW,

  usdc: START_USDC,
  sol: START_SOL,

  realizedPnl: 0,

  lastPrice: null,
  lastAt: null,
  lastError: null,

  packets: {
    buyCapacity: BUY_PACKETS,
    sellCapacity: SELL_PACKETS,
    note: "Blocks buys that would exceed sell capacity (unmatched positions).",
  },

  levelStates: {},
  positions: {},

  trades: [],

  tick: 0,
  hb: 0,

  realign: {
    enabled: false,
    note: "Realignment to be dealt with later",
    lastSuggestedAt: null,
    lastSuggestedReason: null,
  },
};

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);

    state = { ...state, ...s };

    state.levelStates ||= {};
    state.positions ||= {};
    state.trades ||= [];
    state.realign ||= { enabled: false };
    state.packets ||= { buyCapacity: BUY_PACKETS, sellCapacity: SELL_PACKETS };

    if (!Number.isFinite(state.packets.buyCapacity)) state.packets.buyCapacity = BUY_PACKETS;
    if (!Number.isFinite(state.packets.sellCapacity)) state.packets.sellCapacity = SELL_PACKETS;

    console.log(
      `RESTORED_STATE anchor=${state.anchor ?? "n/a"} usdc=${state.usdc} sol=${state.sol} tick=${state.tick} trades=${state.trades.length}`
    );
  } catch (_) {
    console.log("NO_STATE_FOUND - starting fresh");
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.log("STATE_SAVE_FAILED", String(e?.message || e));
  }
}

function clampTrades() {
  if (state.trades.length > 100) state.trades = state.trades.slice(-100);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function fmt2(x) {
  return Number(x).toFixed(2);
}

function levelKey(side, price) {
  return `${side}:${fmt2(price)}`;
}

function buildLevels(anchor) {
  const step = state.step;

  const sells = [];
  for (let i = state.levelsAbove; i >= 1; i--) {
    sells.push(round2(anchor + step * i));
  }

  const buys = [];
  for (let i = 1; i <= state.levelsBelow; i++) {
    buys.push(round2(anchor - step * i));
  }

  return { sells, buys };
}

// =====================
// P/L helpers
// =====================
function computeUnrealizedPnl(currentPrice) {
  let u = 0;
  for (const k of Object.keys(state.positions)) {
    const pos = state.positions[k];
    u += (currentPrice - pos.entryPrice) * pos.qtySol;
  }
  return round2(u);
}

function computeAverageEntry() {
  let totalQty = 0;
  let totalCost = 0;

  for (const k of Object.keys(state.positions)) {
    const pos = state.positions[k];
    totalQty += pos.qtySol;
    totalCost += pos.qtySol * pos.entryPrice;
  }

  if (totalQty === 0) return null;
  return round2(totalCost / totalQty);
}

// =====================
// PACKET / POSITION STATS
// =====================
function computeStats(currentPrice = null) {
  const trades = Array.isArray(state.trades) ? state.trades : [];

  const buysFilled = trades.filter((t) => t.side === "BUY").length;
  const sellsFilled = trades.filter((t) => t.side === "SELL").length;

  const openPositions = Math.max(0, buysFilled - sellsFilled);

  const buyCapacity = Number(state.packets?.buyCapacity || 0);
  const sellCapacity = Number(state.packets?.sellCapacity || 0);

  const unmatchedPositions = Math.max(0, openPositions - sellCapacity);

  const unrealized = currentPrice != null ? computeUnrealizedPnl(currentPrice) : 0;
  const totalPnl = round2(state.realizedPnl + unrealized);

  return {
    totalTrades: trades.length,
    buysFilled,
    sellsFilled,
    openPositions,
    unmatchedPositions,
    buyCapacity,
    sellCapacity,
    pnl: {
      realized: round2(state.realizedPnl),
      unrealized,
      total: totalPnl,
    },
  };
}

function canPlaceAnotherBuy() {
  const stats = computeStats(state.lastPrice);
  return stats.openPositions + 1 <= stats.sellCapacity;
}

function ensureGridInitialized(price) {
  if (state.anchor != null) return;

  const step = state.step;
  const anchor = round2(Math.round(price / step) * step);
  state.anchor = anchor;

  const { sells, buys } = buildLevels(anchor);

  for (const p of sells) state.levelStates[levelKey("S", p)] ||= "WAIT";
  for (const p of buys) state.levelStates[levelKey("B", p)] ||= "WAIT";

  saveState();
  console.log(`GRID_INIT anchor=${fmt2(anchor)} step=${fmt2(step)} sells=${sells.length} buys=${buys.length}`);
}

// =====================
// Price fetch
// =====================
async function priceFromCoinbase() {
  const res = await axios.get("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
    timeout: TIMEOUT_MS,
  });
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase bad price");
  return price;
}

// =====================
// Strategy (paper grid)
// =====================
function markHits(currentPrice) {
  if (state.anchor == null) return;

  const { sells, buys } = buildLevels(state.anchor);

  for (const p of sells) {
    const k = levelKey("S", p);
    if ((state.levelStates[k] || "WAIT") === "WAIT" && currentPrice >= p) state.levelStates[k] = "HIT";
  }

  for (const p of buys) {
    const k = levelKey("B", p);
    if ((state.levelStates[k] || "WAIT") === "WAIT" && currentPrice <= p) state.levelStates[k] = "HIT";
  }
}

function tryExecuteBuys(currentPrice) {
  if (state.anchor == null) return;

  const { buys } = buildLevels(state.anchor);

  for (const p of buys) {
    const k = levelKey("B", p);
    const st = state.levelStates[k] || "WAIT";

    if ((st === "HIT" || st === "WAIT") && currentPrice <= p) {
      if (state.positions[k]) {
        state.levelStates[k] = "FILLED";
        continue;
      }

      if (!canPlaceAnotherBuy()) {
        state.levelStates[k] = "HIT";
        state.lastError = `BUY_BLOCKED: sell packets exhausted (sellCapacity=${state.packets.sellCapacity}).`;
        const s = computeStats(currentPrice);
        console.log(`[GUARD] BUY blocked at L${fmt2(p)} | open=${s.openPositions} sellCap=${s.sellCapacity}`);
        return;
      }

      const usd = USD_PER_BUY;
      if (state.usdc < usd) continue;

      const qtySol = usd / currentPrice;

      state.usdc = round2(state.usdc - usd);
      state.sol = state.sol + qtySol;

      state.positions[k] = { qtySol, entryPrice: currentPrice, openedAt: new Date().toISOString() };
      state.levelStates[k] = "FILLED";

      const trade = {
        id: `T${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        side: "BUY",
        level: fmt2(p),
        price: round2(currentPrice),
        qtySol: qtySol,
        pnl: 0,
        at: new Date().toISOString(),
      };
      state.trades.push(trade);
      clampTrades();

      state.lastError = null;

      console.log(
        `BUY  level=${trade.level} price=${fmt2(trade.price)} qtySol=${trade.qtySol.toFixed(6)} usdc=${fmt2(state.usdc)} sol=${state.sol.toFixed(6)}`
      );
    }
  }
}

function tryExecuteSells(currentPrice) {
  if (state.anchor == null) return;

  const { sells } = buildLevels(state.anchor);
  const reached = sells.filter((p) => currentPrice >= p);
  if (reached.length === 0) return;

  const sellLevel = Math.min(...reached);
  const sellKey = levelKey("S", sellLevel);
  if ((state.levelStates[sellKey] || "WAIT") === "WAIT") state.levelStates[sellKey] = "HIT";

  const openKeys = Object.keys(state.positions);
  if (openKeys.length === 0) return;

  const buyTrades = state.trades.filter((t) => t.side === "BUY");
  let posKey = null;

  for (const t of buyTrades) {
    const k = levelKey("B", Number(t.level));
    if (state.positions[k]) {
      posKey = k;
      break;
    }
  }
  if (!posKey) posKey = openKeys[0];

  const pos = state.positions[posKey];
  if (!pos) return;

  const qtySol = pos.qtySol;

  if (state.sol + 1e-12 < qtySol) {
    state.lastError = "Not enough SOL to sell (paper mismatch)";
    return;
  }

  const usdProceeds = qtySol * currentPrice;

  state.sol = state.sol - qtySol;
  state.usdc = round2(state.usdc + usdProceeds);

  const pnl = (currentPrice - pos.entryPrice) * qtySol;
  state.realizedPnl = round2(state.realizedPnl + pnl);

  delete state.positions[posKey];

  const trade = {
    id: `T${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    side: "SELL",
    level: fmt2(sellLevel),
    price: round2(currentPrice),
    qtySol: qtySol,
    pnl: round2(pnl),
    at: new Date().toISOString(),
  };
  state.trades.push(trade);
  clampTrades();

  state.levelStates[sellKey] = "FILLED";
  state.lastError = null;

  console.log(
    `SELL level=${trade.level} price=${fmt2(trade.price)} qtySol=${trade.qtySol.toFixed(6)} pnl=${fmt2(trade.pnl)} usdc=${fmt2(state.usdc)} sol=${state.sol.toFixed(6)}`
  );
}

// =====================
// Realignment placeholder
// =====================
function maybeSuggestRealignment(currentPrice) {
  if (state.anchor == null) return;

  const rangeTop = state.anchor + state.step * state.levelsAbove;
  const rangeBot = state.anchor - state.step * state.levelsBelow;

  const outOfRange = currentPrice > rangeTop || currentPrice < rangeBot;
  if (!outOfRange) return;

  const now = Date.now();
  const last = state.realign?.lastSuggestedAt ? Date.parse(state.realign.lastSuggestedAt) : 0;
  if (now - last < 15 * 60 * 1000) return;

  state.realign.lastSuggestedAt = new Date().toISOString();
  state.realign.lastSuggestedReason = `Price ${fmt2(currentPrice)} out of ladder range (${fmt2(rangeBot)}–${fmt2(rangeTop)}). Realignment TBD.`;

  console.log("REALIGN_SUGGESTED", state.realign.lastSuggestedReason);
}

// =====================
// Dashboard
// =====================
function htmlEscape(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderDashboard() {
  const p = state.lastPrice;
  const anchor = state.anchor;
  const { sells, buys } = anchor != null ? buildLevels(anchor) : { sells: [], buys: [] };

  const stats = computeStats(p);
  const avgEntry = computeAverageEntry();
  const breakeven = avgEntry;

  const rows = [];

  for (const sp of sells) {
    const k = levelKey("S", sp);
    const st = state.levelStates[k] || "WAIT";
    rows.push({ type: "SELL", price: sp, state: st });
  }

  rows.push({ type: "NOW", price: p, state: "NOW" });

  for (const bp of buys) {
    const k = levelKey("B", bp);
    const st = state.levelStates[k] || "WAIT";
    rows.push({ type: "BUY", price: bp, state: st });
  }

  const lastTrades = state.trades.slice(-10).reverse();

  const css = `
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0f14;color:#e8eef6}
    .wrap{max-width:560px;margin:0 auto;padding:14px}
    .card{background:#121a23;border:1px solid #1f2a36;border-radius:14px;padding:12px}
    .label{opacity:.75;font-size:12px}
    .val{font-size:18px;font-weight:700;margin-top:2px}
    .muted{opacity:.7;font-size:12px;margin-top:4px}

    .banner{border-radius:16px;padding:12px 12px;margin-bottom:12px;border:1px solid #1f2a36;background:#0f141b}
    .banner.ok{border-color:rgba(80,255,140,.28);background:rgba(80,255,140,.07)}
    .banner.warn{border-color:rgba(255,80,80,.35);background:rgba(255,80,80,.10)}
    .bigline{font-size:16px;font-weight:900}
    .pillrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .pill{font-size:12px;opacity:.9;border:1px solid #2b3442;border-radius:999px;padding:4px 10px;background:rgba(255,255,255,.04)}

    .top{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}

    .row{display:flex;align-items:center;justify-content:space-between;border-radius:14px;padding:12px 14px;margin:8px 0;border:1px solid #1f2a36;background:#101720}
    .row .left{font-weight:900}
    .row .right{font-weight:900;font-size:20px}

    .SELL{background:#1a0f12;border-color:#3a1f24}
    .BUY{background:#0f1a13;border-color:#1f3a28}
    .NOW{background:#161b22;border-color:#2b3442}

    .HIT{outline:2px solid rgba(255,255,255,.18)}
    .FILLED{box-shadow:0 0 0 2px rgba(255,255,255,.12) inset}

    .badge{font-size:11px;opacity:.8;border:1px solid #2b3442;border-radius:999px;padding:2px 8px}

    .trade{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:14px;border:1px solid #1f2a36;background:#0f141b;margin:8px 0}
    .trade .a{font-weight:900}
    .trade .b{opacity:.8}
  `;

  const bannerClass = stats.unmatchedPositions > 0 ? "banner warn" : "banner ok";
  const bannerTitle = stats.unmatchedPositions > 0
    ? `⚠ Unmatched positions: ${stats.unmatchedPositions}`
    : `✅ Matched: sells can cover open positions`;

  const bannerHtml = `
    <div class="${bannerClass}">
      <div class="bigline">${bannerTitle}</div>
      <div class="muted" style="margin-top:6px">
        Trades ${stats.totalTrades} • Buys ${stats.buysFilled} • Sells ${stats.sellsFilled}
      </div>
      <div class="pillrow">
        <div class="pill">Open positions: <b>${stats.openPositions}</b></div>
        <div class="pill">Sell packets: <b>${stats.sellCapacity}</b></div>
        <div class="pill">Buy packets: <b>${stats.buyCapacity}</b></div>
        <div class="pill">Guard: blocks BUY when open+1 &gt; sell packets</div>
      </div>
      ${
        avgEntry
          ? `<div class="muted" style="margin-top:8px">Avg entry ${fmt2(avgEntry)} • Breakeven ${fmt2(breakeven)}</div>`
          : `<div class="muted" style="margin-top:8px">Avg entry — • Breakeven —</div>`
      }
      ${state.lastError ? `<div class="muted" style="margin-top:8px">Last error: ${htmlEscape(state.lastError)}</div>` : ``}
    </div>
  `;

  const ladderHtml = rows
    .map((r) => {
      if (r.type === "NOW") {
        const nowPrice = p != null ? fmt2(p) : "—";
        const updated = state.lastAt ? new Date(state.lastAt).toLocaleTimeString("en-GB") : "—";
        return `
          <div class="row NOW">
            <div>
              <div class="left">NOW <span class="badge">RUNNING</span></div>
              <div class="muted">Updated: ${htmlEscape(updated)}</div>
              <div class="muted">Anchor: ${anchor != null ? fmt2(anchor) : "—"} • Step: ${fmt2(state.step)}</div>
            </div>
            <div class="right">${htmlEscape(nowPrice)}</div>
          </div>
        `;
      }

      const cls = `${r.type} ${r.state === "HIT" ? "HIT" : ""} ${r.state === "FILLED" ? "FILLED" : ""}`;
      const badge =
        r.state === "FILLED" ? `<span class="badge">FILLED</span>` :
        r.state === "HIT" ? `<span class="badge">HIT</span>` :
        `<span class="badge">WAIT</span>`;

      return `
        <div class="row ${cls}">
          <div class="left">${r.type} ${badge}</div>
          <div class="right">${fmt2(r.price)}</div>
        </div>
      `;
    })
    .join("");

  const tradesHtml = lastTrades
    .map((t) => {
      const pnlTxt = t.side === "SELL" ? `PnL ${fmt2(t.pnl)}` : "";
      const time = new Date(t.at).toLocaleTimeString("en-GB");
      return `
        <div class="trade">
          <div>
            <div class="a">${htmlEscape(t.side)} @ ${fmt2(t.price)} <span class="badge">L${htmlEscape(t.level)}</span></div>
            <div class="b">${htmlEscape(time)} • qty ${t.qtySol.toFixed(6)} ${pnlTxt ? "• " + htmlEscape(pnlTxt) : ""}</div>
          </div>
          <div class="b">#${htmlEscape(t.id)}</div>
        </div>
      `;
    })
    .join("");

  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <meta http-equiv="refresh" content="5">
      <title>Grid Bot</title>
      <style>${css}</style>
    </head>
    <body>
      <div class="wrap">
        ${bannerHtml}

        <div class="top">
          <div class="card">
            <div class="label">Balances</div>
            <div class="val">USDC ${fmt2(state.usdc)}</div>
            <div class="val">SOL ${state.sol.toFixed(6)}</div>
          </div>
          <div class="card">
            <div class="label">P/L</div>
            <div class="val">Realized ${fmt2(stats.pnl.realized)}</div>
            <div class="val">Unrealized ${fmt2(stats.pnl.unrealized)}</div>
            <div class="muted">Total ${fmt2(stats.pnl.total)}</div>
          </div>
        </div>

        <div class="card">
          <div class="label">Ladder (fixed levels; colour/state changes)</div>
          <div class="muted">${htmlEscape(state.realign?.note || "")}${state.realign?.lastSuggestedReason ? " • " + htmlEscape(state.realign.lastSuggestedReason) : ""}</div>
          <div class="ladder">
            ${ladderHtml}
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="label">Last 10 trades</div>
          ${tradesHtml || `<div class="muted">No trades yet.</div>`}
        </div>
      </div>
    </body>
    </html>
  `;
}

function getStatus() {
  const p = state.lastPrice;
  const stats = computeStats(p);
  const avgEntry = computeAverageEntry();
  const breakeven = avgEntry;

  return {
    now: new Date().toISOString(),
    lastPrice: state.lastPrice,
    lastAt: state.lastAt,
    anchor: state.anchor,
    step: state.step,
    balances: { usdc: state.usdc, sol: state.sol },
    pnl: stats.pnl,
    avgEntry,
    breakeven,
    packets: {
      buyCapacity: stats.buyCapacity,
      sellCapacity: stats.sellCapacity,
      openPositions: stats.openPositions,
      unmatchedPositions: stats.unmatchedPositions,
      guardAllowsBuy: canPlaceAnotherBuy(),
    },
    tick: state.tick,
    hb: state.hb,
    trades: state.trades.slice(-20),
    realign: state.realign,
    lastError: state.lastError,
  };
}

// =====================
// HTTP server
// =====================
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(getStatus(), null, 2));
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderDashboard());
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP_LISTENING ${PORT}`);
  });

// =====================
// Keepalive
// =====================
async function keepAlive() {
  try {
    await axios.get(`http://127.0.0.1:${PORT}/health`, { timeout: 5000 });
    if (SERVICE_URL) await axios.get(`${SERVICE_URL}/health`, { timeout: 8000 });
    console.log("KEEPALIVE ok");
  } catch (err) {
    console.log(`KEEPALIVE_FAILED | ${err?.message || err}`);
  }
}

// =====================
// Main loops
// =====================
async function tick() {
  state.tick += 1;

  try {
    const price = await priceFromCoinbase();

    state.lastPrice = round2(price);
    state.lastAt = new Date().toISOString();
    state.lastError = null;

    ensureGridInitialized(state.lastPrice);

    markHits(state.lastPrice);
    tryExecuteBuys(state.lastPrice);
    tryExecuteSells(state.lastPrice);

    maybeSuggestRealignment(state.lastPrice);

    saveState();

    console.log(`PRICE ${fmt2(state.lastPrice)} | TICK ${state.tick} | coinbase`);
  } catch (err) {
    state.lastError = err?.message || String(err);
    console.log(`PRICE_FETCH_FAILED | ${state.lastError}`);
    saveState();
  }
}

function heartbeat() {
  state.hb += 1;
  console.log(`HEARTBEAT ${state.hb}`);
  if (state.hb % 5 === 0) saveState();
}

process.on("unhandledRejection", (e) => console.log("UNHANDLED_REJECTION", String(e)));
process.on("uncaughtException", (e) => console.log("UNCAUGHT_EXCEPTION", String(e)));

loadState();
heartbeat();
tick();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(tick, PRICE_INTERVAL_MS);
setInterval(keepAlive, KEEPALIVE_MS);
