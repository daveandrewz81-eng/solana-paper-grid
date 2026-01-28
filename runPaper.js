import axios from "axios";
import http from "http";
import dns from "dns";

console.log("BOOTED OK - keepalive + heartbeat enabled");

// ---- DNS hardening (stops ENOTFOUND flakiness) ----
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// ---- HTTP server (Render web service needs an open port) ----
const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Price bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP_LISTENING ${PORT}`);
  });

// ---- Config ----
const TIMEOUT_MS = 15000;
const PRICE_INTERVAL_MS = 30_000;     // price print rate (test)
const HEARTBEAT_MS = 10_000;          // visible "I'm alive" log
const KEEPALIVE_MS = 30_000;          // keep Render awake

// IMPORTANT: set this in Render as an env var if possible:
// SERVICE_URL = https://<your-service>.onrender.com
const SERVICE_URL = process.env.SERVICE_URL || "";

// ---- Price (Coinbase) ----
async function priceFromCoinbase() {
  const res = await axios.get(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    { timeout: TIMEOUT_MS }
  );
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase bad price");
  return price;
}

// ---- Logging counters ----
let tick = 0;
let hb = 0;

async function tickPrice() {
  try {
    const price = await priceFromCoinbase();
    tick += 1;
    console.log(`PRICE ${price.toFixed(2)} | TICK ${tick} | coinbase`);
  } catch (err) {
    console.log(`PRICE_FETCH_FAILED | ${err?.message || err}`);
  }
}

function heartbeat() {
  hb += 1;
  console.log(`HEARTBEAT ${hb}`);
}

// ---- Keepalive (prevents spin-down) ----
async function keepAlive() {
  try {
    // Always ping local server (keeps event loop busy)
    await axios.get(`http://127.0.0.1:${PORT}/health`, { timeout: 5000 });

    // If you set SERVICE_URL in Render, also ping the public URL (prevents free-tier spin-down)
    if (SERVICE_URL) {
      await axios.get(`${SERVICE_URL}/health`, { timeout: 8000 });
    }

    console.log("KEEPALIVE ok");
  } catch (err) {
    console.log(`KEEPALIVE_FAILED | ${err?.message || err}`);
  }
}

// ---- Start loops ----
heartbeat();
tickPrice();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(tickPrice, PRICE_INTERVAL_MS);
setInterval(keepAlive, KEEPALIVE_MS);

// ---- Safety: don't die silently ----
process.on("unhandledRejection", (e) => console.log("UNHANDLED_REJECTION", String(e)));
process.on("uncaughtException", (e) => console.log("UNCAUGHT_EXCEPTION", String(e)));
