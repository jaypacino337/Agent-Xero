/**
 * Crash-safe SOL payout engine for holder airdrops.
 *
 * Ported from memcoinz `.claude/skills/airdrop/scripts/airdrop.ts`
 * (`runAirdrop`, branch claude/solana-skills), split into buildPlan /
 * executePlan so the AirdropEngine can freeze a plan, move the SOL out of
 * the pending pool, and resume the same plan on every tick or restart.
 *
 * Guarantees (kept from the source):
 *   - integer lamports, rounding down: payouts never exceed the pot
 *   - rent-aware: empty wallets whose payout is below rent-exemption are
 *     dropped and the pot re-split (else the runtime rejects the whole batch)
 *   - pre-flight balance check before the first transfer
 *   - plan frozen to <dir>/<id>.plan.json; each batch's signature is fsync'd
 *     to <dir>/<id>.jsonl BEFORE broadcast; resume reconciles on-chain, so
 *     nobody is paid twice
 *   - the payer is never paid itself
 * Added here: batches whose tx may still land are left alone (not retried)
 * until their blockhash expires; paper mode runs the same plan/ledger path
 * with simulated signatures.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { Ledger, buildSigned, priorityIxs, sendPreSigned, sol } from "../chain/solana.js";
import type { HolderSnapshot } from "../chain/holders.js";
import { allocate, type HolderBalance } from "./allocate.js";

export const FEE_PER_TX_LAMPORTS = 10_000n;

export type DropMode = "prorata" | "equal" | "lottery";

export interface AirdropPlan {
  id: string;
  createdAt: number;
  mint: string;
  slot: number;
  mode: DropMode;
  /** what the pool held when the plan was made */
  potLamports: string;
  /** sum of payouts (≤ pot; the dust stays in the pool) */
  allocatedLamports: string;
  payouts: { owner: string; lamports: string }[];
  capRelaxed: boolean;
  cappedCount: number;
  droppedForRent: number;
  seated: boolean;
  paper: boolean;
}

export interface BuildPlanOptions {
  snapshot: Pick<HolderSnapshot, "mint" | "slot" | "holders" | "seated">;
  potLamports: bigint;
  mode: DropMode;
  capBps?: number;
  winners?: number;
  /** prorata/equal: only the top N holders by balance are paid */
  maxRecipients?: number;
  minPayoutLamports?: bigint;
  /** never pay the payer itself */
  payer?: string;
  paper: boolean;
  /** used for the rent-exemption check; omit to skip it (paper / offline) */
  conn?: Connection;
  now?: number;
}

export function planId(o: Pick<BuildPlanOptions, "snapshot" | "potLamports" | "mode" | "capBps" | "winners" | "maxRecipients">): string {
  // same inputs → same id → resume; any change → a new plan
  const settings = JSON.stringify([o.potLamports.toString(), o.mode, o.capBps ?? 10_000, o.winners, o.maxRecipients]);
  const hash = createHash("sha256").update(settings).digest("hex").slice(0, 6);
  return `airdrop-${o.snapshot.mint.slice(0, 6)}-${o.snapshot.slot}-${hash}`;
}

export async function buildPlan(o: BuildPlanOptions): Promise<AirdropPlan> {
  let holders: HolderBalance[] = o.snapshot.holders.filter((h) => h.owner !== o.payer);
  if (o.mode !== "lottery" && o.maxRecipients) holders = holders.slice(0, o.maxRecipients);

  const run = () =>
    allocate({
      potRaw: o.potLamports,
      holders,
      mode: o.mode,
      capBps: o.capBps,
      winners: o.winners,
      seed: o.snapshot.slot,
      minPayoutRaw: o.minPayoutLamports ?? 100_000n,
    });
  let result = run();
  let droppedForRent = 0;
  if (o.conn) {
    // The runtime rejects a SOL transfer that would create an account below
    // rent-exemption. Drop those wallets and re-split so the pot isn't wasted.
    const rentMin = BigInt(await o.conn.getMinimumBalanceForRentExemption(0));
    for (let pass = 0; pass < 5; pass++) {
      const small = result.allocations.filter((a) => a.amountRaw < rentMin);
      if (small.length === 0) break;
      const infos: unknown[] = [];
      for (let i = 0; i < small.length; i += 100) {
        infos.push(...(await o.conn.getMultipleAccountsInfo(small.slice(i, i + 100).map((a) => new PublicKey(a.owner)))));
      }
      const unfundable = new Set(small.filter((_, i) => !infos[i]).map((a) => a.owner));
      if (unfundable.size === 0) break;
      droppedForRent += unfundable.size;
      holders = holders.filter((h) => !unfundable.has(h.owner));
      result = run();
    }
  }

  return {
    id: planId(o),
    createdAt: o.now ?? Date.now(),
    mint: o.snapshot.mint,
    slot: o.snapshot.slot,
    mode: o.mode,
    potLamports: o.potLamports.toString(),
    allocatedLamports: result.allocatedRaw.toString(),
    payouts: result.allocations.map((a) => ({ owner: a.owner, lamports: a.amountRaw.toString() })),
    capRelaxed: result.capRelaxed,
    cappedCount: result.cappedCount,
    droppedForRent,
    seated: o.snapshot.seated,
    paper: o.paper,
  };
}

