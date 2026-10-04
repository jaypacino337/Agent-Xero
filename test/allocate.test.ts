// Ported from memcoinz `.claude/skills/airdrop/scripts/allocate.test.ts` (branch claude/solana-skills).
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, drawWinners } from "../src/treasury/allocate.js";

const h = (owner: string, bal: number) => ({ owner, balanceRaw: BigInt(bal) });

test("prorata splits by balance and never exceeds the pot", () => {
  const r = allocate({ potRaw: 1000n, holders: [h("a", 1), h("b", 2), h("c", 7)] });
  assert.deepEqual(r.allocations.map((a) => a.amountRaw), [700n, 200n, 100n]);
  assert.equal(r.allocatedRaw + r.dustRaw, 1000n);
});

test("prorata cap redistributes the excess to uncapped wallets", () => {
  const holders = [h("whale", 900), ...Array.from({ length: 30 }, (_, i) => h(`w${i}`, 10))];
  const r = allocate({ potRaw: 1_000_000n, holders, capBps: 400 });
  const whale = r.allocations.find((a) => a.owner === "whale")!;
  assert.equal(whale.amountRaw, 40_000n);
  assert.ok(whale.capped);
  assert.ok(r.allocations.every((a) => a.amountRaw <= 40_000n));
  assert.ok(r.dustRaw < 100n, `dust ${r.dustRaw}`);
});

test("cap is relaxed when too few holders to absorb the pot", () => {
  const r = allocate({ potRaw: 1000n, holders: [h("a", 1), h("b", 1)], capBps: 400 });
  assert.ok(r.capRelaxed);
  assert.equal(r.allocatedRaw, 1000n);
});

test("equal mode", () => {
  const r = allocate({ potRaw: 10n, holders: [h("a", 1), h("b", 50), h("c", 9)], mode: "equal" });
  assert.deepEqual(r.allocations.map((a) => a.amountRaw), [3n, 3n, 3n]);
  assert.equal(r.dustRaw, 1n);
});

test("lottery is deterministic per seed and draws distinct winners", () => {
  const holders = Array.from({ length: 50 }, (_, i) => h(`w${i}`, i + 1));
  const a = drawWinners(holders, 5, 42).map((x) => x.owner);
  const b = drawWinners(holders, 5, 42).map((x) => x.owner);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 5);
  const r = allocate({ potRaw: 100n, holders, mode: "lottery", winners: 5, seed: 42 });
  assert.equal(r.allocations.length, 5);
  assert.equal(r.allocatedRaw, 100n);
});

test("dust filter drops tiny payouts", () => {
  const r = allocate({ potRaw: 1000n, holders: [h("a", 999), h("b", 1)], minPayoutRaw: 5n });
  assert.deepEqual(r.allocations.map((a) => a.owner), ["a"]);
});
