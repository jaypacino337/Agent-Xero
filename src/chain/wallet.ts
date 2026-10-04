import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../util/logger.js";

/**
 * Operator wallet + RPC connection for on-chain actions the trading API
 * can't do: burning bought-back $XERO and sending holder airdrops.
 *
 * WALLET_SECRET_KEY accepts base58 (what PumpPortal hands you when creating
 * a lightning wallet) or a JSON byte array (solana-keygen format).
 */
let connection: Connection | undefined;
let keypair: Keypair | null | undefined;

export function getConnection(): Connection {
  connection ??= new Connection(config.chain.rpcUrl, "confirmed");
  return connection;
}

/** Tests / simulations only: route every on-chain call to a stand-in. */
export function setConnection(conn: Connection): void {
  connection = conn;
}

function parseSecret(secret: string, label: string): Keypair | null {
  if (!secret) return null;
  try {
    const bytes = secret.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(secret) as number[])
      : bs58.decode(secret.trim());
    const kp = Keypair.fromSecretKey(bytes);
    log.info("wallet", `${label} wallet loaded: ${kp.publicKey.toBase58()}`);
    return kp;
  } catch {
    // never echo the secret or the parse error (it can contain key bytes)
    log.error("wallet", `failed to parse the ${label} secret key`);
    return null;
  }
}

export function getKeypair(): Keypair | null {
  if (keypair !== undefined) return keypair;
  keypair = parseSecret(config.chain.walletSecretKey, "operator");
  return keypair;
}

let creatorKeypair: Keypair | null | undefined;

/** Creator wallet for fee claims: CREATOR_SECRET_KEY, else the operator wallet. */
export function getCreatorKeypair(): Keypair | null {
  if (creatorKeypair !== undefined) return creatorKeypair;
  creatorKeypair = config.claims.creatorSecretKey
    ? parseSecret(config.claims.creatorSecretKey, "creator")
    : getKeypair();
  return creatorKeypair;
}

export function walletConfigured(): boolean {
  return getKeypair() !== null;
}
