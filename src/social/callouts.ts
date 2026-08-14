import { bus } from "../signals/bus.js";
import { db } from "../store/db.js";
import type { Callout, Position } from "../types.js";
import { treasury } from "../treasury/treasury.js";
import { log, shortId } from "../util/logger.js";

/**
 * Callout tracker — the public, on-site record of every call Xero posts.
 *
 * Each entry Xero takes (and posts about) becomes a callout. We track the
 * peak market cap reached after the call so the site can show the multiple
 * on every call. Callout revenue (e.g. pump.fun fee-share payouts earned
 * from calls) is recorded via the admin API / telegram and routed straight
 * to buyback & burn.
 */
export class CalloutTracker {
  start(): void {
    bus.on("token-update", (token) => {
      const live = db.callouts.filter(
        (c) => c.status === "live" && c.mint === token.mint,
      );
      if (!live.length || token.mcUsd === undefined) return;
      for (const c of live) {
        if (token.mcUsd > c.peakMcUsd) {
          c.peakMcUsd = token.mcUsd;
          c.peakMultiple = c.entryMcUsd > 0 ? token.mcUsd / c.entryMcUsd : 0;
          db.markDirty("callouts");
        }
      }
    });
  }

  open(position: Position, postId?: string): Callout {
    const callout: Callout = {
      id: shortId(),
      at: Date.now(),
      mint: position.mint,
      symbol: position.symbol,
      entryMcUsd: position.entryMcUsd,
      peakMcUsd: position.entryMcUsd,
      peakMultiple: 1,
      postId,
      status: "live",
    };
    db.callouts.push(callout);
    db.markDirty("callouts");
    return callout;
  }

  settle(mint: string): void {
    for (const c of db.callouts) {
      if (c.mint === mint && c.status === "live") {
        c.status = "settled";
        db.markDirty("callouts");
        log.info(
          "callouts",
          `settled ${c.symbol ?? mint.slice(0, 8)} — peak ${c.peakMultiple.toFixed(1)}x`,
        );
      }
    }
  }

  /** External revenue attributable to callouts (e.g. pump.fun fee share). */
  recordProfit(sol: number): void {
    treasury.recordCalloutProfit(sol);
  }
}
