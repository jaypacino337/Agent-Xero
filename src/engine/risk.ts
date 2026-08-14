import { config } from "../config.js";
import { db } from "../store/db.js";
import { log } from "../util/logger.js";

/**
 * Risk gate. Every prospective entry passes through here.
 */
class RiskManager {
  halted = false;

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  realizedPnlToday(): number {
    const today = this.dayKey();
    return db.positions
      .filter(
        (p) =>
          p.status === "closed" &&
          p.closedAt !== undefined &&
          new Date(p.closedAt).toISOString().slice(0, 10) === today,
      )
      .reduce((s, p) => s + (p.realizedPnlSol ?? 0), 0);
  }

  openPositions(): number {
    return db.positions.filter((p) => p.status === "open").length;
  }

  /** Returns null if the entry is allowed, otherwise the reason it is blocked. */
  entryBlockedReason(solSize: number): string | null {
    if (this.halted) return "trading halted";
    if (this.openPositions() >= config.trading.maxOpenPositions)
      return `max open positions (${config.trading.maxOpenPositions}) reached`;
    if (this.realizedPnlToday() <= -config.trading.dailyLossLimitSol)
      return `daily loss limit (${config.trading.dailyLossLimitSol} SOL) hit`;
    if (db.treasury.tradingSol < solSize)
      return `insufficient treasury (${db.treasury.tradingSol.toFixed(3)} SOL available)`;
    // never buy our own token as a "trade" — buybacks go through the buyback module
    return null;
  }

  halt(): void {
    this.halted = true;
    log.warn("risk", "trading halted");
  }

  resume(): void {
    this.halted = false;
    log.info("risk", "trading resumed");
  }
}

export const risk = new RiskManager();
