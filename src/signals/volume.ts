import { config } from "../config.js";
import { shortId } from "../util/logger.js";
import { bus, tracker } from "./bus.js";

/**
 * Volume-threshold detector. Evaluated on every trade tick: when a token's
 * rolling buy volume and unique-buyer count cross the configured thresholds,
 * a "volume-threshold" signal fires (once per cooldown per token).
 */
const COOLDOWN_MS = 5 * 60_000;
const lastSignal = new Map<string, number>();

export function startVolumeDetector(): void {
  bus.on("trade", (trade) => {
    if (trade.side !== "buy") return;
    const t = tracker.get(trade.mint);
    if (!t) return;

    const now = Date.now();
    const last = lastSignal.get(trade.mint) ?? 0;
    if (now - last < COOLDOWN_MS) return;

    const windowMs = config.volume.windowSec * 1000;
    const recent = t.buys.filter((b) => now - b.at < windowMs);
    const buySol = recent.reduce((s, b) => s + b.sol, 0);
    const uniqueBuyers = new Set(recent.map((b) => b.buyer)).size;

    if (buySol >= config.volume.thresholdSol && uniqueBuyers >= config.volume.minUniqueBuyers) {
      lastSignal.set(trade.mint, now);
      tracker.recordSignal({
        id: shortId(),
        source: "volume-threshold",
        mint: trade.mint,
        symbol: t.symbol,
        at: now,
        strength: Math.min(
          100,
          Math.round((buySol / config.volume.thresholdSol) * 50 + (uniqueBuyers / config.volume.minUniqueBuyers) * 30),
        ),
        detail: `${buySol.toFixed(1)} SOL buy volume from ${uniqueBuyers} wallets in ${config.volume.windowSec}s`,
        mcUsd: t.mcUsd,
      });
    }
  });
}
