import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { config } from "../config.js";
import { executeTrade } from "../execution/pumpportal.js";
import { getConnection, getKeypair } from "../chain/wallet.js";
import { tracker } from "../signals/bus.js";
import { db } from "../store/db.js";
import type { BurnEvent } from "../types.js";
import { log, shortId } from "../util/logger.js";

/**
 * Buyback & burn engine for $XERO.
 *
 * Whenever the pending pool crosses BUYBACK_MIN_SOL, the accumulated SOL is
 * used to market-buy $XERO. Paper mode simulates the fill at the last
 * observed price. Live mode buys via PumpPortal, then — when
 * WALLET_SECRET_KEY is configured — burns the wallet's entire $XERO balance
 * on-chain with the SPL burn instruction (supply actually decreases; no
 * incinerator transfer needed). Without a wallet key the buyback is recorded
 * with burnTx empty for a manual burn.
 */
export class BuybackEngine {
  private running = false;
  onBurn?: (event: BurnEvent) => void;

  start(): void {
    setInterval(() => void this.tick(), 60_000).unref();
    log.info(
      "buyback",
      `engine armed (min ${config.xero.buybackMinSol} SOL, ${config.xero.buybackProfitPct}% of profits)`,
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (!config.xero.mint) return;
    if (db.treasury.pendingBuybackSol < config.xero.buybackMinSol) return;

    this.running = true;
    try {
      await this.executeBuyback(db.treasury.pendingBuybackSol);
    } catch (err) {
      log.error("buyback", "buyback failed", err);
    } finally {
      this.running = false;
    }
  }

  private async executeBuyback(sol: number): Promise<void> {
    let buyTx: string | undefined;
    let burnTx: string | undefined;
    let xeroBought = 0;

    if (config.paperTrading) {
      const price = tracker.get(config.xero.mint)?.priceSol;
      // if we have no live price for XERO yet, simulate a nominal fill
      xeroBought = price && price > 0 ? sol / price : sol * 1_000_000;
    } else {
      const result = await executeTrade({
        action: "buy",
        mint: config.xero.mint,
        amount: sol,
        denominatedInSol: true,
      });
      if (!result.ok) {
        log.error("buyback", `live buyback failed: ${result.error}`);
        return;
      }
      buyTx = result.signature;
      const price = tracker.get(config.xero.mint)?.priceSol;
      xeroBought = price && price > 0 ? sol / price : 0;
      const burned = await this.burnHeldXero();
      if (burned) {
        burnTx = burned.signature;
        xeroBought = burned.amount; // exact on-chain amount beats the estimate
      }
    }

    const event: BurnEvent = {
      id: shortId(),
      at: Date.now(),
      solSpent: sol,
      xeroBought,
      xeroBurned: xeroBought,
      buyTx,
      burnTx,
      fundedBy: "trading-profit",
      paper: config.paperTrading,
    };
    db.burns.push(event);
    db.treasury.pendingBuybackSol -= sol;
    db.treasury.totalBuybackSol += sol;
    db.treasury.totalXeroBurned += event.xeroBurned;
    db.markDirty("burns", "treasury");
    log.info(
      "buyback",
      `🔥 bought back ${sol.toFixed(3)} SOL of $XERO (${xeroBought.toFixed(0)} tokens) -> burn`,
    );
    this.onBurn?.(event);
  }

  /**
   * Burn the operator wallet's entire $XERO balance via the SPL burn
   * instruction. Returns undefined (and logs) when no wallet key is set —
   * the buyback still records, burn happens manually.
   */
  private async burnHeldXero(): Promise<{ signature: string; amount: number } | undefined> {
    const keypair = getKeypair();
    if (!keypair) {
      log.warn("buyback", "no WALLET_SECRET_KEY — bought tokens held, burn manually");
      return undefined;
    }
    try {
      const conn = getConnection();
      const mint = new PublicKey(config.xero.mint);
      const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey);
      const balance = await conn.getTokenAccountBalance(ata);
      const raw = BigInt(balance.value.amount);
      if (raw === 0n) {
        log.warn("buyback", "wallet holds 0 XERO after buy — nothing to burn yet");
        return undefined;
      }
      const tx = new Transaction().add(
        createBurnInstruction(ata, mint, keypair.publicKey, raw),
      );
      const signature = await sendAndConfirmTransaction(conn, tx, [keypair]);
      const amount = balance.value.uiAmount ?? 0;
      log.info("buyback", `🔥 on-chain burn of ${amount} XERO: ${signature}`);
      return { signature, amount };
    } catch (err) {
      log.error("buyback", "on-chain burn failed (tokens held in wallet)", err);
      return undefined;
    }
  }
}
