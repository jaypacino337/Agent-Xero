/**
 * Airdrop payouts: frozen plan, signature-before-broadcast ledger, resume
 * after a crash / timeout / failed batch without paying anyone twice,
 * rent-aware planning and the balance pre-check.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { Ledger } from "../src/chain/solana.js";
import { buildPlan, executePlan, ledgerFile, loadPlan, savePlan, type AirdropPlan } from "../src/treasury/payout.js";
import { FakeChain } from "./helpers/fakeChain.js";

let dir: string;
let chain: FakeChain;
let payer: Keypair;

const holders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ owner: Keypair.generate().publicKey.toBase58(), balanceRaw: BigInt((n - i) * 1_000_000) }));

function snapshot(n: number, slot = 777) {
  return { mint: Keypair.generate().publicKey.toBase58(), slot, holders: holders(n), seated: false };
}

async function livePlan(n: number, potSol = 2): Promise<AirdropPlan> {
  const snap = snapshot(n);
  for (const h of snap.holders) chain.lamports.set(h.owner, 1n); // existing wallets
  const plan = await buildPlan({ snapshot: snap, potLamports: BigInt(potSol * 1e9), mode: "equal", paper: false, conn: chain.conn });
  savePlan(dir, plan);
  return plan;
}

/** how much each recipient actually received, summed across all landed txs */
function received(): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const t of chain.transfers) m.set(t.to, (m.get(t.to) ?? 0n) + t.lamports);
  return m;
}

function assertPaidExactlyOnce(plan: AirdropPlan) {
  const got = received();
  for (const p of plan.payouts) {
    assert.equal(got.get(p.owner) ?? 0n, BigInt(p.lamports), `recipient ${p.owner.slice(0, 6)}`);
  }
  assert.equal(chain.transfers.length, plan.payouts.length, "one transfer per recipient, no repeats");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xero-drop-"));
  chain = new FakeChain();
  payer = Keypair.generate();
  chain.lamports.set(payer.publicKey.toBase58(), 100_000_000_000n);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("lottery plan is reproducible from the snapshot slot and never pays the payer", async () => {
  const snap = snapshot(50);
  snap.holders.unshift({ owner: payer.publicKey.toBase58(), balanceRaw: 10n ** 15n });
  const opts = { snapshot: snap, potLamports: 1_000_000_000n, mode: "lottery" as const, winners: 10, payer: payer.publicKey.toBase58(), paper: true };
  const a = await buildPlan(opts);
  const b = await buildPlan(opts);
  assert.deepEqual(a.payouts, b.payouts);
  assert.equal(a.id, b.id);
  assert.equal(a.payouts.length, 10);
  assert.ok(!a.payouts.some((p) => p.owner === payer.publicKey.toBase58()));
  assert.ok(BigInt(a.allocatedLamports) <= 1_000_000_000n);
});

test("rent-aware: empty wallets below rent-exemption are dropped and the pot re-split", async () => {
  const snap = snapshot(3);
  snap.holders.push({ owner: Keypair.generate().publicKey.toBase58(), balanceRaw: 1n }); // tiny, brand-new wallet
  for (const h of snap.holders.slice(0, 3)) chain.lamports.set(h.owner, 1n);
  const plan = await buildPlan({ snapshot: snap, potLamports: 3_000_000_000n, mode: "prorata", paper: false, conn: chain.conn, minPayoutLamports: 1n });
  assert.equal(plan.droppedForRent, 1);
  assert.equal(plan.payouts.length, 3);
});

test("happy path: all batches paid; re-running pays nobody again", async () => {
  const plan = await livePlan(25);
  const r1 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r1.remaining, 0);
  assert.equal(r1.signatures.length, 3);
  const r2 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r2.paid, 0);
  assertPaidExactlyOnce(plan);
});

test("batch landed but confirm timed out + batch dropped: resume pays each recipient exactly once", async () => {
  const plan = await livePlan(25);
  // batch 1 fine, batch 2 lands but we never see the confirm, batch 3 never lands
  chain.plan = ["land", "land-timeout", "drop"];
  const r1 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r1.paid, 10);
  assert.equal(r1.failedBatches, 2);
  assert.equal(r1.remaining, 15);

  // immediate retry while batch 3's blockhash could still land: nothing is re-sent
  const sendsBefore = chain.sends;
  const r2 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(chain.sends, sendsBefore, "no retry while a batch may still land");
  assert.equal(r2.remaining, 5, "batch 2 reconciled as paid from the chain");
  assert.equal(r2.undecided, 5);

  // "restart" after the blockhash expired: batch 3 is provably dead → re-sent once
  chain.height += 1_000;
  const reloaded = loadPlan(dir, plan.id)!;
  const r3 = await executePlan({ plan: reloaded, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r3.remaining, 0);
  assertPaidExactlyOnce(plan);
});

test("crash right after the signature hit the ledger (before broadcast): no double pay", async () => {
  const plan = await livePlan(5);
  // simulate the crash: the ledger has a pending signature that was never broadcast
  const ledger = new Ledger(ledgerFile(dir, plan.id));
  for (const p of plan.payouts) ledger.write({ key: p.owner, status: "pending", signature: "5".repeat(88), lastValidBlockHeight: chain.height + 150 });
  const r1 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false });
  assert.equal(chain.sends, 0, "waits for the unknown signature");
  assert.equal(r1.remaining, 5);
  chain.height += 1_000;
  const r2 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false });
  assert.equal(r2.remaining, 0);
  assertPaidExactlyOnce(plan);
});

test("rejected batch stays in the plan and is retried after it expires", async () => {
  const plan = await livePlan(12);
  chain.plan = ["reject"];
  const r1 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r1.remaining, 10);
  chain.height += 1_000;
  const r2 = await executePlan({ plan, dir, conn: chain.conn, payer, paper: false, batchSize: 10 });
  assert.equal(r2.remaining, 0);
  assertPaidExactlyOnce(plan);
});

test("balance pre-check aborts before the first transfer", async () => {
  const plan = await livePlan(10, 5);
  chain.lamports.set(payer.publicKey.toBase58(), 1_000_000_000n); // 1 SOL for a 5 SOL drop
  await assert.rejects(executePlan({ plan, dir, conn: chain.conn, payer, paper: false }), /Aborting before any transfer/);
  assert.equal(chain.sends, 0);
});

test("plan is frozen: savePlan never overwrites, a changed pot gets a new id", async () => {
  const snap = snapshot(5);
  const a = await buildPlan({ snapshot: snap, potLamports: 1_000_000_000n, mode: "equal", paper: true });
  savePlan(dir, a);
  savePlan(dir, { ...a, payouts: [] });
  assert.equal(loadPlan(dir, a.id)!.payouts.length, 5);
  const b = await buildPlan({ snapshot: snap, potLamports: 2_000_000_000n, mode: "equal", paper: true });
  assert.notEqual(a.id, b.id);
});

test("paper mode runs the same ledger: second run pays nobody", async () => {
  const plan = await buildPlan({ snapshot: snapshot(7), potLamports: 1_000_000_000n, mode: "prorata", paper: true });
  savePlan(dir, plan);
  const r1 = await executePlan({ plan, dir, paper: true });
  assert.equal(r1.remaining, 0);
  assert.ok(r1.signatures.every((s) => s.startsWith("paper-")));
  const r2 = await executePlan({ plan, dir, paper: true });
  assert.equal(r2.paid, 0);
  assert.equal(chain.sends, 0);
});
