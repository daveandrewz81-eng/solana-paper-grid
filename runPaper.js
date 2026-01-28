import axios from "axios";
import http from "http";
import dns from "dns";
import fs from "fs";

console.log("BOOTED OK - keepalive + heartbeat enabled");

// DNS hardening
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// HTTP server
const PORT = process.env.PORT || 10000;

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
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Price bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP_LISTENING ${PORT}`);
  });

// Config
const TIMEOUT_MS = 15000;
const PRICE_INTERVAL_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const KEEPALIVE_MS = 30_000;

const SERVICE_URL = process.env.SERVICE_URL || "";

// ---- simple local persistence ----
const STATE_FILE = "./state.json";

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (typeof s.tick === "number") tick = s.tick;
    if (typeof s.hb === "number") hb = s.hb;
    if (typeof s.lastPrice === "number") lastPrice = s.lastPrice;
    if (typeof s.lastAt === "string") lastAt = s.lastAt;
    console.log(`RESTORED_STATE tick=${tick} hb=${hb} lastPrice=${lastPrice ?? "n/a"} lastAt=${lastAt ?? "n/a"}`);
  } catch (_) {
    // no state yet
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ tick, hb, lastPrice, lastAt }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.log("STATE_SAVE_FAILED", String(e?.message || e));
  }
}

// Price (Coinbase)
async function priceFromCoinbase() {
  const res = await axios.get(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    { timeout: TIMEOUT_MS }
  );
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase bad price");
  return price;
}

// Counters / status
let tick = 0;
let hb = 0;
let lastPrice = null;
let lastAt = null;

function getStatus() {
  return {
    tick,
    hb,
    lastPrice,
    lastAt,
    now: new Date().toISOString(),
  };
}

async function tickPrice() {
  try {
    const price = await priceFromCoinbase();
    tick += 1;
    lastPrice = Number(price.toFixed(2));
    lastAt = new Date().toISOString();
    console.log(`PRICE ${lastPrice.toFixed(2)} | TICK ${tick} | coinbase`);
    saveState();
  } catch (err) {
    console.log(`PRICE_FETCH_FAILED | ${err?.message || err}`);
  }
}

function heartbeat() {
  hb += 1;
  console.log(`HEARTBEAT ${hb}`);
  // save occasionally so hb doesn’t reset too far
  if (hb % 6 === 0) saveState();
}

async function keepAlive() {
  try {
    await axios.get(`http://127.0.0.1:${PORT}/health`, { timeout: 5000 });
    if (SERVICE_URL) {
      await axios.get(`${SERVICE_URL}/health`, { timeout: 8000 });
    }
    // optional: comment out if too spammy
    console.log("KEEPALIVE ok");
  } catch (err) {
    console.log(`KEEPALIVE_FAILED | ${err?.message || err}`);
  }
}

// Start
loadState();
heartbeat();
tickPrice();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(tickPrice, PRICE_INTERVAL_MS);
setInterval(keepAlive, KEEPALIVE_MS);

process.on("unhandledRejection", (e) => console.log("UNHANDLED_REJECTION", String(e)));
process.on("uncaughtException", (e) => console.log("UNCAUGHT_EXCEPTION", String(e)));
