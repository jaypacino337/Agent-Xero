import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { executeTrade } from "../execution/pumpportal.js";
import { priceFeedHealthy } from "../market/solPrice.js";
import { bus, tracker } from "../signals/bus.js";
import { db } from "../store/db.js";
import type { Position, SignalSource, TokenState, TradeEvent } from "../types.js";
import { log, shortId } from "../util/logger.js";
import { risk } from "./risk.js";
import { scoreToken } from "./scorer.js";

interface TraderEvents {
  entry: [Position];
  exit: [Position, string];
  "target-hit": [Position];
}

/**
 * The core loop:
 *  - every signal re-scores its token; score >= threshold + mc under the
 *    entry ceiling + risk gate clear -> buy
 *  - every trade tick updates open positions; take-profit at the runner
 *    target, hard stop-loss, and a trailing stop after the target is hit
 *  - realized profit flows to the treasury, which routes it to buyback & burn
 */
export class Trader extends EventEmitter<TraderEvents> {
  private entering = new Set<string>();

  start(): void {
    bus.on("signal", (signal) => void this.considerEntry(signal.mint));
    bus.on("token-update", (token) => void this.managePositions(token));
    log.info(
      "trader",
      `started (${config.paperTrading ? "PAPER" : "LIVE"} mode, ${config.trading.solPerTrade} SOL/trade, entry < $${config.trading.entryMaxMcUsd.toLocaleString()} mc, target $${config.trading.targetMcUsd.toLocaleString()}+)`,
    );
  }

  private async considerEntry(mint: string): Promise<void> {
    if (this.entering.has(mint)) return;
    if (mint === config.xero.mint) return; // buybacks handled separately
    const token = tracker.get(mint);
    if (!token) return;
    if (!priceFeedHealthy()) return;

    // already holding?
    if (db.positions.some((p) => p.mint === mint && p.status === "open")) return;

    const { score, sources } = scoreToken(token);
    if (score < config.trading.minScoreToBuy) return;

    // the strategy: catch prospective runners EARLY — only enter below the mc ceiling
    if (token.mcUsd === undefined || token.mcUsd > config.trading.entryMaxMcUsd) return;
    if (token.priceSol === undefined || token.priceSol <= 0) return;

    const solSize = config.trading.solPerTrade;
    const blocked = risk.entryBlockedReason(solSize);
    if (blocked) {
      log.info("trader", `entry blocked for ${mint.slice(0, 8)}…: ${blocked}`);
      return;
    }

    this.entering.add(mint);
    try {
      await this.openPosition(token, score, sources, solSize);
    } finally {
      this.entering.delete(mint);
    }
  }

  private async openPosition(
    token: TokenState,
    score: number,
    sources: SignalSource[],
    solIn: number,
  ): Promise<void> {
    const price = token.priceSol!;
    let signature: string | undefined;

    if (!config.paperTrading) {
      const result = await executeTrade({
        action: "buy",
        mint: token.mint,
        amount: solIn,
        denominatedInSol: true,
      });
      if (!result.ok) {
        log.error("trader", `live buy failed for ${token.mint}: ${result.error}`);
        return;
      }
      signature = result.signature;
    }

    // paper fill: simulate slippage on thin launches
    const fillPrice = config.paperTrading ? price * 1.03 : price;
    const tokenAmount = solIn / fillPrice;

    const position: Position = {
      id: shortId(),
      mint: token.mint,
      symbol: token.symbol,
      openedAt: Date.now(),
      entryMcUsd: token.mcUsd ?? 0,
      entryPriceSol: fillPrice,
      solIn,
      tokenAmount,
      tokensRemaining: tokenAmount,
      peakMcUsd: token.mcUsd ?? 0,
      targetHit: false,
      status: "open",
      solOut: 0,
      sources,
      score,
      paper: config.paperTrading,
    };
    db.positions.push(position);
    db.treasury.tradingSol -= solIn;
    this.recordTrade({
      side: "buy",
      mint: token.mint,
      symbol: token.symbol,
      sol: solIn,
      tokenAmount,
      mcUsd: token.mcUsd,
      reason: `score ${score} [${sources.join(", ")}]`,
      txSignature: signature,
    });
    db.markDirty("positions", "trades", "treasury");
    log.info(
      "trader",
      `ENTRY ${token.symbol ?? token.mint.slice(0, 8)} @ $${Math.round(position.entryMcUsd).toLocaleString()} mc — score ${score} via ${sources.join("+")}`,
    );
    this.emit("entry", position);
  }

