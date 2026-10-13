/**
 * Ported verbatim from memcoinz `.claude/skills/airdrop/scripts/allocate.ts`
 * (branch claude/solana-skills). Agent Xero maps its modes onto it:
 *   AIRDROP_MODE=linear -> prorata (optional AIRDROP_CAP_BPS)
 *   AIRDROP_MODE=random -> lottery (seeded with the snapshot slot, reproducible)
 *   AIRDROP_MODE=equal  -> equal
 */
/**
 * Pure allocation math — no RPC, fully unit-tested (allocate.test.ts).
 *
 * Modes:
 *   prorata  split the pot by balance, optional per-wallet cap with iterative
 *            redistribution (ported from Airdrop/worker/src/core/allocate.ts)
 *   equal    every eligible wallet gets the same amount
 *   lottery  N winners drawn weighted by balance, split the pot equally
 *            (Agent-Xero's "random" mode, but with a seeded RNG so a draw can
 *            be reproduced and audited from the snapshot slot)
 *
 * All arithmetic is bigint on raw units. Rounding is always down, so the sum
 * of allocations never exceeds the pot; the remainder is reported as dust.
 */
export interface HolderBalance {
  owner: string;
  balanceRaw: bigint;
}

export interface Allocation {
  owner: string;
  balanceRaw: bigint;
  amountRaw: bigint;
  capped: boolean;
}

export interface AllocateOptions {
  potRaw: bigint;
  holders: readonly HolderBalance[];
  mode?: "prorata" | "equal" | "lottery";
  /** prorata: max share of the pot per wallet, in bps (10000 = no cap). */
  capBps?: number;
  /** lottery: number of winners. */
  winners?: number;
  /** lottery: RNG seed (use the snapshot slot). */
  seed?: number;
  /** Allocations below this are dropped (not worth the tx fee). */
  minPayoutRaw?: bigint;
}

export interface AllocationResult {
  allocations: Allocation[];
  allocatedRaw: bigint;
  dustRaw: bigint;
  cappedCount: number;
  /** True when too few holders exist for the cap to absorb the pot (n·cap < 100%). */
  capRelaxed: boolean;
}

const BPS = 10_000n;

export function allocate(opts: AllocateOptions): AllocationResult {
  const { potRaw } = opts;
  const mode = opts.mode ?? "prorata";
  const minPayoutRaw = opts.minPayoutRaw ?? 1n;
  if (potRaw < 0n) throw new Error("pot must not be negative");

  const holders = opts.holders
    .filter((h) => h.balanceRaw > 0n)
    .slice()
    .sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : a.owner < b.owner ? -1 : 1));

  const empty: AllocationResult = { allocations: [], allocatedRaw: 0n, dustRaw: potRaw, cappedCount: 0, capRelaxed: false };
  if (holders.length === 0 || potRaw === 0n) return empty;

  let raw: Allocation[];
  let cappedCount = 0;
  let capRelaxed = false;

  if (mode === "equal") {
    const each = potRaw / BigInt(holders.length);
    raw = holders.map((h) => ({ ...h, amountRaw: each, capped: false }));
  } else if (mode === "lottery") {
    const winners = drawWinners(holders, opts.winners ?? 10, opts.seed ?? Date.now());
    const each = potRaw / BigInt(winners.length);
    raw = winners.map((h) => ({ ...h, amountRaw: each, capped: false }));
  } else {
    const capBps = opts.capBps ?? 10_000;
    if (capBps < 1 || capBps > 10_000) throw new Error("capBps must be 1..10000");
    const capRaw = (potRaw * BigInt(capBps)) / BPS;
    capRelaxed = capBps < 10_000 && BigInt(holders.length) * BigInt(capBps) < BPS;

    const capped = new Map<string, bigint>();
    let active = holders;
    let budget = potRaw;
    if (capBps < 10_000 && !capRelaxed) {
      // Capping one wallet raises everyone else's share, which can push the
      // next wallet over — repeat until a pass caps nobody new.
      for (;;) {
        const activeBal = active.reduce((s, h) => s + h.balanceRaw, 0n);
        if (activeBal === 0n) break;
        const over = active.filter((h) => (budget * h.balanceRaw) / activeBal > capRaw);
        if (over.length === 0) break;
        for (const h of over) {
          capped.set(h.owner, capRaw);
          budget -= capRaw;
        }
        const overSet = new Set(over.map((h) => h.owner));
        active = active.filter((h) => !overSet.has(h.owner));
        if (active.length === 0 || budget <= 0n) break;
      }
    }
    const activeBal = active.reduce((s, h) => s + h.balanceRaw, 0n);
    cappedCount = capped.size;
    raw = holders.map((h) => {
      const c = capped.get(h.owner);
      const amountRaw = c ?? (activeBal > 0n && budget > 0n ? (budget * h.balanceRaw) / activeBal : 0n);
      return { ...h, amountRaw, capped: c !== undefined };
    });
  }

  const allocations = raw.filter((a) => a.amountRaw >= minPayoutRaw && a.amountRaw > 0n);
  const allocatedRaw = allocations.reduce((s, a) => s + a.amountRaw, 0n);
  return { allocations, allocatedRaw, dustRaw: potRaw - allocatedRaw, cappedCount, capRelaxed };
}

/** mulberry32 — tiny deterministic PRNG so lottery draws are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Balance-weighted draw without replacement. */
export function drawWinners(holders: readonly HolderBalance[], n: number, seed: number): HolderBalance[] {
  const pool = holders.slice();
  const rand = rng(seed);
  const winners: HolderBalance[] = [];
  const count = Math.min(n, pool.length);
  for (let k = 0; k < count; k++) {
    const total = pool.reduce((s, h) => s + h.balanceRaw, 0n);
    // 53-bit random scaled into [0, total)
    let pick = (BigInt(Math.floor(rand() * 2 ** 53)) * total) >> 53n;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      if (pick < pool[idx].balanceRaw) break;
      pick -= pool[idx].balanceRaw;
    }
    winners.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return winners;
}
