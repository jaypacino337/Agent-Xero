/**
 * End-to-end paper-pipeline simulation (npm run sim).
 *
 * Feeds synthetic market data through the real scorer/trader/treasury path
 * and asserts the full loop: signals → entry → runner-target scale-out →
 * trailing stop → realized profit → buyback pool → paper buyback & burn →
 * frozen airdrop plan + ledger (resume-safe) → creator-fee bookkeeping.
 * Only the SOL price fetch and the holder snapshot are mocked. Runs in a
 * fresh temp DATA_DIR and always in paper mode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SIM_DATA_DIR keeps the result around (e.g. to preview the dashboard with data)
process.env.DATA_DIR = process.env.SIM_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "xero-sim-"));
process.env.PAPER_TRADING = "true";
process.env.XERO_MINT ||= "XeroSimMint11111111111111111111111111111111";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: unknown) => {
  if (String(url).includes("coingecko")) {
    return new Response(JSON.stringify({ solana: { usd: 200 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url as string, init as RequestInit);
}) as typeof fetch;

const { startSolPriceFeed, getSolUsd } = await import("../market/solPrice.js");
const { tracker } = await import("../signals/bus.js");
const { startVolumeDetector } = await import("../signals/volume.js");
const { Trader } = await import("../engine/trader.js");
const { db } = await import("../store/db.js");
const { treasury } = await import("../treasury/treasury.js");
const { shortId } = await import("../util/logger.js");
const { BuybackEngine } = await import("../treasury/buyback.js");
const { AirdropEngine } = await import("../treasury/airdrop.js");
const { LEDGER_DIR } = await import("../store/db.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
};

assert(db.positions.length === 0, "expected a clean temp data dir");

startSolPriceFeed();
await sleep(200);
assert(getSolUsd() === 200, "price mock failed");

treasury.recordDeposit(10);
startVolumeDetector();
const trader = new Trader();
trader.start();
trader.on("exit", (p) => treasury.onPositionClosed(p));

const MINT = "TESTMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx11";
const SUPPLY = 1_000_000_000;

function buyAt(mcUsd: number, buyer: string, sol = 2) {
  const mcSol = mcUsd / 200;
  const priceSol = mcSol / SUPPLY;
  tracker.recordTrade({
    mint: MINT,
    trader: buyer,
    side: "buy",
    sol,
    tokenAmount: sol / priceSol,
    marketCapSol: mcSol,
    symbol: "TEST",
    at: Date.now(),
  });
}

// 1. smart-wallet confluence signal (as the watcher would emit)
tracker.recordSignal({
  id: shortId(),
  source: "smart-wallet-confluence",
  mint: MINT,
  symbol: "TEST",
  at: Date.now(),
  strength: 90,
  detail: "3 tracked wallets bought within 300s",
  mcUsd: 6000,
});

// 2. 30 unique buyers / 45 SOL at ~$6k mc -> volume signal -> entry
for (let i = 0; i < 30; i++) buyAt(6000 + i * 30, `buyer${i}`, 1.5);
await sleep(300);

const open = db.positions.filter((p) => p.status === "open");
console.log("open after signals:", open.length, "score:", open[0]?.score, open[0]?.sources);
assert(open.length === 1, "expected exactly one entry");

// 3. pump past the runner target -> scale-out
buyAt(105_000, "whale1", 5);
await sleep(300);
const p = db.positions[0];
console.log("target hit:", p.targetHit, "remaining:", (p.tokensRemaining / p.tokenAmount).toFixed(2));
assert(p.targetHit, "expected runner target hit");

// 4. 40%+ retrace off peak -> trailing stop closes the rest
buyAt(60_000, "seller1", 0.5);
await sleep(300);
console.log("status:", p.status, "pnl:", p.realizedPnlSol?.toFixed(3), "SOL —", p.exitReason);
assert(p.status === "closed", "expected position closed");
assert((p.realizedPnlSol ?? 0) > 0, "expected profit on a 6k→100k runner");
assert(db.treasury.pendingBuybackSol > 0, "expected profit routed to buyback pool");
assert(db.treasury.pendingAirdropSol > 0, "expected profit share routed to airdrop pool");

// profit split should match config (default 70/30)
const pnl = p.realizedPnlSol!;
const buybackShare = db.treasury.pendingBuybackSol / pnl;
console.log(
  `split check: ${(buybackShare * 100).toFixed(0)}% buyback / ${((db.treasury.pendingAirdropSol / pnl) * 100).toFixed(0)}% airdrop`,
);
assert(Math.abs(buybackShare - 0.7) < 0.01, "expected ~70% of profit to buyback");

// callout rewards route 100% to the airdrop pool by default
const beforeDrop = db.treasury.pendingAirdropSol;
treasury.recordCalloutProfit(1.0);
assert(
  Math.abs(db.treasury.pendingAirdropSol - beforeDrop - 1.0) < 1e-9,
  "expected 100% of callout rewards in airdrop pool",
);

// 5. paper buyback & burn spends exactly the pool
const pool = db.treasury.pendingBuybackSol;
await new BuybackEngine().tick();
assert(db.burns.length === 1, "expected one burn event");
assert(Math.abs(db.burns[0].solSpent - pool) < 1e-6, "buyback should spend the pool");
assert(db.treasury.pendingBuybackSol < 1e-6, "buyback pool drained");
console.log(`buyback: ${db.burns[0].solSpent.toFixed(3)} SOL → ${Math.round(db.burns[0].xeroBurned)} XERO burned (paper)`);

// 6. airdrop: frozen plan + ledger, pool moved out before paying, rerun is a no-op
const holders = Array.from({ length: 40 }, (_, i) => ({
  owner: `Holder${String(i).padStart(2, "0")}1111111111111111111111111111111`.slice(0, 44),
  balanceRaw: BigInt((40 - i) * 1_000_000_000),
}));
const snapshot = async (mint: string) => ({
  mint, decimals: 6, tokenProgram: "", slot: 31337, takenAt: new Date().toISOString(),
  source: "rpc" as const, supplyRaw: 0n, holders, excludedCount: 0, seated: false,
});
const dropPool = db.treasury.pendingAirdropSol;
const engine = new AirdropEngine({ snapshot });
assert(await engine.runOnce(), "expected the airdrop to complete");
const drop = db.airdrops[0];
assert(drop && drop.recipientCount > 0, "expected an airdrop event");
assert(drop.slot === 31337, "plan should record the snapshot slot (lottery seed)");
assert(fs.existsSync(path.join(LEDGER_DIR, `${drop.planId}.plan.json`)), "plan frozen to disk");
assert(fs.existsSync(path.join(LEDGER_DIR, `${drop.planId}.jsonl`)), "ledger written");
assert(Math.abs(db.treasury.totalAirdropSol + db.treasury.pendingAirdropSol - dropPool) < 1e-6, "pool = dropped + dust");
assert(db.treasury.inFlightAirdropSol < 1e-9 && !db.jobs.airdrop, "no job left in flight");
await new AirdropEngine({ snapshot }).runOnce(); // pool is only dust now: must not drop again
assert(db.airdrops.length === 1, "exactly one drop");
console.log(`airdrop: ${drop.totalSol.toFixed(3)} SOL to ${drop.recipientCount} holders (${drop.mode}, plan ${drop.planId})`);

// 7. manual creator-fee fallback is recorded as such
treasury.recordCreatorFees(0.25, { source: "manual" });
assert(db.claims.length === 1 && db.claims[0].source === "manual", "manual fee entry recorded");
assert(Math.abs(db.treasury.totalCreatorFeesSol - 0.25) < 1e-9, "fees credited");

console.log("treasury:", JSON.stringify(db.treasury));
console.log("\n✅ E2E OK: signals → entry → target scale-out → trailing stop → profit → buyback + airdrop pools; callout rewards → airdrops; paper burn; frozen-plan airdrop; fee bookkeeping");
db.flush();
process.exit(0);