  private async managePositions(token: TokenState): Promise<void> {
    const open = db.positions.filter(
      (p) => p.status === "open" && p.mint === token.mint,
    );
    if (open.length === 0) return;
    const mc = token.mcUsd;
    const price = token.priceSol;
    if (mc === undefined || price === undefined) return;

    for (const p of open) {
      if (mc > p.peakMcUsd) p.peakMcUsd = mc;

      const drawdownFromEntry = ((p.entryMcUsd - mc) / p.entryMcUsd) * 100;
      const retraceFromPeak =
        p.peakMcUsd > 0 ? ((p.peakMcUsd - mc) / p.peakMcUsd) * 100 : 0;

      // 1. runner target hit -> scale out
      if (!p.targetHit && mc >= config.trading.targetMcUsd) {
        p.targetHit = true;
        const sellTokens = p.tokensRemaining * (config.trading.takeProfitSellPct / 100);
        await this.sell(p, token, sellTokens, `runner target $${config.trading.targetMcUsd.toLocaleString()} hit — scaling out ${config.trading.takeProfitSellPct}%`);
        this.emit("target-hit", p);
        continue;
      }

      // 2. hard stop-loss from entry
      if (!p.targetHit && drawdownFromEntry >= config.trading.stopLossPct) {
        await this.sell(p, token, p.tokensRemaining, `stop-loss ${config.trading.stopLossPct}% from entry`);
        continue;
      }

      // 3. trailing stop after target (protect the runner's gains)
      if (p.targetHit && retraceFromPeak >= config.trading.trailingStopPct) {
        await this.sell(p, token, p.tokensRemaining, `trailing stop ${config.trading.trailingStopPct}% off peak $${Math.round(p.peakMcUsd).toLocaleString()}`);
        continue;
      }
    }
  }

  private async sell(
    p: Position,
    token: TokenState,
    tokens: number,
    reason: string,
  ): Promise<void> {
    if (tokens <= 0) return;
    const price = token.priceSol!;
    let signature: string | undefined;

    if (!p.paper) {
      const result = await executeTrade({
        action: "sell",
        mint: p.mint,
        amount: tokens,
        denominatedInSol: false,
      });
      if (!result.ok) {
        log.error("trader", `live sell failed for ${p.mint}: ${result.error}`);
        return;
      }
      signature = result.signature;
    }

    const fillPrice = p.paper ? price * 0.97 : price;
    const solReceived = tokens * fillPrice;
    p.tokensRemaining -= tokens;
    p.solOut += solReceived;
    db.treasury.tradingSol += solReceived;

    this.recordTrade({
      side: "sell",
      mint: p.mint,
      symbol: p.symbol,
      sol: solReceived,
      tokenAmount: tokens,
      mcUsd: token.mcUsd,
      reason,
      txSignature: signature,
    });

    if (p.tokensRemaining <= p.tokenAmount * 0.001) {
      p.status = "closed";
      p.closedAt = Date.now();
      p.tokensRemaining = 0;
      p.realizedPnlSol = p.solOut - p.solIn;
      p.exitReason = reason;
      log.info(
        "trader",
        `EXIT ${p.symbol ?? p.mint.slice(0, 8)} pnl ${p.realizedPnlSol.toFixed(3)} SOL (${reason})`,
      );
      this.emit("exit", p, reason);
    }
    db.markDirty("positions", "trades", "treasury");
  }

  private recordTrade(t: Omit<TradeEvent, "id" | "at" | "paper">): void {
    const event: TradeEvent = {
      id: shortId(),
      at: Date.now(),
      paper: config.paperTrading,
      ...t,
    };
    db.trades.push(event);
    // keep the log bounded
    if (db.trades.length > 5000) db.trades.splice(0, db.trades.length - 5000);
  }
}
