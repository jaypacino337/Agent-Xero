/**
 * $XERO holder snapshot.
 *
 * Ported from memcoinz `.claude/skills/snapshot/scripts/snapshot.ts`
 * (branch claude/solana-skills), which itself grew out of this file. What the
 * port fixes vs. the old Agent Xero version:
 *   - exact bigint balances (the old one summed float ui amounts)
 *   - detects the token program, so Token-2022 coins snapshot correctly
 *     (the old RPC path only scanned the legacy SPL program)
 *   - excludes the bonding curve and every off-curve owner (PDA = pools,
 *     vaults, lockers), so LPs can't win drops
 *   - records the slot: the lottery seed and the airdrop plan id
 *   - optional guest list: with SEATS_URL set, only seated wallets are kept
 *     (memcoinz `seats` skill; refuses to pay if the seat list is unreachable)
 * Kept from the old version: AIRDROP_MIN_HOLDING_PCT dust filter and
 * AIRDROP_EXCLUDE.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { INCINERATOR, pumpBondingCurve, tokenInfo } from "./solana.js";
import type { HolderBalance } from "../treasury/allocate.js";

export interface HolderSnapshot {
  mint: string;
  decimals: number;
  tokenProgram: string;
  slot: number;
  takenAt: string;
  source: "helius" | "rpc";
  supplyRaw: bigint;
  holders: HolderBalance[];
  excludedCount: number;
  seated: boolean;
}

export interface SnapshotOptions {
  mint: PublicKey;
  /** Drop wallets below this share of supply (percent, e.g. 0.05 = 0.05%). */
  minHoldingPct?: number;
  exclude?: string[];
  heliusApiKey?: string;
  /** Guest-list site base URL: keep only wallets holding a seat on this coin. */
  seatsUrl?: string;
}

/** Wallets holding a seat on `mint`, from a guest-list site's public API (memcoinz seats). */
export async function seatedWallets(siteUrl: string, mint: string): Promise<Set<string>> {
  const res = await fetch(new URL(`/api/seats?mint=${mint}`, siteUrl), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`seat list unavailable from ${siteUrl} (${res.status}): refusing to pay without it`);
  const json = (await res.json()) as { seats?: { wallet: string }[] };
  return new Set((json.seats ?? []).map((s) => s.wallet));
}

async function viaHelius(apiKey: string, mint: string): Promise<{ owner: string; amount: bigint }[]> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const out: { owner: string; amount: bigint }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "xero",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as {
      error?: { message: string };
      result?: { token_accounts?: { owner: string; amount: number | string }[]; cursor?: string };
    };
    if (json.error) throw new Error(`Helius: ${json.error.message}`);
    const accounts = json.result?.token_accounts ?? [];
    for (const a of accounts) out.push({ owner: a.owner, amount: BigInt(a.amount) });
    cursor = json.result?.cursor;
    if (!cursor || accounts.length === 0) break;
  }
  return out;
}

async function viaRpc(conn: Connection, mint: PublicKey, programId: PublicKey) {
  if (conn.rpcEndpoint.includes("api.mainnet-beta.solana.com")) {
    throw new Error("holder scans need a dedicated RPC (Helius/Triton/QuickNode): set RPC_URL or HELIUS_API_KEY");
  }
  const accounts = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const out: { owner: string; amount: bigint }[] = [];
  for (const { pubkey: pk, account } of accounts) {
    try {
      const acc = unpackAccount(pk, account, programId);
      if (acc.isFrozen) continue;
      out.push({ owner: acc.owner.toBase58(), amount: acc.amount });
    } catch {
      // not a token account layout (e.g. the mint itself under Token-2022); skip
    }
  }
  return out;
}

export async function takeSnapshot(conn: Connection, opts: SnapshotOptions): Promise<HolderSnapshot> {
  const { programId, decimals, supply } = await tokenInfo(conn, opts.mint);
  const slot = await conn.getSlot("confirmed");
  const raw = opts.heliusApiKey
    ? await viaHelius(opts.heliusApiKey, opts.mint.toBase58())
    : await viaRpc(conn, opts.mint, programId);

  const byOwner = new Map<string, bigint>();
  for (const r of raw) {
    if (r.amount > 0n) byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0n) + r.amount);
  }

  const exclude = new Set([INCINERATOR, pumpBondingCurve(opts.mint).toBase58(), ...(opts.exclude ?? [])]);
  // basis points of a percent: 0.05% of supply = supply * 5 / 10_000
  const minRaw = (supply * BigInt(Math.round((opts.minHoldingPct ?? 0) * 100))) / 10_000n;
  const seated = opts.seatsUrl ? await seatedWallets(opts.seatsUrl, opts.mint.toBase58()) : null;

  let excludedCount = 0;
  const holders: HolderBalance[] = [];
  for (const [owner, balanceRaw] of byOwner) {
    if (seated && !seated.has(owner)) continue; // guest list: no seat, no reward
    const isPda = !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
    if (exclude.has(owner) || isPda) {
      excludedCount++;
      continue;
    }
    if (balanceRaw < minRaw || balanceRaw === 0n) continue;
    holders.push({ owner, balanceRaw });
  }
  holders.sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : a.owner < b.owner ? -1 : 1));

  return {
    mint: opts.mint.toBase58(),
    decimals,
    tokenProgram: programId.toBase58(),
    slot,
    takenAt: new Date().toISOString(),
    source: opts.heliusApiKey ? "helius" : "rpc",
    supplyRaw: supply,
    holders,
    excludedCount,
    seated: !!seated,
  };
}
