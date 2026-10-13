/**
 * The treasury engines in LIVE mode against an in-memory fake chain (no
 * network, no real keys): pool accounting is committed to disk before any
 * broadcast, and a crash/restart resumes the same job without double-paying,
 * double-buying or double-crediting.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { FakeChain, mockPumpPortal } from "./helpers/fakeChain.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xero-engines-"));
const operator = Keypair.generate();
const mint = Keypair.generate();
Object.assign(process.env, {
  DATA_DIR: dataDir,
  PAPER_TRADING: "false",
  XERO_MINT: mint.publicKey.toBase58(),
  WALLET_SECRET_KEY: JSON.stringify(Array.from(operator.secretKey)),
  AIRDROP_MODE: "equal",
  AIRDROP_BATCH_SIZE: "10",
  AIRDROP_MIN_SOL: "0.5",
  BUYBACK_MIN_SOL: "0.1",
  CLAIM_MIN_SOL: "0.01",
});

const { db } = await import("../src/store/db.js");
const { setConnection } = await import("../src/chain/wallet.js");
const { AirdropEngine } = await import("../src/treasury/airdrop.js");
const { BuybackEngine } = await import("../src/treasury/buyback.js");
const { FeeClaimer, autoClaimLive } = await import("../src/treasury/fees.js");
const { pumpCreatorVault } = await import("../src/chain/solana.js");

const chain = new FakeChain();
chain.addMint(mint.publicKey, TOKEN_PROGRAM_ID);
chain.lamports.set(operator.publicKey.toBase58(), 1_000n * BigInt(LAMPORTS_PER_SOL));
setConnection(chain.conn);
const pp = mockPumpPortal(operator.publicKey);

const diskTreasury = () => JSON.parse(fs.readFileSync(path.join(dataDir, "treasury.json"), "utf8"));
const approx = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

before(() => {
  db.treasury.tradingSol = 10;
});

test("airdrop: pool committed before broadcast; failed batches resume after restart; each holder paid once", async () => {
  const holders = Array.from({ length: 25 }, (_, i) => ({ owner: Keypair.generate().publicKey.toBase58(), balanceRaw: BigInt(1_000 + i) }));
  for (const h of holders) chain.lamports.set(h.owner, 1n);
  const snapshot = async () => ({ mint: mint.publicKey.toBase58(), decimals: 6, tokenProgram: "", slot: 42, takenAt: "", source: "rpc" as const, supplyRaw: 0n, holders, excludedCount: 0, seated: false });

  db.treasury.pendingAirdropSol = 1;
  chain.plan = ["land", "land-timeout", "drop"];
  const ok1 = await new AirdropEngine({ snapshot }).runOnce();
  assert.equal(ok1, false, "not finished yet");
  assert.ok(db.jobs.airdrop, "job persisted");
  approx(db.treasury.inFlightAirdropSol, 1);
  assert.ok(db.treasury.pendingAirdropSol < 1e-6, "pool decremented (dust only)");
  approx(diskTreasury().inFlightAirdropSol, 1); // on disk, not just in memory
  assert.equal(db.airdrops.length, 0);

  // "restart" while batch 3 could still land: nothing re-sent
  const sends = chain.sends;
  assert.equal(await new AirdropEngine({ snapshot }).runOnce(), false);
  assert.equal(chain.sends, sends);

  chain.height += 1_000; // batch 3's blockhash is dead
  assert.equal(await new AirdropEngine({ snapshot }).runOnce(), true);
  assert.equal(db.airdrops.length, 1);
  assert.equal(db.jobs.airdrop, undefined);
  approx(db.treasury.inFlightAirdropSol, 0);
  approx(db.treasury.totalAirdropSol, 1);
  const paid = new Map<string, number>();
  for (const t of chain.transfers) paid.set(t.to, (paid.get(t.to) ?? 0) + 1);
  assert.equal(paid.size, 25);
  assert.ok([...paid.values()].every((n) => n === 1), "nobody paid twice");
  assert.equal(db.airdrops[0].recipientCount, 25);
  assert.equal(db.airdrops[0].slot, 42);
});

test("buyback: crash after the buy → restart burns exactly the bought delta once", async () => {
  const ata = getAssociatedTokenAddressSync(mint.publicKey, operator.publicKey, false, TOKEN_PROGRAM_ID).toBase58();
  const HELD = 9_000_000_000n;
  const BOUGHT = 123_456_789n;
  chain.tokens.set(ata, HELD);
  chain.onBuy = (sig) => {
    const before = chain.tokens.get(ata)!;
    chain.tokens.set(ata, before + BOUGHT);
    const tb = (a: bigint) => [{ accountIndex: 1, mint: mint.publicKey.toBase58(), owner: operator.publicKey.toBase58(), uiTokenAmount: { amount: a.toString() } }];
    chain.metas.set(sig, { preBalances: [0], postBalances: [0], preTokenBalances: tb(before), postTokenBalances: tb(before + BOUGHT) });
    chain.hidden.add(sig); // the RPC lags: our process "dies" before seeing it
  };
  const buysBefore = pp.calls.length;
  db.treasury.pendingBuybackSol = 0.5;
  chain.plan = ["land-timeout"];
  await new BuybackEngine().tick();
  assert.ok(db.jobs.buyback);
  approx(db.treasury.pendingBuybackSol, 0);
  approx(diskTreasury().inFlightBuybackSol, 0.5);
  assert.equal(chain.burns.length, 0);

  chain.hidden.clear();
  await new BuybackEngine().tick(); // restart
  assert.equal(db.jobs.buyback, undefined);
  assert.equal(chain.burns.length, 1);
  assert.equal(chain.burns[0].amount, BOUGHT);
  assert.equal(chain.tokens.get(ata), HELD, "pre-existing balance untouched");
  assert.equal(pp.calls.length - buysBefore, 1, "one buy");
  assert.equal(db.burns.at(-1)!.burnedRaw, BOUGHT.toString());
  approx(db.treasury.totalBuybackSol, 0.5);
  approx(db.treasury.inFlightBuybackSol, 0);
});

test("buyback: a buy that never lands is refunded to the pool, not re-bought", async () => {
  chain.onBuy = undefined;
  const burns = chain.burns.length;
  db.treasury.pendingBuybackSol = 0.3;
  chain.plan = ["drop"];
  await new BuybackEngine().tick();
  approx(db.treasury.pendingBuybackSol, 0);
  chain.height += 1_000;
  const calls = pp.calls.length;
  await new BuybackEngine().tick();
  assert.equal(pp.calls.length, calls, "resume doesn't buy again");
  approx(db.treasury.pendingBuybackSol, 0.3);
  approx(db.treasury.inFlightBuybackSol, 0);
  assert.equal(chain.burns.length, burns);
  assert.equal(db.jobs.buyback, undefined);
});

test("auto-claim: credits exactly what landed, once — including a claim that lands during a crash", async () => {
  assert.equal(autoClaimLive(), true);
  const vault = pumpCreatorVault(operator.publicKey).toBase58();
  const CLAIM = 1_500_000_000n;
  const arm = () => {
    chain.lamports.set(vault, CLAIM + 890_880n);
    chain.onBuy = (sig) => {
      chain.lamports.set(vault, 890_880n);
      chain.metas.set(sig, { preBalances: [10e9], postBalances: [10e9 + Number(CLAIM) - 5_000], preTokenBalances: [], postTokenBalances: [] });
    };
  };
  const feesBefore = db.treasury.totalCreatorFeesSol;
  const tradingBefore = db.treasury.tradingSol;
  arm();
  await new FeeClaimer().tick();
  assert.equal(db.claims.length, 1);
  assert.equal(db.claims[0].source, "auto");
  approx(db.treasury.totalCreatorFeesSol - feesBefore, 1.499995);
  approx(db.treasury.tradingSol - tradingBefore, 1.499995);
  await new FeeClaimer().tick(); // vault empty now
  assert.equal(db.claims.length, 1);

  // claim lands but we crash before seeing it
  arm();
  const orig = chain.onBuy!;
  chain.onBuy = (sig) => {
    orig(sig);
    chain.hidden.add(sig);
  };
  chain.plan = ["land-timeout"];
  await new FeeClaimer().tick();
  assert.equal(db.claims.length, 1, "not credited while unconfirmed");
  chain.hidden.clear();
  await new FeeClaimer().tick(); // restart → reconcile credits it
  await new FeeClaimer().tick(); // and never twice
  assert.equal(db.claims.length, 2);
  approx(db.treasury.totalCreatorFeesSol - feesBefore, 2 * 1.499995);
  approx(db.treasury.totalAutoClaimedSol, 2 * 1.499995);
});