export const planFile = (dir: string, id: string) => path.join(dir, `${id}.plan.json`);
export const ledgerFile = (dir: string, id: string) => path.join(dir, `${id}.jsonl`);

/** Freezes the plan to disk (atomic + fsync). Never overwrites an existing plan. */
export function savePlan(dir: string, plan: AirdropPlan): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = planFile(dir, plan.id);
  if (fs.existsSync(file)) return;
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(plan, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function loadPlan(dir: string, id: string): AirdropPlan | null {
  const file = planFile(dir, id);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as AirdropPlan) : null;
}

export interface ExecuteOptions {
  plan: AirdropPlan;
  dir: string;
  /** required unless paper */
  conn?: Connection;
  payer?: Keypair | null;
  paper: boolean;
  batchSize?: number;
  priorityMicroLamports?: number;
  log?: (msg: string) => void;
}

export interface ExecuteResult {
  paid: number;
  failedBatches: number;
  /** recipients whose batch may still land: not retried until decided */
  undecided: number;
  /** recipients not yet confirmed paid */
  remaining: number;
  paidLamports: bigint;
  signatures: string[];
}

/** Ledger state of a plan without touching the chain (for the dashboard). */
export function planProgress(dir: string, plan: AirdropPlan) {
  const ledger = new Ledger(ledgerFile(dir, plan.id));
  const paid = plan.payouts.filter((p) => ledger.isSent(p.owner));
  return {
    paid: paid.length,
    total: plan.payouts.length,
    paidLamports: paid.reduce((s, p) => s + BigInt(p.lamports), 0n),
    signatures: [...new Set(paid.map((p) => ledger.entries.get(p.owner)!.signature!).filter(Boolean))],
  };
}

export async function executePlan(o: ExecuteOptions): Promise<ExecuteResult> {
  const say = o.log ?? (() => undefined);
  const { plan } = o;
  const ledger = new Ledger(ledgerFile(o.dir, plan.id));
  const batchSize = o.batchSize ?? 10;

  let undecidedBatches = 0;
  if (!o.paper) {
    if (!o.conn || !o.payer) throw new Error("live payout needs an RPC connection and the payer keypair");
    undecidedBatches = await ledger.reconcile(o.conn);
  }

  const todo = plan.payouts.filter((p) => !ledger.isSent(p.owner) && !ledger.isPending(p.owner));
  if (undecidedBatches) {
    const waiting = plan.payouts.filter((p) => ledger.isPending(p.owner)).length;
    say(`${waiting} recipients in batches that may still land: waiting for them before any retry`);
  }

  let paid = 0;
  let failedBatches = 0;
  if (todo.length > 0 && !o.paper) {
    const total = todo.reduce((s, p) => s + BigInt(p.lamports), 0n);
    const txCount = BigInt(Math.ceil(todo.length / batchSize));
    const need = total + txCount * FEE_PER_TX_LAMPORTS;
    const have = BigInt(await o.conn!.getBalance(o.payer!.publicKey));
    if (have < need) {
      throw new Error(`payer has ${sol(have)} SOL, needs ~${sol(need)} for ${todo.length} payouts. Aborting before any transfer.`);
    }
  }

  for (let i = 0; i < todo.length; i += batchSize) {
    const chunk = todo.slice(i, i + batchSize);
    const n = i / batchSize + 1;
    if (o.paper) {
      const signature = `paper-${plan.id.slice(-6)}-${ledger.entries.size + n}`;
      for (const p of chunk) ledger.write({ key: p.owner, status: "sent", signature, lamports: p.lamports });
      paid += chunk.length;
      continue;
    }
    const ixs: TransactionInstruction[] = [...priorityIxs(o.priorityMicroLamports ?? 0)];
    for (const p of chunk) {
      ixs.push(
        SystemProgram.transfer({ fromPubkey: o.payer!.publicKey, toPubkey: new PublicKey(p.owner), lamports: BigInt(p.lamports) }),
      );
    }
    let signature: string | undefined;
    try {
      const built = await buildSigned(o.conn!, ixs, [o.payer!]);
      signature = built.signature;
      for (const p of chunk) {
        ledger.write({ key: p.owner, status: "pending", signature, lastValidBlockHeight: built.lastValidBlockHeight, lamports: p.lamports });
      }
      await sendPreSigned(o.conn!, built);
      for (const p of chunk) ledger.write({ key: p.owner, status: "sent", signature, lamports: p.lamports });
      paid += chunk.length;
      say(`batch ${n}: ${chunk.length} paid ${signature}`);
    } catch (err) {
      // entries stay "pending": the next run's reconcile() decides from the chain
      failedBatches++;
      say(`batch ${n} failed/unknown (${signature ?? "unsigned"}): ${(err as Error).message.split("\n")[0].slice(0, 200)}`);
    }
  }

  const sentList = plan.payouts.filter((p) => ledger.isSent(p.owner));
  return {
    paid,
    failedBatches,
    undecided: plan.payouts.filter((p) => ledger.isPending(p.owner)).length,
    remaining: plan.payouts.length - sentList.length,
    paidLamports: sentList.reduce((s, p) => s + BigInt(p.lamports), 0n),
    signatures: [...new Set(sentList.map((p) => ledger.entries.get(p.owner)!.signature!))],
  };
}
