import { config } from "../config.js";
import { getSolUsd, solToUsd } from "../market/solPrice.js";
import { log, shortId } from "../util/logger.js";
import { tracker } from "./bus.js";

/**
 * Pump.fun scanner via the PumpPortal public data websocket.
 *
 * - Subscribes to every new token launch.
 * - Follows trades on recently launched tokens (bounded watchlist).
 * - Emits a "pumpfun-scanner" signal when a fresh token shows early momentum
 *   (buy velocity + unique buyers) while still under the entry market cap.
 */
const WS_URL = "wss://pumpportal.fun/api/data";
const WATCH_LIMIT = 200; // max simultaneously watched fresh tokens
const WATCH_TTL_MS = 20 * 60_000;

interface PortalMsg {
  txType?: "create" | "buy" | "sell";
  mint?: string;
  traderPublicKey?: string;
  solAmount?: number;
  tokenAmount?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  signature?: string;
  message?: string;
}

export class PumpFunScanner {
  private ws?: WebSocket;
  private watched = new Map<string, number>(); // mint -> watchedAt
  private signalled = new Set<string>();
  private reconnectDelay = 1000;
  private stopped = false;

  start(): void {
    this.connect();
    setInterval(() => this.pruneWatchlist(), 60_000).unref();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    log.info("pumpfun", "connecting to PumpPortal data stream");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      // re-subscribe to any tokens we were watching before a reconnect
      const mints = [...this.watched.keys()];
      if (mints.length) {
        ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      }
      log.info("pumpfun", "subscribed to new tokens + migrations");
    });

    ws.addEventListener("message", (ev) => {
      try {
        this.handleMessage(JSON.parse(String(ev.data)) as PortalMsg);
      } catch {
        /* non-JSON keepalive */
      }
    });

    let reconnectScheduled = false;
    ws.addEventListener("close", () => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      log.warn("pumpfun", "websocket error");
      // a failed connection fires its own close; only force-close open sockets
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    log.warn("pumpfun", `stream closed, reconnecting in ${this.reconnectDelay}ms`);
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private handleMessage(msg: PortalMsg): void {
    if (!msg.mint) return;

    if (msg.txType === "create") {
      this.watch(msg.mint);
      const t = tracker.getOrCreate(msg.mint);
      t.createdAt = Date.now();
      t.symbol = msg.symbol;
      t.name = msg.name;
      return;
    }

    if (msg.txType === "buy" || msg.txType === "sell") {
      const state = tracker.recordTrade({
        mint: msg.mint,
        trader: msg.traderPublicKey ?? "unknown",
        side: msg.txType,
        sol: msg.solAmount ?? 0,
        tokenAmount: msg.tokenAmount ?? 0,
        marketCapSol: msg.marketCapSol,
        symbol: msg.symbol,
        name: msg.name,
        at: Date.now(),
      });
      this.maybeSignalMomentum(state.mint);
    }
  }

  private watch(mint: string): void {
    if (this.watched.has(mint)) return;
    this.watched.set(mint, Date.now());
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
    }
    if (this.watched.size > WATCH_LIMIT) this.pruneWatchlist(true);
  }

  private pruneWatchlist(force = false): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [mint, at] of this.watched) {
      if (now - at > WATCH_TTL_MS || (force && this.watched.size - expired.length > WATCH_LIMIT)) {
        expired.push(mint);
      }
    }
    if (expired.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: expired }));
    }
    for (const mint of expired) this.watched.delete(mint);
  }

  /**
   * Early-momentum heuristic for the scanner signal: within the first minutes
   * of a launch, strong buy velocity from many distinct wallets while the
   * market cap is still under the entry ceiling.
   */
  private maybeSignalMomentum(mint: string): void {
    if (this.signalled.has(mint)) return;
    if (getSolUsd() === 0) return; // can't judge mc yet
    const t = tracker.get(mint);
    if (!t || !this.watched.has(mint)) return;
    if (t.mcUsd === undefined || t.mcUsd > config.trading.entryMaxMcUsd) return;

    const windowMs = config.volume.windowSec * 1000;
    const now = Date.now();
    const recent = t.buys.filter((b) => now - b.at < windowMs);
    const buySol = recent.reduce((s, b) => s + b.sol, 0);
    const uniqueBuyers = new Set(recent.map((b) => b.buyer)).size;

    // scanner signal fires at half the full volume threshold (it is one input
    // to the composite score, not a buy trigger on its own)
    if (buySol >= config.volume.thresholdSol / 2 && uniqueBuyers >= config.volume.minUniqueBuyers / 2) {
      this.signalled.add(mint);
      tracker.recordSignal({
        id: shortId(),
        source: "pumpfun-scanner",
        mint,
        symbol: t.symbol,
        name: t.name,
        at: now,
        strength: Math.min(100, Math.round((buySol / config.volume.thresholdSol) * 60 + uniqueBuyers)),
        detail: `early momentum: ${buySol.toFixed(1)} SOL from ${uniqueBuyers} buyers in ${config.volume.windowSec}s at $${Math.round(t.mcUsd).toLocaleString()} mc`,
        mcUsd: t.mcUsd,
      });
    }
  }
}

export function estimateMcUsd(marketCapSol: number): number {
  return solToUsd(marketCapSol);
}
