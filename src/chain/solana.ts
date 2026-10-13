/**
 * Shared Solana plumbing for the treasury (burns, airdrops, fee claims).
 *
 * Ported from memcoinz `.claude/skills/solana-core/scripts/lib.ts`
 * (branch claude/solana-skills). Changes vs. the source:
 *   - no dotenv / project-config / CLI helpers (Agent Xero has its own config)
 *   - `signPumpPortalTx` + `sendPreSigned` split PumpPortal sends in two, so
 *     the signature can be written to a ledger BEFORE broadcast (the source's
 *     `sendPumpPortalTx` only learns the signature after sending)
 *   - `Ledger.reconcile()` keeps an entry "pending" while its blockhash can
 *     still land, instead of marking an unseen signature "failed" right away
 *     (a late landing + a retry would otherwise pay twice)
 *   - `tokenDeltaFromMeta` / `lamportDeltaFromMeta` read exact amounts from
 *     a confirmed transaction, used to recover after a crash
 *
 * House rules kept: bigint raw amounts, detect the token program, never log
 * a secret key, write the signature before broadcasting.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type ParsedTransactionMeta,
  type TransactionResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import bs58 from "bs58";

// ── Well-known addresses ────────────────────────────────────────────────────
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
export const PUMPPORTAL_LOCAL = "https://pumpportal.fun/api/trade-local";

/** Blocks a blockhash stays valid for (~60-90s). Used when PumpPortal hands us a tx without lastValidBlockHeight. */
export const BLOCKHASH_VALIDITY = 150;

