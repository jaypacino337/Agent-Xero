/**
 * pump.fun creator-fee claims (bonding curve + PumpSwap).
 *
 * Ported from memcoinz `.claude/skills/pump-claim/scripts/claim.ts`
 * (`claimable`, `claimCreatorFees`, branch claude/solana-skills).
 * Claims go through PumpPortal trade-local (`collectCreatorFee`): PumpPortal
 * builds the tx and it is signed here, so no API key and the key never
 * leaves the process. One claim sweeps every coin the creator launched.
 *
 * Changes vs. the source: the claim signature is written to a ledger before
 * broadcast, and the amount credited is the creator's lamport delta read
 * from the confirmed tx itself (exact even while the same wallet trades);
 * the balance delta is only the fallback. `reconcileClaims` credits a claim
 * that landed while the process was down.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Ledger,
  fetchMeta,
  lamportDeltaFromMeta,
  pumpAmmCreatorVaultAuthority,
  pumpCreatorVault,
  pumpPortalLocal,
  sendPreSigned,
  signPumpPortalTx,
  signatureStates,
  type LedgerEntry,
} from "../chain/solana.js";

/** Best-effort view of what's claimable. Rent-exempt minimum stays in the bonding vault. */
export async function claimable(conn: Connection, creator: PublicKey) {
  const bondingVault = pumpCreatorVault(creator);
  const ammAuthority = pumpAmmCreatorVaultAuthority(creator);
  const ammWsol = getAssociatedTokenAddressSync(NATIVE_MINT, ammAuthority, true);
  const [bondingLamports, rent, ammBal] = await Promise.all([
    conn.getBalance(bondingVault),
    conn.getMinimumBalanceForRentExemption(0),
    conn.getTokenAccountBalance(ammWsol).catch(() => null),
  ]);
  const bonding = BigInt(Math.max(0, bondingLamports - rent));
  const amm = BigInt(ammBal?.value.amount ?? "0");
  return { bondingVault, ammWsol, bonding, amm, total: bonding + amm };
}

export interface ClaimEntry extends LedgerEntry {
  beforeLamports: string;
  claimedLamports?: string;
  /** set once the treasury has been credited, so a claim is never counted twice */
  credited?: boolean;
}

/**
 * Claims and returns lamports that actually landed in the creator wallet (net of fees).
 * `state: "waiting"` = the tx may still land; reconcileClaims() settles it later.
 */
export async function claimCreatorFees(
  conn: Connection,
  o: { creator: Keypair; ledger: Ledger; id: string; priorityFeeSol?: number },
): Promise<{ state: "done"; claimed: bigint; signature: string } | { state: "waiting"; signature: string; reason: string }> {
  const before = BigInt(await conn.getBalance(o.creator.publicKey));
  const bytes = await pumpPortalLocal({
    publicKey: o.creator.publicKey.toBase58(),
    action: "collectCreatorFee",
    priorityFee: o.priorityFeeSol ?? 0.000001,
    pool: "pump",
  });
  const pre = await signPumpPortalTx(conn, bytes, [o.creator]);
  const entry: ClaimEntry = {
    key: o.id,
    status: "pending",
    signature: pre.signature,
    lastValidBlockHeight: pre.lastValidBlockHeight,
    beforeLamports: before.toString(),
  };
  o.ledger.write(entry);
  try {
    await sendPreSigned(conn, pre);
  } catch (err) {
    return { state: "waiting", signature: pre.signature, reason: (err as Error).message.slice(0, 160) };
  }
  const meta = await fetchMeta(conn, pre.signature).catch(() => null);
  let claimed = lamportDeltaFromMeta(meta, 0);
  if (claimed === null) {
    const after = BigInt(await conn.getBalance(o.creator.publicKey));
    claimed = after - before;
  }
  if (claimed < 0n) claimed = 0n;
  o.ledger.write({ ...entry, status: "sent", claimedLamports: claimed.toString() });
  return { state: "done", claimed, signature: pre.signature };
}

/** Settles claims left pending by a crash/timeout. Returns newly confirmed claims (not yet credited). */
export async function reconcileClaims(conn: Connection, ledger: Ledger): Promise<ClaimEntry[]> {
  const pending = [...ledger.entries.values()].filter((e) => e.status === "pending" && e.signature) as ClaimEntry[];
  if (pending.length === 0) return [];
  const states = await signatureStates(conn, pending.map((e) => ({ signature: e.signature!, lastValidBlockHeight: e.lastValidBlockHeight })));
  const confirmed: ClaimEntry[] = [];
  for (const e of pending) {
    const st = states.get(e.signature!);
    if (st === "failed") ledger.write({ ...e, status: "failed" });
    if (st !== "confirmed") continue;
    const meta = await fetchMeta(conn, e.signature!).catch(() => null);
    const delta = lamportDeltaFromMeta(meta, 0);
    if (delta === null) continue; // not readable yet, try again next round
    const next: ClaimEntry = { ...e, status: "sent", claimedLamports: (delta > 0n ? delta : 0n).toString() };
    ledger.write(next);
    confirmed.push(next);
  }
  return confirmed;
}
