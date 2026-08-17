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

export function getKeypair(): Keypair | null {
  if (keypair !== undefined) return keypair;
  const secret = config.chain.walletSecretKey;
  if (!secret) {
    keypair = null;
    return keypair;
  }
  try {
    const bytes = secret.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(secret) as number[])
      : bs58.decode(secret.trim());
    keypair = Keypair.fromSecretKey(bytes);
    log.info("wallet", `operator wallet loaded: ${keypair.publicKey.toBase58()}`);
  } catch (err) {
    log.error("wallet", "failed to parse WALLET_SECRET_KEY", err);
    keypair = null;
  }
  return keypair;
}

export function walletConfigured(): boolean {
  return getKeypair() !== null;
}
