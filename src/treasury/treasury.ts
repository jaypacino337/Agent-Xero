import { config } from "../config.js";
import { db } from "../store/db.js";
import type { Position } from "../types.js";
import { log } from "../util/logger.js";

/**
 * Treasury accounting.
 *
 * Inflows:
 *  - pump.fun creator fees (recorded via /fees telegram command or the API) —
 *    these fund the trading treasury
 *  - trading profits — a configurable share is earmarked for buyback & burn
 *  - callout profits — routed to buyback & burn
 *
 * Everything is documented on the site: totals for fees, profit, buybacks
 * and burned $XERO come straight from this ledger.
 */
export const treasury = {
  recordCreatorFees(sol: number): void {
    db.treasury.totalCreatorFeesSol += sol;
    db.treasury.tradingSol += sol;
    db.markDirty("treasury");
    log.info("treasury", `+${sol} SOL creator fees (trading balance ${db.treasury.tradingSol.toFixed(3)})`);
  },

  recordDeposit(sol: number): void {
    db.treasury.tradingSol += sol;
    db.markDirty("treasury");
    log.info("treasury", `+${sol} SOL deposit`);
  },

  /** Called by the trader when a position fully closes. */
  onPositionClosed(p: Position): void {
    const pnl = p.realizedPnlSol ?? 0;
    db.treasury.totalTradingProfitSol += pnl;
    if (pnl > 0) {
      const toBuyback = pnl * (config.xero.buybackProfitPct / 100);
      db.treasury.tradingSol -= toBuyback;
      db.treasury.pendingBuybackSol += toBuyback;
      log.info(
        "treasury",
        `${toBuyback.toFixed(3)} SOL profit earmarked for buyback (pending ${db.treasury.pendingBuybackSol.toFixed(3)})`,
      );
    }
    db.markDirty("treasury");
  },

  /** Callout profits (from the callout tracker) go straight to buyback. */
  recordCalloutProfit(sol: number): void {
    db.treasury.totalCalloutProfitSol += sol;
    db.treasury.pendingBuybackSol += sol;
    db.markDirty("treasury");
    log.info("treasury", `+${sol.toFixed(3)} SOL callout profit -> buyback pool`);
  },
};
