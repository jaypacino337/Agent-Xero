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
      // split profit between buyback-and-burn and the holder airdrop pool;
      // anything not allocated stays in the trading treasury (compounding)
      const airdropPct = config.airdrop.enabled ? config.airdrop.profitPct : 0;
      const scale = Math.min(1, 100 / (config.xero.buybackProfitPct + airdropPct));
      const toBuyback = pnl * (config.xero.buybackProfitPct / 100) * scale;
      const toAirdrop = pnl * (airdropPct / 100) * scale;
      db.treasury.tradingSol -= toBuyback + toAirdrop;
      db.treasury.pendingBuybackSol += toBuyback;
      db.treasury.pendingAirdropSol += toAirdrop;
      log.info(
        "treasury",
        `profit split: ${toBuyback.toFixed(3)} SOL -> buyback, ${toAirdrop.toFixed(3)} SOL -> airdrop pool`,
      );
    }
    db.markDirty("treasury");
  },

  /**
   * Callout rewards (pump.fun fee-share payouts earned from calls).
   * Default: 100% to the holder airdrop pool, remainder to buyback.
   */
  recordCalloutProfit(sol: number): void {
    db.treasury.totalCalloutProfitSol += sol;
    const pct = config.airdrop.enabled ? config.airdrop.calloutRewardsPct : 0;
    const toAirdrop = sol * (pct / 100);
    db.treasury.pendingAirdropSol += toAirdrop;
    db.treasury.pendingBuybackSol += sol - toAirdrop;
    db.markDirty("treasury");
    log.info(
      "treasury",
      `+${sol.toFixed(3)} SOL callout rewards (${toAirdrop.toFixed(3)} -> holder airdrops, ${(sol - toAirdrop).toFixed(3)} -> buyback)`,
    );
  },
};
