import { config } from "../config.js";
import { log, shortId } from "../util/logger.js";
import { tracker } from "./bus.js";

/**
 * Smart-wallet confluence watcher.
 *
 * Subscribes to trades made by a curated list of high-quality profitable
 * wallets (PumpPortal `subscribeAccountTrade`). When N distinct tracked
 * wallets buy the same token inside the confluence window, a
 * "smart-wallet-confluence" signal fires — the highest-weighted signal in
 * the scorer.
 */
const WS_URL = "wss://pumpportal.fun/api/data";

interface PortalMsg {
  txType?: "buy" | "sell" | "create";
  mint?: string;
  traderPublicKey?: string;
  solAmount?: number;
  marketCapSol?: number;
  symbol?: string;
}

export class SmartWalletWatcher {
  private ws?: WebSocket;
  private reconnectDelay = 1000;
  private stopped = false;
  private signalledAt = new Map<string, number>(); // mint -> last confluence signal

  start(): void {
    if (config.smartWallets.wallets.length === 0) {
      log.info("smart-wallets", "no SMART_WALLETS configured, watcher disabled");
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      ws.send(
        JSON.stringify({
          method: "subscribeAccountTrade",
          keys: config.smartWallets.wallets,
        }),
      );
      log.info(
        "smart-wallets",
        `watching ${config.smartWallets.wallets.length} smart wallets`,
      );
    });

    ws.addEventListener("message", (ev) => {
      try {
        this.handleMessage(JSON.parse(String(ev.data)) as PortalMsg);
      } catch {
        /* ignore */
      }
    });

    let reconnectScheduled = false;
    ws.addEventListener("close", () => {
      if (this.stopped || reconnectScheduled) return;
      reconnectScheduled = true;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
    ws.addEventListener("error", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
  }

  private handleMessage(msg: PortalMsg): void {
    if (msg.txType !== "buy" || !msg.mint || !msg.traderPublicKey) return;
    if (!config.smartWallets.wallets.includes(msg.traderPublicKey)) return;

    const now = Date.now();
    const t = tracker.getOrCreate(msg.mint);
    t.smartWalletBuys.push({
      wallet: msg.traderPublicKey,
      at: now,
      sol: msg.solAmount ?? 0,
    });

    const windowMs = config.smartWallets.windowSec * 1000;
    t.smartWalletBuys = t.smartWalletBuys.filter((b) => now - b.at < windowMs);
    const distinct = new Set(t.smartWalletBuys.map((b) => b.wallet));

    log.info(
      "smart-wallets",
      `${msg.traderPublicKey.slice(0, 6)}… bought ${msg.mint.slice(0, 6)}… (${distinct.size}/${config.smartWallets.confluenceMin} confluence)`,
    );

    if (distinct.size >= config.smartWallets.confluenceMin) {
      const last = this.signalledAt.get(msg.mint) ?? 0;
      if (now - last < windowMs) return; // one confluence signal per window
      this.signalledAt.set(msg.mint, now);

      const totalSol = t.smartWalletBuys.reduce((s, b) => s + b.sol, 0);
      tracker.recordSignal({
        id: shortId(),
        source: "smart-wallet-confluence",
        mint: msg.mint,
        symbol: msg.symbol ?? t.symbol,
        at: now,
        strength: Math.min(100, 60 + distinct.size * 10 + Math.min(20, totalSol)),
        detail: `${distinct.size} tracked wallets bought within ${config.smartWallets.windowSec}s (${totalSol.toFixed(2)} SOL total)`,
        mcUsd: t.mcUsd,
      });
    }
  }
}
