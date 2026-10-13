import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { Ledger, lamports, lamportsToSol, toUi } from "../chain/solana.js";
import { getConnection, getKeypair } from "../chain/wallet.js";
import { tracker } from "../signals/bus.js";
import { LEDGER_DIR, db } from "../store/db.js";
import type { BurnEvent } from "../types.js";
import { log, shortId } from "../util/logger.js";
import { buybackAndBurn, resumeBuyback, type BuybackJob, type BuybackOutcome } from "./burn.js";

/**
 * Buyback & burn engine for $XERO.
 *
 * Whenever the pending pool crosses BUYBACK_MIN_SOL, the accumulated SOL is
 * used to market-buy $XERO. Paper mode simulates the fill at the last
 * observed price. Live mode (needs WALLET_SECRET_KEY) buys through
 * PumpPortal trade-local and burns EXACTLY the tokens that buy delivered
 * (treasury/burn.ts, ported from memcoinz buyback-burn) — never tokens the
 * wallet already held.
 *
 * Crash safety: the SOL leaves the pending pool (and is written to disk)
 * before the buy is broadcast, the job id is persisted in db.jobs, and every
 * signature hits the ledger before broadcast. On the next tick/restart an
 * unfinished job is resumed: burned if the buy landed, refunded to the pool
 * if it provably didn't. The same SOL is never spent twice.
 */
export const BUYBACK_LEDGER = path.join(LEDGER_DIR, "buybacks.jsonl");

export class BuybackEngine {
  private running = false;
  private warnedNoKey = false;
  onBurn?: (event: BurnEvent) => void;

  start(): void {
    setInterval(() => void this.tick(), 60_000).unref();
    log.info(
      "buyback",
      `engine armed (min ${config.xero.buybackMinSol} SOL, ${config.xero.buybackProfitPct}% of profits)`,
    );
    if (db.jobs.buyback) void this.tick(); // finish whatever a restart interrupted
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (db.jobs.buyback) await this.resume();
      else if (config.xero.mint && db.treasury.pendingBuybackSol >= config.xero.buybackMinSol) {
        await this.executeBuyback(db.treasury.pendingBuybackSol);
      }
    } catch (err) {
      log.error("buyback", "buyback failed", err);
    } finally {
      this.running = false;
    }
  }

  private async executeBuyback(poolSol: number): Promise<void> {
    // whole lamports only, so the pool and the tx agree exactly
    const sol = lamportsToSol(lamports(poolSol));
    if (sol <= 0) return;

    if (config.paperTrading) return this.paperBuyback(sol);

    const keypair = getKeypair();
    if (!keypair) {
      if (!this.warnedNoKey) log.warn("buyback", "live mode but WALLET_SECRET_KEY not set — keeping the pool, no buyback");
      this.warnedNoKey = true;
      return;
    }

    // commit: SOL leaves the pool and is on disk BEFORE anything is broadcast
    const id = `bb-${Date.now()}-${shortId()}`;
    db.treasury.pendingBuybackSol -= sol;
    db.treasury.inFlightBuybackSol += sol;
    db.jobs.buyback = { id, sol, startedAt: Date.now() };
    db.commit("treasury", "jobs");

    const ledger = new Ledger(BUYBACK_LEDGER);
    let outcome: BuybackOutcome;
    try {
      outcome = await buybackAndBurn(getConnection(), {
        wallet: keypair,
        mint: new PublicKey(config.xero.mint),
        sol,
        slippagePct: config.execution.slippagePct,
        priorityFeeSol: config.execution.priorityFeeSol,
        pool: "auto",
        ledger,
        id,
        log: (m) => log.info("buyback", m),
      });
    } catch (err) {
      // nothing signed yet → nothing can land → refund; otherwise resume next tick
      outcome = ledger.entries.has(id)
        ? { state: "waiting", reason: (err as Error).message }
        : { state: "refund", reason: `buy never sent: ${(err as Error).message}` };
    }
    this.settle(outcome);
  }

  private async resume(): Promise<void> {
    const job = db.jobs.buyback!;
    const ledger = new Ledger(BUYBACK_LEDGER);
    const entry = ledger.entries.get(job.id) as BuybackJob | undefined;
    if (!entry) return this.settle({ state: "refund", reason: "crashed before the buy was signed" });
    const keypair = getKeypair();
    if (!keypair) {
      log.warn("buyback", `job ${job.id} unfinished but WALLET_SECRET_KEY is not set — leaving it for later`);
      return;
    }
    const outcome = await resumeBuyback(getConnection(), {
      wallet: keypair,
      ledger,
      job: entry,
      log: (m) => log.info("buyback", m),
    }).catch((err): BuybackOutcome => ({ state: "waiting", reason: (err as Error).message }));
    this.settle(outcome);
  }

  private settle(outcome: BuybackOutcome): void {
    const job = db.jobs.buyback;
    if (!job) return;
    if (outcome.state === "waiting") {
      log.warn("buyback", `job ${job.id} waiting: ${outcome.reason}`);
      return;
    }
    db.treasury.inFlightBuybackSol = Math.max(0, db.treasury.inFlightBuybackSol - job.sol);
    db.jobs.buyback = undefined;
    if (outcome.state === "refund") {
      db.treasury.pendingBuybackSol += job.sol;
      db.commit("treasury", "jobs");
      log.warn("buyback", `job ${job.id}: ${outcome.reason} — ${job.sol} SOL returned to the buyback pool`);
      return;
    }
    const bought = Number(toUi(outcome.boughtRaw, outcome.decimals));
    const burned = Number(toUi(outcome.burnedRaw, outcome.decimals));
    this.record({
      id: job.id,
      at: Date.now(),
      solSpent: job.sol,
      xeroBought: bought,
      xeroBurned: burned,
      boughtRaw: outcome.boughtRaw.toString(),
      burnedRaw: outcome.burnedRaw.toString(),
      buyTx: outcome.buySig,
      burnTx: outcome.burnSig,
      fundedBy: "trading-profit",
      paper: false,
    });
  }

  private paperBuyback(sol: number): void {
    const price = tracker.get(config.xero.mint)?.priceSol;
    // if we have no live price for XERO yet, simulate a nominal fill
    const xeroBought = price && price > 0 ? sol / price : sol * 1_000_000;
    db.treasury.pendingBuybackSol -= sol;
    this.record({
      id: shortId(),
      at: Date.now(),
      solSpent: sol,
      xeroBought,
      xeroBurned: xeroBought,
      fundedBy: "trading-profit",
      paper: true,
    });
  }

  private record(event: BurnEvent): void {
    db.burns.push(event);
    db.treasury.totalBuybackSol += event.solSpent;
    db.treasury.totalXeroBurned += event.xeroBurned;
    db.commit("burns", "treasury", "jobs");
    log.info(
      "buyback",
      `🔥 bought back ${event.solSpent.toFixed(3)} SOL of $XERO (${event.xeroBought.toFixed(0)} tokens) → burned ${event.xeroBurned.toFixed(0)}`,
    );
    this.onBurn?.(event);
  }
}
