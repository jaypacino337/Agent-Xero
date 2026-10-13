import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { takeSnapshot, type HolderSnapshot } from "../chain/holders.js";
import { lamports, lamportsToSol } from "../chain/solana.js";
import { getConnection, getKeypair } from "../chain/wallet.js";
import { LEDGER_DIR, db } from "../store/db.js";
import type { AirdropEvent } from "../types.js";
import { log } from "../util/logger.js";
import { buildPlan, executePlan, loadPlan, savePlan, type AirdropPlan, type DropMode } from "./payout.js";

/**
 * Holder airdrop engine — the second arm of the flywheel next to burns.
 *
 * The pool accrues from callout rewards (default 100% of them) and a share
 * of trading profits. When it crosses AIRDROP_MIN_SOL:
 *   1. snapshot eligible $XERO holders (bigint, Token-2022 aware, PDAs/LPs/
 *      bonding curve/exclusions/dust filtered; seated wallets only when
 *      SEATS_URL is set)
 *   2. build a plan: "linear" = pro-rata (optional AIRDROP_CAP_BPS),
 *      "random" = holdings-weighted lottery seeded with the snapshot slot,
 *      "equal" = same amount each; rent-aware for brand-new wallets
 *   3. freeze it to DATA_DIR/ledgers/<id>.plan.json and move exactly the
 *      allocated SOL out of the pool — on disk — before any transfer
 *   4. pay in batches; each signature is fsync'd to the plan's ledger before
 *      broadcast. A failed or unconfirmed batch stays in the plan and is
 *      reconciled against the chain on the next tick or after a restart, so
 *      nobody is paid twice and nothing is silently dropped.
 * Paper mode runs the same plan + ledger path with simulated signatures.
 * Payout code: treasury/payout.ts (ported from memcoinz airdrop).
 */
export interface AirdropDeps {
  /** override for tests / the e2e sim */
  snapshot?: (mint: string) => Promise<HolderSnapshot>;
}

const MODE: Record<typeof config.airdrop.mode, DropMode> = {
  linear: "prorata",
  random: "lottery",
  equal: "equal",
};

export class AirdropEngine {
  private running = false;
  onDrop?: (event: AirdropEvent) => void;

  constructor(private deps: AirdropDeps = {}) {}

  start(): void {
    if (!config.airdrop.enabled) {
      log.info("airdrop", "disabled via AIRDROP_ENABLED=false");
      return;
    }
    setInterval(() => void this.tick(), 90_000).unref();
    log.info(
      "airdrop",
      `engine armed (${config.airdrop.mode} mode, min ${config.airdrop.minSol} SOL, ${config.airdrop.profitPct}% of profits + ${config.airdrop.calloutRewardsPct}% of callout rewards${config.seats.url ? ", seated wallets only" : ""})`,
    );
    if (db.jobs.airdrop) void this.tick(); // resume a plan a restart interrupted
  }

  async tick(): Promise<void> {
    if (!db.jobs.airdrop && db.treasury.pendingAirdropSol < config.airdrop.minSol) return;
    await this.runOnce();
  }

