import axios from "axios";
import http from "http";
import dns from "dns";

console.log("BOOTED OK - Free tier price bot with heartbeat");

// ---------------- DNS hardening ----------------
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// ---------------- Tiny HTTP server (keeps Render alive) ----------------
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
const INTERVAL_MS = 30_000; // 30 seconds for testing

// ---------------- Price sources ----------------
async function priceFromCoinbase() {
  const res = await axios.get(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    { timeout: TIMEOUT_MS }
  );
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase: bad price");
  return { source: "coinbase", price };
}

async function priceFromKraken() {
  const res = await axios.get(
    "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
    { timeout: TIMEOUT_MS }
  );
  const obj = res?.data?.result;
  const firstKey = obj && Object.keys(obj)[0];
  const price = Number(firstKey ? obj[firstKey]?.c?.[0] : NaN);
  if (!Number.isFinite(price)) throw new Error("Kraken: bad price");
  return { source: "kraken", price };
}

async function priceFromCoinGecko() {
  const res = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price",
    {
      timeout: TIMEOUT_MS,
      params: { ids: "solana", vs_currencies: "usd" },
      headers: { "User-Agent": "render-sol-price-bot" },
    }
  );
  const price = Number(res?.data?.solana?.usd);
  if (!Number.isFinite(price)) throw new Error("CoinGecko: bad price");
  return { source: "coingecko", price };
}

async function getSolUsdPrice() {
  const fns = [priceFromCoinbase, priceFromKraken, priceFromCoinGecko];
  let lastErr;

  for (const fn of fns) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All sources failed");
}

// ---------------- Main tick loop ----------------
async function tick() {
  try {
    const { source, price } = await getSolUsdPrice();

    globalThis.__tick = (globalThis.__tick || 0) + 1;

    console.log(
      new Date().toISOString(),
      `TICK #${globalThis.__tick} | SOL/USD (${source}):`,
      price.toFixed(2)
    );
  } catch (err) {
    console.error(
      new Date().toISOString(),
      "PRICE_FETCH_FAILED",
      err?.message || err
    );
  }
}

// ---------------- Start ----------------
tick();
setInterval(tick, INTERVAL_MS);
