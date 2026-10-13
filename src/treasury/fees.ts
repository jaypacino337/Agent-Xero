import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { Ledger, lamports, lamportsToSol } from "../chain/solana.js";
import { getConnection, getCreatorKeypair } from "../chain/wallet.js";
import { LEDGER_DIR, db } from "../store/db.js";
import { log } from "../util/logger.js";
import { claimCreatorFees, claimable, reconcileClaims, type ClaimEntry } from "./claim.js";
import { treasury } from "./treasury.js";

/**
 * Automatic pump.fun creator-fee claims → trading treasury.
 *
 * Replaces typing `/fees <sol>` by hand. Every CLAIM_INTERVAL_MIN:
 *   - reads what's claimable (bonding-curve vault + PumpSwap vault) and
 *     shows it on the dashboard (paper mode stops here: read-only)
 *   - live: when ≥ CLAIM_MIN_SOL, claims through PumpPortal trade-local
 *     (memcoinz pump-claim), measures what actually landed from the tx and
 *     credits exactly that via treasury.recordCreatorFees(source: "auto")
 * A claim's signature is in the ledger before broadcast; a claim that lands
 * while the process is down is credited on the next tick. A signature is
 * never credited twice (db.claims is checked first).
 *
 * Manual entry stays as a fallback when auto-claim is off; while auto-claim
 * is live, manual entries need `force` so nothing is counted twice.
 */
export const CLAIM_LEDGER = path.join(LEDGER_DIR, "claims.jsonl");

export function autoClaimLive(): boolean {
  return config.claims.autoClaim && !config.paperTrading && getCreatorKeypair() !== null;
}

export class FeeClaimer {
  private running = false;
  private warned = false;

  start(): void {
    if (!config.claims.autoClaim) {
      log.info("claims", "auto-claim disabled (AUTO_CLAIM=false) — record fees with /fees or POST /api/admin/fees");
      return;
    }
    const every = Math.max(1, config.claims.intervalMin) * 60_000;
    setInterval(() => void this.tick(), every).unref();
    setTimeout(() => void this.tick(), 10_000).unref();
    log.info(
      "claims",
      autoClaimLive()
        ? `auto-claim armed (every ${config.claims.intervalMin} min, min ${config.claims.minSol} SOL)`
        : "auto-claim in read-only mode (paper trading or no creator key): showing claimable fees only",
    );
  }

  private creator(): PublicKey | null {
    const kp = getCreatorKeypair();
    if (kp) return kp.publicKey;
    if (config.claims.creatorPublicKey) {
      try {
        return new PublicKey(config.claims.creatorPublicKey);
      } catch {
        return null;
      }
    }
    return null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const creator = this.creator();
      if (!creator) {
        if (!this.warned) log.info("claims", "no creator wallet configured (CREATOR_SECRET_KEY / WALLET_SECRET_KEY / CREATOR_PUBLIC_KEY)");
        this.warned = true;
        return;
      }
      const conn = getConnection();
      const ledger = new Ledger(CLAIM_LEDGER);

      if (autoClaimLive()) {
        await reconcileClaims(conn, ledger);
        this.creditUncredited(ledger);
      }

      const c = await claimable(conn, creator);
      db.treasury.claimableSol = lamportsToSol(c.total);
      db.treasury.claimableAt = Date.now();
      db.markDirty("treasury");

      if (!autoClaimLive()) return;
      if (c.total < lamports(config.claims.minSol)) return;
      const pending = [...ledger.entries.values()].some((e) => e.status === "pending");
      if (pending) return; // an earlier claim may still land; never stack claims

      const res = await claimCreatorFees(conn, {
        creator: getCreatorKeypair()!,
        ledger,
        id: `claim-${Date.now()}`,
        priorityFeeSol: config.execution.priorityFeeSol,
      });
      if (res.state === "waiting") {
        log.warn("claims", `claim ${res.signature} unconfirmed (${res.reason}) — will reconcile`);
        return;
      }
      this.creditUncredited(ledger);
      db.treasury.claimableSol = 0;
      db.markDirty("treasury");
    } catch (err) {
      log.error("claims", "claim round failed", err);
    } finally {
      this.running = false;
    }
  }

  /** Credits every confirmed claim exactly once. */
  private creditUncredited(ledger: Ledger): void {
    for (const e of [...ledger.entries.values()] as ClaimEntry[]) {
      if (e.status !== "sent" || e.credited) continue;
      const claimed = BigInt(e.claimedLamports ?? "0");
      const already = db.claims.some((c) => c.signature === e.signature);
      if (!already && claimed > 0n) {
        treasury.recordCreatorFees(lamportsToSol(claimed), { source: "auto", signature: e.signature });
        log.info("claims", `✓ claimed ${lamportsToSol(claimed).toFixed(6)} SOL creator fees ${e.signature}`);
      }
      ledger.write({ ...e, credited: true });
    }
  }
}