  /** Resume the active plan, or drop whatever is pooled right now (also exposed via the admin API). */
  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      if (db.jobs.airdrop) return await this.resume();
      if (!config.xero.mint || db.treasury.pendingAirdropSol <= 0) return false;
      return await this.createAndRun();
    } catch (err) {
      log.error("airdrop", "drop failed", err);
      return false;
    } finally {
      this.running = false;
    }
  }

  private async createAndRun(): Promise<boolean> {
    const payer = getKeypair();
    if (!config.paperTrading && !payer) {
      log.warn("airdrop", "live mode but WALLET_SECRET_KEY not set — keeping pool");
      return false;
    }
    const snapshot = this.deps.snapshot
      ? await this.deps.snapshot(config.xero.mint)
      : await takeSnapshot(getConnection(), {
          mint: new PublicKey(config.xero.mint),
          minHoldingPct: config.airdrop.minHoldingPct,
          exclude: config.airdrop.exclude,
          heliusApiKey: config.chain.heliusApiKey || undefined,
          seatsUrl: config.seats.url || undefined,
        });
    if (snapshot.holders.length === 0) {
      log.warn("airdrop", "no eligible holders found, keeping pool");
      return false;
    }

    const opts = {
      snapshot,
      potLamports: lamports(db.treasury.pendingAirdropSol),
      mode: MODE[config.airdrop.mode],
      capBps: config.airdrop.capBps,
      winners: config.airdrop.randomWinners,
      maxRecipients: config.airdrop.maxRecipientsPerDrop,
      minPayoutLamports: lamports(config.airdrop.minPayoutSol),
      payer: payer?.publicKey.toBase58(),
      paper: config.paperTrading,
    };
    // rent check reads the chain; paper plans skip it (nothing is sent)
    const plan = await buildPlan({ ...opts, conn: config.paperTrading ? undefined : getConnection() });
    if (plan.payouts.length === 0) {
      log.warn("airdrop", "pool too small for any payout above the minimum, keeping pool");
      return false;
    }
    if (plan.capRelaxed) log.warn("airdrop", "cap relaxed: too few holders for it to absorb the pot");
    if (plan.droppedForRent) log.info("airdrop", `${plan.droppedForRent} empty wallets below rent-exemption dropped, pot re-split`);

    // freeze + commit: plan on disk and SOL out of the pool BEFORE any transfer
    savePlan(LEDGER_DIR, plan);
    const sol = lamportsToSol(BigInt(plan.allocatedLamports));
    db.treasury.pendingAirdropSol = Math.max(0, db.treasury.pendingAirdropSol - sol);
    db.treasury.inFlightAirdropSol += sol;
    db.jobs.airdrop = { id: plan.id, sol, startedAt: Date.now() };
    db.commit("treasury", "jobs");
    log.info("airdrop", `plan ${plan.id} frozen: ${plan.payouts.length} recipients, ${sol.toFixed(4)} SOL`);
    return this.execute(plan);
  }

  private async resume(): Promise<boolean> {
    const job = db.jobs.airdrop!;
    const plan = loadPlan(LEDGER_DIR, job.id);
    if (!plan) {
      // committed but the plan file is gone (volume wiped?): nothing can have been sent from it
      log.error("airdrop", `plan ${job.id} missing on disk — returning ${job.sol} SOL to the pool`);
      db.treasury.inFlightAirdropSol = Math.max(0, db.treasury.inFlightAirdropSol - job.sol);
      db.treasury.pendingAirdropSol += job.sol;
      db.jobs.airdrop = undefined;
      db.commit("treasury", "jobs");
      return false;
    }
    return this.execute(plan);
  }

  private async execute(plan: AirdropPlan): Promise<boolean> {
    const res = await executePlan({
      plan,
      dir: LEDGER_DIR,
      conn: plan.paper ? undefined : getConnection(),
      payer: getKeypair(),
      paper: plan.paper,
      batchSize: config.airdrop.batchSize,
      log: (m) => log.info("airdrop", m),
    });
    if (res.remaining > 0) {
      log.warn(
        "airdrop",
        `plan ${plan.id}: ${plan.payouts.length - res.remaining}/${plan.payouts.length} paid, ${res.undecided} awaiting confirmation — will resume`,
      );
      return false;
    }
    this.finalize(plan, res.signatures);
    return true;
  }

  private finalize(plan: AirdropPlan, txs: string[]): void {
    const job = db.jobs.airdrop!;
    const event: AirdropEvent = {
      id: plan.id,
      at: Date.now(),
      totalSol: job.sol,
      mode: config.airdrop.mode,
      recipientCount: plan.payouts.length,
      recipients: plan.payouts
        .map((p) => ({ wallet: p.owner, sol: lamportsToSol(BigInt(p.lamports)) }))
        .sort((a, b) => b.sol - a.sol)
        .slice(0, 25),
      txs,
      planId: plan.id,
      slot: plan.slot,
      seated: plan.seated,
      fundedBy: "callout-rewards",
      paper: plan.paper,
    };
    db.airdrops.push(event);
    db.treasury.inFlightAirdropSol = Math.max(0, db.treasury.inFlightAirdropSol - job.sol);
    db.treasury.totalAirdropSol += job.sol;
    db.jobs.airdrop = undefined;
    db.commit("airdrops", "treasury", "jobs");
    log.info(
      "airdrop",
      `🎁 dropped ${job.sol.toFixed(3)} SOL to ${plan.payouts.length} holders (${config.airdrop.mode})`,
    );
    this.onDrop?.(event);
  }
}
