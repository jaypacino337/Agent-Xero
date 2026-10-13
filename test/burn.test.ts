/**
 * Buyback-and-burn: burns exactly what the buy delivered (never the wallet's
 * pre-existing balance), with the right token program, and survives a crash
 * between buy and burn without buying twice.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Ledger, tokenDeltaFromMeta } from "../src/chain/solana.js";
import { buybackAndBurn, burnAmount, resumeBuyback, type BuybackJob } from "../src/treasury/burn.js";
import { FakeChain, mockPumpPortal } from "./helpers/fakeChain.js";

const HELD = 1_000_000_000_000n; // tokens the wallet already holds (must never be burned)
const BOUGHT = 250_000_000n;

let dir: string;
let chain: FakeChain;
let wallet: Keypair;
let mint: Keypair;
let pp: ReturnType<typeof mockPumpPortal>;

function setup(programId = TOKEN_PROGRAM_ID, delivered = BOUGHT, strayInflow = 0n) {
  chain = new FakeChain();
  wallet = Keypair.generate();
  mint = Keypair.generate();
  chain.addMint(mint.publicKey, programId);
  chain.lamports.set(wallet.publicKey.toBase58(), 5_000_000_000n);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, programId).toBase58();
  chain.tokens.set(ata, HELD);
  chain.onBuy = (sig) => {
    const before = chain.tokens.get(ata)!;
    chain.tokens.set(ata, before + delivered + strayInflow); // strayInflow = someone else's transfer in the same window
    const tb = (amount: bigint) => [{ accountIndex: 1, mint: mint.publicKey.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: amount.toString() } }];
    chain.metas.set(sig, { preBalances: [0], postBalances: [0], preTokenBalances: tb(before), postTokenBalances: tb(before + delivered) });
  };
  pp = mockPumpPortal(wallet.publicKey);
  return ata;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xero-burn-"));
});
afterEach(() => {
  pp?.restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("burnAmount: delta only, capped by the tx's own delta, never negative", () => {
  assert.equal(burnAmount(100n, 350n, null), 250n);
  assert.equal(burnAmount(100n, 350n, 200n), 200n); // stray inflow can't inflate the burn
  assert.equal(burnAmount(100n, 350n, 900n), 250n); // tx can't exceed the balance growth
  assert.equal(burnAmount(500n, 100n, null), 0n);
});

test("tokenDeltaFromMeta sums only this owner+mint", () => {
  const b = (owner: string, mint: string, amount: number) => ({ accountIndex: 0, owner, mint, uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: null } });
  const meta = {
    preBalances: [],
    postBalances: [],
    preTokenBalances: [b("me", "X", 10), b("pool", "X", 1000)],
    postTokenBalances: [b("me", "X", 60), b("pool", "X", 950), b("me", "Y", 7)],
  };
  assert.equal(tokenDeltaFromMeta(meta as never, "me", "X"), 50n);
  assert.equal(tokenDeltaFromMeta(null, "me", "X"), null);
});

test("burns exactly the bought delta, not the wallet's existing balance (SPL)", async () => {
  const ata = setup(TOKEN_PROGRAM_ID);
  const ledger = new Ledger(path.join(dir, "bb.jsonl"));
  const out = await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger, id: "job1" });
  assert.equal(out.state, "done");
  assert.equal(chain.burns.length, 1);
  assert.equal(chain.burns[0].amount, BOUGHT);
  assert.equal(chain.burns[0].programId, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(chain.tokens.get(ata), HELD, "pre-existing tokens untouched");
  assert.equal(ledger.entries.get("job1")!.status, "sent");
  assert.equal(pp.calls.length, 1);
  assert.equal(pp.calls[0].action, "buy");
});

test("Token-2022 mint: burnChecked goes to the Token-2022 program", async () => {
  const ata = setup(TOKEN_2022_PROGRAM_ID);
  const out = await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger: new Ledger(path.join(dir, "bb.jsonl")), id: "j" });
  assert.equal(out.state, "done");
  assert.equal(chain.burns[0].programId, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(chain.burns[0].amount, BOUGHT);
  assert.equal(chain.tokens.get(ata), HELD);
});

test("a stray inflow during the buy is not burned (tx delta caps it)", async () => {
  const ata = setup(TOKEN_PROGRAM_ID, BOUGHT, 777n);
  await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger: new Ledger(path.join(dir, "bb.jsonl")), id: "j" });
  assert.equal(chain.burns[0].amount, BOUGHT);
  assert.equal(chain.tokens.get(ata), HELD + 777n);
});

test("crash after the buy broadcast: restart burns the bought amount once, never re-buys", async () => {
  const ata = setup();
  const file = path.join(dir, "bb.jsonl");
  chain.plan = ["land-timeout"]; // buy lands, but we never saw the confirmation
  chain.onBuy = ((orig) => (sig: string) => {
    orig!(sig);
    chain.hidden.add(sig); // RPC hasn't indexed it yet
  })(chain.onBuy);
  const first = await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger: new Ledger(file), id: "j" });
  assert.equal(first.state, "waiting");
  assert.equal(chain.burns.length, 0);

  // "restart": fresh ledger object from disk, RPC has caught up
  chain.hidden.clear();
  const ledger = new Ledger(file);
  const job = ledger.entries.get("j") as BuybackJob;
  assert.equal(job.phase, "buy");
  const again = await resumeBuyback(chain.conn, { wallet, ledger, job });
  assert.equal(again.state, "done");
  assert.equal(chain.burns.length, 1);
  assert.equal(chain.burns[0].amount, BOUGHT);
  assert.equal(chain.tokens.get(ata), HELD);
  assert.equal(pp.calls.length, 1, "exactly one buy");

  // resuming a finished job is a no-op
  const third = await resumeBuyback(chain.conn, { wallet, ledger: new Ledger(file), job: new Ledger(file).entries.get("j") as BuybackJob });
  assert.equal(third.state, "done");
  assert.equal(chain.burns.length, 1);
});

test("buy dropped: waits while the blockhash lives, then refunds — no burn, no second buy", async () => {
  setup();
  const file = path.join(dir, "bb.jsonl");
  chain.plan = ["drop"];
  const first = await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger: new Ledger(file), id: "j" });
  assert.equal(first.state, "waiting");
  chain.height += 1_000; // blockhash expired: it can never land now
  const ledger = new Ledger(file);
  const out = await resumeBuyback(chain.conn, { wallet, ledger, job: ledger.entries.get("j") as BuybackJob });
  assert.equal(out.state, "refund");
  assert.equal(chain.burns.length, 0);
  assert.equal(pp.calls.length, 1);
});

test("crash after buy, burn timed out: the pending burn is checked, not repeated", async () => {
  const ata = setup();
  const file = path.join(dir, "bb.jsonl");
  chain.plan = ["land", "land-timeout"]; // buy fine; burn lands but confirm times out
  const first = await buybackAndBurn(chain.conn, { wallet, mint: mint.publicKey, sol: 0.5, ledger: new Ledger(file), id: "j" });
  assert.equal(first.state, "waiting");
  assert.equal(chain.burns.length, 1);
  const ledger = new Ledger(file);
  const out = await resumeBuyback(chain.conn, { wallet, ledger, job: ledger.entries.get("j") as BuybackJob });
  assert.equal(out.state, "done");
  assert.equal(chain.burns.length, 1, "burn not repeated");
  assert.equal(chain.tokens.get(ata), HELD);
});
