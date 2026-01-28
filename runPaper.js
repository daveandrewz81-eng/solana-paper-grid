import axios from "axios";
import http from "http";

console.log("BOOTED OK - Web-service mode (opens a port for Render)");

// ---- Tiny server so Render sees an open port ----
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Price bot running. /health");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(new Date().toISOString(), `HTTP server listening on ${PORT}`);
});

// ---- Price loop ----
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ONE_SOL = 1_000_000_000;

async function fetchSolPrice() {
  try {
    const url =
      "https://quote-api.jup.ag/v6/quote" +
      `?inputMint=${SOL_MINT}` +
      `&outputMint=${USDC_MINT}` +
      `&amount=${ONE_SOL}` +
      "&slippageBps=50";

    const res = await axios.get(url, { timeout: 15000 });

    const outAmount = res?.data?.outAmount;
    if (!outAmount) throw new Error("No outAmount in response");

    const price = Number(outAmount) / 1_000_000; // USDC has 6 decimals
    if (!Number.isFinite(price)) throw new Error("Bad price conversion");

    console.log(new Date().toISOString(), "SOL/USDC:", price.toFixed(2));
  } catch (err) {
    console.error(
      new Date().toISOString(),
      "PRICE_FETCH_FAILED",
      err?.message || err
    );
  }
}

fetchSolPrice();
setInterval(fetchSolPrice, 60_000);
