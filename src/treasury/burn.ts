/**
 * Market-buy $XERO with SOL and burn EXACTLY what that buy bought.
 *
 * Ported from memcoinz `.claude/skills/buyback-burn/scripts/buyback.ts`
 * (`buybackAndBurn`, branch claude/solana-skills), which replaced this repo's
 * old "burn the wallet's entire balance" logic:
 *   - the buy goes through PumpPortal trade-local (signed locally, no API key)
 *   - the amount bought is the wallet's balance delta across the buy; when
 *     the confirmed tx is readable, its own token delta is the cap, so
 *     concurrent inflows can never inflate the burn
 *   - the burn is `burnChecked` with the detected token program (SPL or
 *     Token-2022), so supply really drops; no incinerator transfer
 * Added here: each phase's signature is written to a ledger BEFORE
 * broadcast and `resumeBuyback` finishes a job after a crash (buy landed →
 * read the exact amount from the tx and burn it; buy never landed → refund
 * the pool). Nothing is ever bought twice for the same SOL.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Ledger,
  buildSigned,
  fetchMeta,
  pumpPortalLocal,
  sendPreSigned,
  signPumpPortalTx,
  signatureStates,
  tokenDeltaFromMeta,
  tokenInfo,
  type LedgerEntry,
} from "../chain/solana.js";

export interface BuybackJob extends LedgerEntry {
  phase: "buy" | "burn";
  mint: string;
  sol: number;
  decimals: number;
  programId: string;
  beforeRaw: string;
  buySig?: string;
  boughtRaw?: string;
  burnSig?: string;
  burnedRaw?: string;
}

export type BuybackOutcome =
  | { state: "done"; boughtRaw: bigint; burnedRaw: bigint; decimals: number; buySig?: string; burnSig?: string }
  /** the buy provably never landed: the SOL is still in the wallet, return it to the pool */
  | { state: "refund"; reason: string }
  /** a tx may still land (or the RPC hiccuped): try again next tick, don't re-buy */
  | { state: "waiting"; reason: string };

export interface BuybackOptions {
  wallet: Keypair;
  mint: PublicKey;
  sol: number;
  slippagePct?: number;
  priorityFeeSol?: number;
  pool?: string;
  ledger: Ledger;
  /** job id (ledger key) */
  id: string;
  log?: (msg: string) => void;
}

/**
 * What to burn after a buy: never more than the balance grew by, and never
 * more than the buy tx itself delivered (when we could read it). Never negative.
 */
export function burnAmount(beforeRaw: bigint, afterRaw: bigint, txDeltaRaw: bigint | null): bigint {
  let bought = afterRaw - beforeRaw;
  if (txDeltaRaw !== null && txDeltaRaw < bought) bought = txDeltaRaw;
  return bought > 0n ? bought : 0n;
}

async function tokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const b = await conn.getTokenAccountBalance(ata).catch(() => null);
  return BigInt(b?.value.amount ?? "0");
}

function ataOf(job: Pick<BuybackJob, "mint" | "programId">, owner: PublicKey) {
  return getAssociatedTokenAddressSync(new PublicKey(job.mint), owner, false, new PublicKey(job.programId));
}

export async function buybackAndBurn(conn: Connection, o: BuybackOptions): Promise<BuybackOutcome> {
  const say = o.log ?? (() => undefined);
  const { programId, decimals } = await tokenInfo(conn, o.mint);
  const ata = getAssociatedTokenAddressSync(o.mint, o.wallet.publicKey, false, programId);
  const before = await tokenBalance(conn, ata);

  const bytes = await pumpPortalLocal({
    publicKey: o.wallet.publicKey.toBase58(),
    action: "buy",
    mint: o.mint.toBase58(),
    amount: o.sol,
    denominatedInSol: "true",
    slippage: o.slippagePct ?? 10,
    priorityFee: o.priorityFeeSol ?? 0.00005,
    pool: o.pool ?? "auto",
  });
  const pre = await signPumpPortalTx(conn, bytes, [o.wallet]);
  const job: BuybackJob = {
    key: o.id,
    status: "pending",
    phase: "buy",
    mint: o.mint.toBase58(),
    sol: o.sol,
    decimals,
    programId: programId.toBase58(),
    beforeRaw: before.toString(),
    signature: pre.signature,
    lastValidBlockHeight: pre.lastValidBlockHeight,
    buySig: pre.signature,
  };
  o.ledger.write(job); // signature on disk before broadcast

  try {
    await sendPreSigned(conn, pre);
  } catch (err) {
    say(`buy ${pre.signature} not confirmed yet: ${(err as Error).message.slice(0, 160)}`);
    return resumeBuyback(conn, { wallet: o.wallet, ledger: o.ledger, job, log: o.log });
  }

  const after = await tokenBalance(conn, ata);
  const txDelta = await fetchMeta(conn, pre.signature)
    .then((m) => tokenDeltaFromMeta(m, o.wallet.publicKey.toBase58(), job.mint))
    .catch(() => null);
  const bought = burnAmount(before, after, txDelta);
  say(`bought ${bought} raw (balance ${before} → ${after}, tx delta ${txDelta ?? "n/a"}) ${pre.signature}`);
  const next: BuybackJob = { ...job, phase: "burn", boughtRaw: bought.toString(), signature: undefined, lastValidBlockHeight: undefined };
  o.ledger.write(next);
  return burnPhase(conn, o.wallet, o.ledger, next, say);
}

