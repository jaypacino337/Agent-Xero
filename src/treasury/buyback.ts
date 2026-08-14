import { config } from "../config.js";
import { executeTrade } from "../execution/pumpportal.js";
import { tracker } from "../signals/bus.js";
import { db } from "../store/db.js";
import type { BurnEvent } from "../types.js";
import { log, shortId } from "../util/logger.js";

/**
 * Buyback & burn engine for $XERO.
 *
 * Whenever the pending pool crosses BUYBACK_MIN_SOL, the accumulated SOL is
 * used to market-buy $XERO. In paper mode the fill is simulated at the last
 * observed price. In live mode the buy executes via PumpPortal; the burn
 * (SPL transfer to the incinerator) must currently be executed by the
 * operator wallet — the event is recorded with burnTx left empty until it is
 * confirmed (see README "Live burns").
 */
export class BuybackEngine {
  private running = false;
  onBurn?: (event: BurnEvent) => void;

  start(): void {
    setInterval(() => void this.tick(), 60_000).unref();
    log.info(
      "buyback",
      `engine armed (min ${config.xero.buybackMinSol} SOL, ${config.xero.buybackProfitPct}% of profits)`,
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (!config.xero.mint) return;
    if (db.treasury.pendingBuybackSol < config.xero.buybackMinSol) return;

    this.running = true;
    try {
      await this.executeBuyback(db.treasury.pendingBuybackSol);
    } catch (err) {
      log.error("buyback", "buyback failed", err);
    } finally {
      this.running = false;
    }
  }

  private async executeBuyback(sol: number): Promise<void> {
    let buyTx: string | undefined;
    let xeroBought = 0;

    if (config.paperTrading) {
      const price = tracker.get(config.xero.mint)?.priceSol;
      // if we have no live price for XERO yet, simulate a nominal fill
      xeroBought = price && price > 0 ? sol / price : sol * 1_000_000;
    } else {
      const result = await executeTrade({
        action: "buy",
        mint: config.xero.mint,
        amount: sol,
        denominatedInSol: true,
      });
      if (!result.ok) {
        log.error("buyback", `live buyback failed: ${result.error}`);
        return;
      }
      buyTx = result.signature;
      const price = tracker.get(config.xero.mint)?.priceSol;
      xeroBought = price && price > 0 ? sol / price : 0;
    }

    const event: BurnEvent = {
      id: shortId(),
      at: Date.now(),
      solSpent: sol,
      xeroBought,
      xeroBurned: xeroBought,
      buyTx,
      fundedBy: "trading-profit",
      paper: config.paperTrading,
    };
    db.burns.push(event);
    db.treasury.pendingBuybackSol -= sol;
    db.treasury.totalBuybackSol += sol;
    db.treasury.totalXeroBurned += event.xeroBurned;
    db.markDirty("burns", "treasury");
    log.info(
      "buyback",
      `🔥 bought back ${sol.toFixed(3)} SOL of $XERO (${xeroBought.toFixed(0)} tokens) -> burn`,
    );
    this.onBurn?.(event);
  }
}
