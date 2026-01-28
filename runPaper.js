import axios from "axios";

console.log("BOOTED OK - Paper price bot running");

// SOL → USDC mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 1 SOL in lamports
const ONE_SOL = 1_000_000_000;

// fetch price once
async function fetchSolPrice() {
  try {
    const url =
      "https://quote-api.jup.ag/v6/quote" +
      `?inputMint=${SOL_MINT}` +
      `&outputMint=${USDC_MINT}` +
      `&amount=${ONE_SOL}` +
      "&slippageBps=50";

    const res = await axios.get(url, { timeout: 15000 });

    const outAmount = res.data.outAmount;
    const price = Number(outAmount) / 1_000_000;

    console.log(
      new Date().toISOString(),
      "SOL/USDC:",
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

// run immediately
fetchSolPrice();

// repeat every 60 seconds
setInterval(fetchSolPrice, 60_000);