async function burnPhase(
  conn: Connection,
  wallet: Keypair,
  ledger: Ledger,
  job: BuybackJob,
  say: (m: string) => void,
): Promise<BuybackOutcome> {
  const bought = BigInt(job.boughtRaw ?? "0");
  const done = (burned: bigint, burnSig?: string): BuybackOutcome => {
    ledger.write({ ...job, status: "sent", burnSig, burnedRaw: burned.toString() });
    return { state: "done", boughtRaw: bought, burnedRaw: burned, decimals: job.decimals, buySig: job.buySig, burnSig };
  };
  if (bought === 0n) {
    say("buy delivered 0 tokens: nothing to burn");
    return done(0n);
  }

  if (job.burnSig) {
    const st = (await signatureStates(conn, [{ signature: job.burnSig, lastValidBlockHeight: job.lastValidBlockHeight }])).get(job.burnSig);
    if (st === "confirmed") return done(BigInt(job.burnedRaw ?? job.boughtRaw ?? "0"), job.burnSig);
    if (st === "unknown") return { state: "waiting", reason: `burn ${job.burnSig} may still land` };
    // failed / expired: build a fresh burn below
  }

  const owner = wallet.publicKey;
  const ata = ataOf(job, owner);
  // never burn tokens the wallet no longer has (e.g. moved out by hand)
  const balance = await tokenBalance(conn, ata);
  const amount = bought < balance ? bought : balance;
  if (amount === 0n) return { state: "waiting", reason: "bought tokens not visible in the wallet yet" };

  const built = await buildSigned(
    conn,
    [createBurnCheckedInstruction(ata, new PublicKey(job.mint), owner, amount, job.decimals, [], new PublicKey(job.programId))],
    [wallet],
  );
  const pendingBurn: BuybackJob = {
    ...job,
    phase: "burn",
    status: "pending",
    burnSig: built.signature,
    burnedRaw: amount.toString(),
    signature: built.signature,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
  ledger.write(pendingBurn);
  try {
    await sendPreSigned(conn, built);
  } catch (err) {
    say(`burn ${built.signature} not confirmed yet: ${(err as Error).message.slice(0, 160)}`);
    return { state: "waiting", reason: "burn unconfirmed" };
  }
  ledger.write({ ...pendingBurn, status: "sent" });
  return { state: "done", boughtRaw: bought, burnedRaw: amount, decimals: job.decimals, buySig: job.buySig, burnSig: built.signature };
}

/** Finish (or refund) a job left unfinished by a crash, timeout or RPC error. */
export async function resumeBuyback(
  conn: Connection,
  o: { wallet: Keypair; ledger: Ledger; job: BuybackJob; log?: (m: string) => void },
): Promise<BuybackOutcome> {
  const say = o.log ?? (() => undefined);
  const job = o.job;
  if (job.status === "sent") {
    return { state: "done", boughtRaw: BigInt(job.boughtRaw ?? "0"), burnedRaw: BigInt(job.burnedRaw ?? "0"), decimals: job.decimals, buySig: job.buySig, burnSig: job.burnSig };
  }
  if (job.status === "failed") return { state: "refund", reason: "buy never landed" };
  if (job.phase === "burn") return burnPhase(conn, o.wallet, o.ledger, job, say);

  const st = (await signatureStates(conn, [{ signature: job.buySig!, lastValidBlockHeight: job.lastValidBlockHeight }])).get(job.buySig!);
  if (st === "unknown") return { state: "waiting", reason: `buy ${job.buySig} may still land` };
  if (st === "failed") {
    o.ledger.write({ ...job, status: "failed" });
    return { state: "refund", reason: `buy ${job.buySig} failed or expired` };
  }
  // confirmed: the tx itself says exactly how much it delivered
  const meta = await fetchMeta(conn, job.buySig!).catch(() => null);
  const delta = tokenDeltaFromMeta(meta, o.wallet.publicKey.toBase58(), job.mint);
  if (delta === null) return { state: "waiting", reason: "buy confirmed but its tx isn't readable yet" };
  const next: BuybackJob = { ...job, phase: "burn", boughtRaw: (delta > 0n ? delta : 0n).toString(), signature: undefined, lastValidBlockHeight: undefined };
  o.ledger.write(next);
  say(`recovered buy ${job.buySig}: ${next.boughtRaw} raw tokens to burn`);
  return burnPhase(conn, o.wallet, o.ledger, next, say);
}
