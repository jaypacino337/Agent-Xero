import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../config.js";
import { log } from "../util/logger.js";
import { getConnection } from "./wallet.js";

export interface Holder {
  owner: string;
  /** raw token amount (ui amount, decimals applied) */
  amount: number;
}

/**
 * Snapshot current $XERO holders.
 * Prefers the Helius getTokenAccounts API (fast, paginated); falls back to a
 * raw getParsedProgramAccounts scan on the configured RPC.
 * Dust wallets, the burn address and configured exclusions are filtered out.
 */
export async function snapshotHolders(mint: string): Promise<Holder[]> {
  const raw = config.chain.heliusApiKey
    ? await viaHelius(mint)
    : await viaRpc(mint);

  const byOwner = new Map<string, number>();
  for (const h of raw) {
    if (h.amount <= 0) continue;
    byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + h.amount);
  }

  const excluded = new Set([config.xero.burnAddress, ...config.airdrop.exclude]);
  const total = [...byOwner.values()].reduce((s, a) => s + a, 0);
  const minAmount = total * (config.airdrop.minHoldingPct / 100);

  const holders = [...byOwner.entries()]
    .filter(([owner, amount]) => !excluded.has(owner) && amount >= minAmount)
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount);

  log.info(
    "holders",
    `snapshot: ${holders.length} eligible holders (of ${byOwner.size} total, ≥${config.airdrop.minHoldingPct}% supply)`,
  );
  return holders;
}

async function viaHelius(mint: string): Promise<Holder[]> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${config.chain.heliusApiKey}`;
  const holders: Holder[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "xero",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      result?: {
        token_accounts?: { owner: string; amount: number; decimals?: number }[];
        cursor?: string;
      };
    };
    const accounts = json.result?.token_accounts ?? [];
    for (const a of accounts) {
      const decimals = a.decimals ?? 6;
      holders.push({ owner: a.owner, amount: a.amount / 10 ** decimals });
    }
    cursor = json.result?.cursor;
    if (!cursor || accounts.length === 0) break;
  }
  return holders;
}

async function viaRpc(mint: string): Promise<Holder[]> {
  const conn = getConnection();
  const accounts = await conn.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: new PublicKey(mint).toBase58() } },
    ],
  });
  return accounts.map((a) => {
    const info = (a.account.data as { parsed: { info: { owner: string; tokenAmount: { uiAmount: number | null } } } }).parsed.info;
    return { owner: info.owner, amount: info.tokenAmount.uiAmount ?? 0 };
  });
}
