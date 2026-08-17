import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { snapshotHolders, type Holder } from "../chain/holders.js";
import { getConnection, getKeypair } from "../chain/wallet.js";
import { db } from "../store/db.js";
import type { AirdropEvent } from "../types.js";
import { log, shortId } from "../util/logger.js";

/**
 * Holder airdrop engine — the second arm of the flywheel next to burns.
 *
 * The pool accrues from callout rewards (default 100% of them) and a share
 * of trading profits. When it crosses AIRDROP_MIN_SOL:
 *   - snapshot eligible $XERO holders (dust + LPs + exclusions filtered)
 *   - "linear": pro-rata by holdings; "random": holdings-weighted lottery,
 *     N winners split the pool equally
 *   - paper mode records the drop; live mode sends SOL from the operator
 *     wallet, batched 8 transfers per transaction
 */
export class AirdropEngine {
  private running = false;
  onDrop?: (event: AirdropEvent) => void;

  start(): void {
    if (!config.airdrop.enabled) {
      log.info("airdrop", "disabled via AIRDROP_ENABLED=false");
      return;
    }
    setInterval(() => void this.tick(), 90_000).unref();
    log.info(
      "airdrop",
      `engine armed (${config.airdrop.mode} mode, min ${config.airdrop.minSol} SOL, ${config.airdrop.profitPct}% of profits + ${config.airdrop.calloutRewardsPct}% of callout rewards)`,
    );
  }

  private async tick(): Promise<void> {
    if (db.treasury.pendingAirdropSol < config.airdrop.minSol) return;
    await this.runOnce();
  }

  /** Drop whatever is pooled right now (also exposed via the admin API). */
  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    if (!config.xero.mint || db.treasury.pendingAirdropSol <= 0) return false;
    this.running = true;
    try {
      await this.executeDrop(db.treasury.pendingAirdropSol);
      return true;
    } catch (err) {
      log.error("airdrop", "drop failed", err);
      return false;
    } finally {
      this.running = false;
    }
  }

  private pickRecipients(holders: Holder[], pool: number): { wallet: string; sol: number }[] {
    if (holders.length === 0) return [];
    if (config.airdrop.mode === "linear") {
      const total = holders.reduce((s, h) => s + h.amount, 0);
      return holders
        .slice(0, config.airdrop.maxRecipientsPerDrop)
        .map((h) => ({ wallet: h.owner, sol: (h.amount / total) * pool }))
        .filter((r) => r.sol >= 0.001);
    }
    // random: holdings-weighted lottery, winners split the pool equally
    const winners = new Set<string>();
    const n = Math.min(config.airdrop.randomWinners, holders.length);
    const totalWeight = holders.reduce((s, h) => s + h.amount, 0);
    let guard = 0;
    while (winners.size < n && guard++ < 10_000) {
      let r = Math.random() * totalWeight;
      for (const h of holders) {
        r -= h.amount;
        if (r <= 0) {
          winners.add(h.owner);
          break;
        }
      }
    }
    const share = pool / winners.size;
    return [...winners].map((wallet) => ({ wallet, sol: share }));
  }

  private async executeDrop(pool: number): Promise<void> {
    const holders = await snapshotHolders(config.xero.mint);
    if (holders.length === 0) {
      log.warn("airdrop", "no eligible holders found, keeping pool");
      return;
    }
    const recipients = this.pickRecipients(holders, pool);
    if (recipients.length === 0) return;

    const txs: string[] = [];
    if (!config.paperTrading) {
      const keypair = getKeypair();
      if (!keypair) {
        log.warn("airdrop", "live mode but WALLET_SECRET_KEY not set — keeping pool");
        return;
      }
      const conn = getConnection();
      for (let i = 0; i < recipients.length; i += 8) {
        const batch = recipients.slice(i, i + 8);
        const tx = new Transaction();
        for (const r of batch) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: new PublicKey(r.wallet),
              lamports: Math.floor(r.sol * LAMPORTS_PER_SOL),
            }),
          );
        }
        const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
        txs.push(sig);
        log.info("airdrop", `batch ${i / 8 + 1} sent: ${sig}`);
      }
    }

    const event: AirdropEvent = {
      id: shortId(),
      at: Date.now(),
      totalSol: pool,
      mode: config.airdrop.mode,
      recipientCount: recipients.length,
      recipients: recipients
        .slice()
        .sort((a, b) => b.sol - a.sol)
        .slice(0, 25),
      txs,
      fundedBy: "callout-rewards",
      paper: config.paperTrading,
    };
    db.airdrops.push(event);
    db.treasury.pendingAirdropSol -= pool;
    db.treasury.totalAirdropSol += pool;
    db.markDirty("airdrops", "treasury");
    log.info(
      "airdrop",
      `🎁 dropped ${pool.toFixed(3)} SOL to ${recipients.length} holders (${config.airdrop.mode})`,
    );
    this.onDrop?.(event);
  }
}
