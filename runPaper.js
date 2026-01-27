
import "dotenv/config";
import axios from "axios";
import dns from "node:dns"
import http from "node:http";

const PORT = process.env.PORT

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
}).listen(PORT, () => {
  console.log(new Date().toISOString(), `HTTP server listening on ${PORT}`);
});
dns.setServers(["1.1.1.1", "1.0.0.1"]); // Cloudflare DNS
dns.setDefaultResultOrder("ipv4first");

console.log("BOOTED OK");
// ---------------- CONFIG ----------------
const POLL_MS = Number(process.env.POLL_MS ?? 4000);
const START_USDC = Number(process.env.START_USDC ?? 50);
const START_SOL_USDC_WORTH = Number(process.env.START_SOL_USDC_WORTH ?? 50);

const USDC_MINT = process.env.INPUT_MINT_USDC;
const SOL_MINT = process.env.OUTPUT_MINT_SOL;

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50);

// ---------------------------------------

const USDC_DEC = 1e6;
const SOL_DEC = 1e9;

let usdc = START_USDC;
let sol = 0;
let lastPrice = null;
let priceBuffer = [];
async function main() {
  console.log("Paper bot started");
  while (true) {
  try {
    const price = await getMidPrice();

    // --- PRICE SMOOTHER (3-point moving average) ---
    priceBuffer.push(price);
    if (priceBuffer.length > 3) priceBuffer.shift();

    const smoothPrice =
      priceBuffer.reduce((a, b) => a + b, 0) / priceBuffer.length;

    console.log(new Date().toISOString(), "SOL price:", smoothPrice.toFixed(2));
  } catch (err) {
    console.log(
      new Date().toISOString(),
      "PRICE FETCH FAILED:",
      err?.code || err?.message || err
    );
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}
}
async function getMidPrice() {
const res = await axios.get(
  "https://api.coingecko.com/api/v3/simple/price",
  { params: { ids: "solana", vs_currencies: "usd" } }
);
  return res.data.solana.usd;
}

main().catch(console.error);