// ── Token helpers ───────────────────────────────────────────────────────────
export async function tokenInfo(conn: Connection, mint: PublicKey) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on this RPC (wrong cluster?)`);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(conn, mint, "confirmed", programId);
  return { programId, decimals: m.decimals, supply: m.supply };
}

/** pump.fun bonding-curve account for a mint (holds the curve's tokens pre-graduation). */
export function pumpBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

export function pumpCreatorVault(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID)[0];
}

export function pumpAmmCreatorVaultAuthority(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM_ID)[0];
}

// ── Amounts ─────────────────────────────────────────────────────────────────
export const sol = (lamports: bigint | number) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
export const lamports = (solAmount: number) => BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
export const lamportsToSol = (l: bigint) => Number(l) / LAMPORTS_PER_SOL;

export function toUi(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function toRaw(ui: number | string, decimals: number): bigint {
  const [whole, frac = ""] = String(ui).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

// ── Exact deltas from a confirmed transaction ──────────────────────────────
type AnyMeta = Pick<ParsedTransactionMeta, "preTokenBalances" | "postTokenBalances" | "preBalances" | "postBalances">;

/** Net change of `owner`'s balance of `mint` inside one transaction (raw units, may be negative). */
export function tokenDeltaFromMeta(meta: AnyMeta | null | undefined, owner: string, mint: string): bigint | null {
  if (!meta) return null;
  const sum = (list: AnyMeta["preTokenBalances"]) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

/** Net lamport change of the account at `index` (0 = fee payer), fees included. */
export function lamportDeltaFromMeta(meta: AnyMeta | null | undefined, index = 0): bigint | null {
  if (!meta || meta.preBalances[index] === undefined || meta.postBalances[index] === undefined) return null;
  return BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]);
}

export async function fetchMeta(conn: Connection, signature: string): Promise<AnyMeta | null> {
  const tx = (await conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  })) as TransactionResponse | VersionedTransactionResponse | null;
  return (tx?.meta as AnyMeta | undefined) ?? null;
}

// ── Sending ─────────────────────────────────────────────────────────────────
export function priorityIxs(microLamports: number, units?: number): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (units) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return ixs;
}

export interface PreSigned {
  raw: Uint8Array;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Builds + signs a legacy tx and returns its signature *before* sending, so a
 * caller can write it to a ledger first. If the process dies mid-send, the
 * ledger still knows which signature to look up on restart.
 */
export async function buildSigned(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<PreSigned> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  return { raw: tx.serialize(), signature: bs58.encode(tx.signature!), blockhash, lastValidBlockHeight };
}

/** Signs a PumpPortal trade-local response (serialized VersionedTransaction) without sending it. */
export async function signPumpPortalTx(conn: Connection, bytes: ArrayBuffer, signers: Keypair[]): Promise<PreSigned> {
  const tx = VersionedTransaction.deserialize(new Uint8Array(bytes));
  tx.sign(signers);
  const height = await conn.getBlockHeight("confirmed");
  return {
    raw: tx.serialize(),
    signature: bs58.encode(tx.signatures[0]),
    blockhash: tx.message.recentBlockhash,
    // PumpPortal fetched the blockhash moments ago; it expires ~150 blocks after that
    lastValidBlockHeight: height + BLOCKHASH_VALIDITY,
  };
}

export async function sendPreSigned(conn: Connection, built: PreSigned): Promise<string> {
  await conn.sendRawTransaction(built.raw, { skipPreflight: false, maxRetries: 3 });
  const res = await conn.confirmTransaction(
    { signature: built.signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    "confirmed",
  );
  if (res.value.err) throw new Error(`tx ${built.signature} failed: ${JSON.stringify(res.value.err)}`);
  return built.signature;
}

export async function sendIxs(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  return sendPreSigned(conn, await buildSigned(conn, ixs, signers));
}

/** POSTs to PumpPortal's local-transaction API; returns the unsigned tx bytes (no API key needed). */
export async function pumpPortalLocal(body: Record<string, unknown>): Promise<ArrayBuffer> {
  const res = await fetch(PUMPPORTAL_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) {
    throw new Error(`PumpPortal ${body.action} failed (${res.status}): ${await res.text()}`);
  }
  return res.arrayBuffer();
}

export type SigState = "confirmed" | "failed" | "unknown";

/**
 * Where does a signature stand? "unknown" = not seen yet but its blockhash may
 * still land, so the caller must NOT retry yet.
 */
export async function signatureStates(
  conn: Connection,
  items: { signature: string; lastValidBlockHeight?: number }[],
): Promise<Map<string, SigState>> {
  const out = new Map<string, SigState>();
  if (items.length === 0) return out;
  const height = await conn.getBlockHeight("confirmed");
  const sigs = [...new Set(items.map((i) => i.signature))];
  const lvbh = new Map(items.map((i) => [i.signature, i.lastValidBlockHeight]));
  for (let i = 0; i < sigs.length; i += 256) {
    const chunk = sigs.slice(i, i + 256);
    const { value } = await conn.getSignatureStatuses(chunk, { searchTransactionHistory: true });
    chunk.forEach((sig, j) => {
      const st = value[j];
      if (st && st.err) out.set(sig, "failed");
      else if (st && st.confirmationStatus && st.confirmationStatus !== "processed") out.set(sig, "confirmed");
      else {
        // not seen (or only processed): only a dead blockhash proves it never lands
        const last = lvbh.get(sig);
        out.set(sig, last !== undefined && height > last ? "failed" : "unknown");
      }
    });
  }
  return out;
}

// ── Ledger (JSONL, crash-safe resume) ───────────────────────────────────────
export interface LedgerEntry {
  key: string;
  status: "pending" | "sent" | "failed";
  signature?: string;
  lastValidBlockHeight?: number;
  [k: string]: unknown;
}

export class Ledger {
  readonly entries = new Map<string, LedgerEntry>();

  constructor(readonly file: string) {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          this.entries.set(e.key, e); // last write wins
        } catch {
          // a torn final line from a crash mid-append; earlier lines are intact
        }
      }
    }
  }

  write(entry: LedgerEntry): void {
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
      fs.fsyncSync(fd); // must be on disk before the tx is broadcast
    } finally {
      fs.closeSync(fd);
    }
    this.entries.set(entry.key, entry);
  }

  /**
   * Resolves "pending" entries left by a crash or a timed-out confirm by
   * checking their signatures on-chain. Entries whose tx may still land stay
   * pending; returns how many are still undecided.
   */
  async reconcile(conn: Connection): Promise<number> {
    const pending = [...this.entries.values()].filter((e) => e.status === "pending" && e.signature);
    const states = await signatureStates(
      conn,
      pending.map((e) => ({ signature: e.signature!, lastValidBlockHeight: e.lastValidBlockHeight })),
    );
    let undecided = 0;
    for (const e of pending) {
      const st = states.get(e.signature!);
      if (st === "confirmed") this.write({ ...e, status: "sent" });
      else if (st === "failed") this.write({ ...e, status: "failed" });
      else undecided++;
    }
    return undecided;
  }

  isSent(key: string): boolean {
    return this.entries.get(key)?.status === "sent";
  }

  isPending(key: string): boolean {
    return this.entries.get(key)?.status === "pending";
  }
}
