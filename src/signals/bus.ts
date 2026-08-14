import { EventEmitter } from "node:events";
import type { Signal, TokenState } from "../types.js";
import { config } from "../config.js";
import { solToUsd } from "../market/solPrice.js";

export interface RawTrade {
  mint: string;
  trader: string;
  side: "buy" | "sell";
  sol: number;
  tokenAmount: number;
  marketCapSol?: number;
  symbol?: string;
  name?: string;
  at: number;
}

interface BusEvents {
  signal: [Signal];
  trade: [RawTrade];
  "token-update": [TokenState];
}

class SignalBus extends EventEmitter<BusEvents> {}
export const bus = new SignalBus();

/** In-memory rolling state per token. Old tokens are evicted to bound memory. */
class TokenTracker {
  private tokens = new Map<string, TokenState>();
  private readonly maxTokens = 3000;

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  getOrCreate(mint: string): TokenState {
    let t = this.tokens.get(mint);
    if (!t) {
      t = { mint, buys: [], smartWalletBuys: [], signals: [] };
      this.tokens.set(mint, t);
      if (this.tokens.size > this.maxTokens) this.evictOldest();
    }
    return t;
  }

  recordTrade(trade: RawTrade): TokenState {
    const t = this.getOrCreate(trade.mint);
    if (trade.symbol) t.symbol = trade.symbol;
    if (trade.name) t.name = trade.name;
    if (trade.marketCapSol !== undefined) {
      t.mcUsd = solToUsd(trade.marketCapSol);
    }
    if (trade.tokenAmount > 0 && trade.sol > 0) {
      t.priceSol = trade.sol / trade.tokenAmount;
    }
    if (trade.side === "buy") {
      t.buys.push({ at: trade.at, sol: trade.sol, buyer: trade.trader });
      const cutoff = trade.at - config.volume.windowSec * 1000 * 3;
      while (t.buys.length && t.buys[0].at < cutoff) t.buys.shift();
    }
    bus.emit("trade", trade);
    bus.emit("token-update", t);
    return t;
  }

  recordSignal(signal: Signal): void {
    const t = this.getOrCreate(signal.mint);
    if (signal.symbol && !t.symbol) t.symbol = signal.symbol;
    t.signals.push(signal);
    // keep only recent signals
    const cutoff = Date.now() - 30 * 60_000;
    t.signals = t.signals.filter((s) => s.at > cutoff);
    bus.emit("signal", signal);
  }

  private evictOldest(): void {
    // evict tokens with no recent activity
    const now = Date.now();
    for (const [mint, t] of this.tokens) {
      const lastBuy = t.buys.at(-1)?.at ?? t.createdAt ?? 0;
      if (now - lastBuy > 30 * 60_000) {
        this.tokens.delete(mint);
        if (this.tokens.size <= this.maxTokens * 0.9) break;
      }
    }
  }
}

export const tracker = new TokenTracker();
