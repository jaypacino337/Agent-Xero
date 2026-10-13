/**
 * In-memory stand-in for the slice of `Connection` the treasury uses.
 * Real transactions are built, signed and serialized by the code under test;
 * this decodes them and applies SOL transfers, burnChecked and a fake
 * PumpPortal "buy" to its own balances. Nothing touches a network.
 *
 * Per-send behaviour lets tests simulate the failure modes that matter for
 * double-spends: landed-but-confirm-timed-out, dropped, rejected.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

export const FAKE_BUY_PROGRAM = new PublicKey("Buy1111111111111111111111111111111111111111");

export type SendBehaviour =
  /** lands and confirms */
  | "land"
  /** lands on-chain, but our confirm call times out (crash/timeout after broadcast) */
  | "land-timeout"
  /** never lands; confirm times out */
  | "drop"
  /** rejected at preflight */
  | "reject";

interface Meta {
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } }[];
  postTokenBalances: { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } }[];
}

export class FakeChain {
  height = 1_000;
  lamports = new Map<string, bigint>();
  tokens = new Map<string, bigint>(); // ata → raw
  mints = new Map<string, { programId: PublicKey; decimals: number }>();
  landed = new Map<string, { err: unknown }>();
  metas = new Map<string, Meta>();
  /** every landed SOL transfer: [to, lamports] */
  transfers: { to: string; lamports: bigint; sig: string }[] = [];
  burns: { ata: string; amount: bigint; programId: string; sig: string }[] = [];
  sends = 0;
  /** behaviours for the next sends, in order; default "land" */
  plan: SendBehaviour[] = [];
  /** makes getSignatureStatuses report nothing for these (indexing lag) */
  hidden = new Set<string>();
  /** fake buy: called when a tx with FAKE_BUY_PROGRAM lands */
  onBuy?: (sig: string) => void;

  get conn(): Connection {
    return this as unknown as Connection;
  }

  addMint(mint: PublicKey, programId = TOKEN_PROGRAM_ID, decimals = 6) {
    this.mints.set(mint.toBase58(), { programId, decimals });
  }

  // ── Connection surface ────────────────────────────────────────────────
  rpcEndpoint = "http://fake";

  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: this.height + 150 };
  }
  async getBlockHeight() {
    return this.height;
  }
  async getSlot() {
    return 123_456;
  }
  async getBalance(pk: PublicKey) {
    return Number(this.lamports.get(pk.toBase58()) ?? 0n);
  }
  async getMinimumBalanceForRentExemption() {
    return 890_880;
  }
  async getMultipleAccountsInfo(pks: PublicKey[]) {
    return pks.map((pk) => (this.lamports.has(pk.toBase58()) ? { lamports: 1 } : null));
  }
  async getAccountInfo(pk: PublicKey) {
    const m = this.mints.get(pk.toBase58());
    if (!m) return null;
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 1_000_000_000_000_000n,
        decimals: m.decimals,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      data,
    );
    return { owner: m.programId, data, lamports: 1, executable: false, rentEpoch: 0 };
  }
  async getTokenAccountBalance(ata: PublicKey) {
    const amount = this.tokens.get(ata.toBase58());
    if (amount === undefined) throw new Error("could not find account");
    return { value: { amount: amount.toString(), decimals: 6, uiAmount: null } };
  }
  async getSignatureStatuses(sigs: string[]) {
    return {
      value: sigs.map((s) => {
        const l = this.landed.get(s);
        if (!l || this.hidden.has(s)) return null;
        return { slot: 1, confirmations: null, err: l.err, confirmationStatus: "confirmed" as const };
      }),
    };
  }
  async getTransaction(sig: string) {
    const meta = this.metas.get(sig);
    return meta && !this.hidden.has(sig) ? { meta } : null;
  }
  async confirmTransaction(args: { signature: string }) {
    const last = this.lastBehaviour.get(args.signature);
    if (last === "land-timeout" || last === "drop") throw new Error("block height exceeded (simulated)");
    return { value: { err: null } };
  }
  private lastBehaviour = new Map<string, SendBehaviour>();

  async sendRawTransaction(raw: Uint8Array) {
    this.sends++;
    const tx = VersionedTransaction.deserialize(raw);
    const sig = bs58.encode(tx.signatures[0]);
    const behaviour = this.plan.shift() ?? "land";
    this.lastBehaviour.set(sig, behaviour);
    if (behaviour === "reject") throw new Error("preflight failed (simulated)");
    if (behaviour === "drop") return sig;
    if (this.landed.has(sig)) return sig; // same signature can only land once
    this.apply(tx, sig);
    this.landed.set(sig, { err: null });
    return sig;
  }

  private apply(tx: VersionedTransaction, sig: string) {
    const keys = tx.message.staticAccountKeys;
    const payer = keys[0].toBase58();
    const pre = this.lamports.get(payer) ?? 0n;
    this.lamports.set(payer, pre - 5_000n);
    for (const ix of tx.message.compiledInstructions) {
      const program = keys[ix.programIdIndex];
      const data = Buffer.from(ix.data);
      if (program.equals(SystemProgram.programId) && data.readUInt32LE(0) === 2) {
        const from = keys[ix.accountKeyIndexes[0]].toBase58();
        const to = keys[ix.accountKeyIndexes[1]].toBase58();
        const amount = data.readBigUInt64LE(4);
        const bal = this.lamports.get(from) ?? 0n;
        if (bal < amount) throw new Error("insufficient lamports (simulated)");
        this.lamports.set(from, bal - amount);
        this.lamports.set(to, (this.lamports.get(to) ?? 0n) + amount);
        this.transfers.push({ to, lamports: amount, sig });
      } else if ((program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) && data[0] === 15) {
        const ata = keys[ix.accountKeyIndexes[0]].toBase58();
        const amount = data.readBigUInt64LE(1);
        const bal = this.tokens.get(ata) ?? 0n;
        if (bal < amount) throw new Error("insufficient tokens (simulated)");
        this.tokens.set(ata, bal - amount);
        this.burns.push({ ata, amount, programId: program.toBase58(), sig });
      } else if (program.equals(FAKE_BUY_PROGRAM)) {
        this.onBuy?.(sig);
      }
    }
    this.metas.set(sig, this.metas.get(sig) ?? {
      preBalances: [Number(pre)],
      postBalances: [Number(this.lamports.get(payer) ?? 0n)],
      preTokenBalances: [],
      postTokenBalances: [],
    });
  }
}

/** A serialized, unsigned v0 tx like PumpPortal trade-local returns. */
export function fakePumpPortalTx(payer: PublicKey): ArrayBuffer {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: FAKE_BUY_PROGRAM, keys: [], data: Buffer.from([Math.random() * 255])})],
  }).compileToV0Message();
  const bytes = new VersionedTransaction(msg).serialize();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Routes PumpPortal trade-local calls to `fakePumpPortalTx`; counts calls. */
export function mockPumpPortal(payer: PublicKey) {
  const calls: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("pumpportal.fun/api/trade-local")) {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(fakePumpPortalTx(payer), { status: 200 });
    }
    throw new Error(`unexpected network call in test: ${String(url)}`);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
