
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
const POLL_MS = Number(process.env.POLL_MS ?? 15000);
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
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = err?.message || err?.code || String(err);

  console.log(
  `${new Date().toISOString()} PRICE_FETCH_FAILED msg=${msg} status=${status} data=${JSON.stringify(data)?.slice(0,200)}`
);
}

  await new Promise((r) => setTimeout(r, POLL_MS));
}
}
async function getMidPrice() {
  const inputMint = "So11111111111111111111111111111111111111112"; // SOL
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  const amount = 1_000_000_000; // 1 SOL (lamports)

  const url =
    `https://quote-api.jup.ag/v6/quote` +
    `?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amount}` +
    `&swapMode=ExactIn` +
    `&slippageBps=50`;

  const res = await axios.get(url, {
    timeout: 10_000,
    headers: { "User-Agent": "paper-bot", "Accept": "application/json" },
  });

const route = res.data?.data?.[0];
const outAmount = Number(route?.outAmount);

if (!outAmount || !Number.isFinite(outAmount)) {
  throw new Error("No outAmount from Jupiter v6");
}

return outAmount / 1_000_000; // USDC per 1 SOL
} 

main().catch(console.error);
