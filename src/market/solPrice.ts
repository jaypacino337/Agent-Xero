import { log } from "../util/logger.js";

let solUsd = 0;
let lastFetch = 0;

async function fetchPrice(): Promise<void> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { solana?: { usd?: number } };
    if (json.solana?.usd) {
      solUsd = json.solana.usd;
      lastFetch = Date.now();
    }
  } catch (err) {
    log.warn("sol-price", "price fetch failed", err);
  }
}

export function startSolPriceFeed(): void {
  void fetchPrice();
  setInterval(() => void fetchPrice(), 60_000).unref();
}

/** Current SOL/USD, 0 if not yet fetched. */
export function getSolUsd(): number {
  return solUsd;
}

export function solToUsd(sol: number): number {
  return sol * solUsd;
}

export function priceFeedHealthy(): boolean {
  return solUsd > 0 && Date.now() - lastFetch < 10 * 60_000;
}
