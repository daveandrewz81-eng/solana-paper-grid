import axios from "axios";
import http from "http";
import dns from "dns";

console.log("BOOTED OK - Mobile-friendly price logs");

// ---------------- DNS hardening ----------------
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// ---------------- Tiny HTTP server ----------------
const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Price bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(new Date().toISOString(), `HTTP server listening on ${PORT}`);
  });

// ---------------- Config ----------------
const TIMEOUT_MS = 15000;
const INTERVAL_MS = 30_000;

// ---------------- Price sources ----------------
async function priceFromCoinbase() {
  const res = await axios.get(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    { timeout: TIMEOUT_MS }
  );
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase bad price");
  return { source: "coinbase", price };
}

async function getSolUsdPrice() {
  return priceFromCoinbase(); // primary only to keep logs clean
}

// ---------------- Tick ----------------
async function tick() {
  try {
    const { source, price } = await getSolUsdPrice();

    globalThis.__tick = (globalThis.__tick || 0) + 1;

    console.log(
      `PRICE ${price.toFixed(2)} | TICK ${globalThis.__tick} | ${source}`
    );
  } catch (err) {
    console.error("PRICE_FETCH_FAILED", err?.message || err);
  }
}

// ---------------- Start ----------------
tick();
setInterval(tick, INTERVAL_MS);
