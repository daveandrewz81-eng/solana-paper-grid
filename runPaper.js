import axios from "axios";
import http from "http";
import dns from "dns";

console.log("BOOTED OK - Multi-source SOL price bot (DNS hardened)");

// --------------------------------------------------
// Force DNS to known-good servers (fixes ENOTFOUND on some hosts)
// --------------------------------------------------
try {
  dns.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
} catch (_) {}

try {
  // Prefer IPv4 where supported (Node 16+)
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// --------------------------------------------------
// Tiny HTTP server so Render Web Service stays alive
// --------------------------------------------------
const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Price bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(new Date().toISOString(), `HTTP server listening on ${PORT}`);
  });

// --------------------------------------------------
// Price sources (no API keys)
// --------------------------------------------------
const TIMEOUT_MS = 15000;
const INTERVAL_MS = 30_000;

async function priceFromCoinbase() {
  const url = "https://api.coinbase.com/v2/prices/SOL-USD/spot";
  const res = await axios.get(url, { timeout: TIMEOUT_MS });
  const price = Number(res?.data?.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Coinbase: bad price");
  return { source: "coinbase", price };
}

async function priceFromKraken() {
  const url = "https://api.kraken.com/0/public/Ticker?pair=SOLUSD";
  const res = await axios.get(url, { timeout: TIMEOUT_MS });
  const obj = res?.data?.result;
  const firstKey = obj && Object.keys(obj)[0];
  const price = Number(firstKey ? obj[firstKey]?.c?.[0] : NaN);
  if (!Number.isFinite(price)) throw new Error("Kraken: bad price");
  return { source: "kraken", price };
}

async function priceFromCoinGecko() {
  const url = "https://api.coingecko.com/api/v3/simple/price";
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    params: { ids: "solana", vs_currencies: "usd" },
    headers: { "User-Agent": "render-sol-price-bot" },
  });
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
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All sources failed");
}

async function tick() {
  try {
    const { source, price } = await getSolUsdPrice();
    console.log(new Date().toISOString(), `SOL/USD (${source}):`, price.toFixed(2));
  } catch (err) {
    // Print FULL details so we stop guessing
    const info = {
      message: err?.message,
      code: err?.code,
      hostname: err?.hostname,
      syscall: err?.syscall,
    };
    console.error(new Date().toISOString(), "PRICE_FETCH_FAILED", JSON.stringify(info));
  }
}

tick();
setInterval(tick, INTERVAL_MS);
