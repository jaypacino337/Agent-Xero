import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency). Real env vars always win.
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (key: string, fallback = ""): string => process.env[key] ?? fallback;
const bool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};
const list = (key: string): string[] =>
  str(key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Aggressiveness presets scale how often Xero pulls the trigger.
 *  - chill: fewer, higher-conviction trades
 *  - normal: defaults
 *  - degen: "trade a lot" — lower score bar, lower volume thresholds, more slots
 * Explicit env values always beat the preset.
 */
const AGGRESSIVENESS = (str("AGGRESSIVENESS", "normal").toLowerCase() as
  | "chill"
  | "normal"
  | "degen");
const PRESETS = {
  chill: { minScore: 70, maxPositions: 3, volumeMult: 1.5, buyersMult: 1.25 },
  normal: { minScore: 55, maxPositions: 6, volumeMult: 1, buyersMult: 1 },
  degen: { minScore: 42, maxPositions: 10, volumeMult: 0.6, buyersMult: 0.6 },
} as const;
const preset = PRESETS[AGGRESSIVENESS] ?? PRESETS.normal;

export const config = {
  paperTrading: bool("PAPER_TRADING", true),
  aggressiveness: AGGRESSIVENESS in PRESETS ? AGGRESSIVENESS : "normal",

  trading: {
    solPerTrade: num("SOL_PER_TRADE", 0.25),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", preset.maxPositions),
    dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 2.0),
    entryMaxMcUsd: num("ENTRY_MAX_MC_USD", 10_000),
    targetMcUsd: num("TARGET_MC_USD", 100_000),
    takeProfitSellPct: num("TAKE_PROFIT_SELL_PCT", 60),
    stopLossPct: num("STOP_LOSS_PCT", 45),
    trailingStopPct: num("TRAILING_STOP_PCT", 30),
    minScoreToBuy: num("MIN_SCORE_TO_BUY", preset.minScore),
  },

  smartWallets: {
    wallets: list("SMART_WALLETS"),
    confluenceMin: num("CONFLUENCE_MIN_WALLETS", 2),
    windowSec: num("CONFLUENCE_WINDOW_SEC", 300),
  },

  volume: {
    thresholdSol: num("VOLUME_THRESHOLD_SOL", Math.round(40 * preset.volumeMult)),
    windowSec: num("VOLUME_WINDOW_SEC", 120),
    minUniqueBuyers: num("MIN_UNIQUE_BUYERS", Math.round(25 * preset.buyersMult)),
  },

  telegram: {
    botToken: str("TELEGRAM_BOT_TOKEN"),
    allowedChats: list("TELEGRAM_ALLOWED_CHATS"),
    adminIds: list("TELEGRAM_ADMIN_IDS"),
  },

  execution: {
    pumpPortalApiKey: str("PUMPPORTAL_API_KEY"),
    walletPublicKey: str("WALLET_PUBLIC_KEY"),
    priorityFeeSol: num("PRIORITY_FEE_SOL", 0.0005),
    slippagePct: num("SLIPPAGE_PCT", 15),
  },

  xero: {
    mint: str("XERO_MINT"),
    buybackProfitPct: num("BUYBACK_PROFIT_PCT", 70),
    buybackMinSol: num("BUYBACK_MIN_SOL", 0.1),
    burnAddress: str("BURN_ADDRESS", "1nc1nerator11111111111111111111111111111111"),
  },

  airdrop: {
    enabled: bool("AIRDROP_ENABLED", true),
    /** % of realized trading profit routed to the holder airdrop pool */
    profitPct: num("AIRDROP_PROFIT_PCT", 30),
    /** % of callout rewards routed to the airdrop pool (rest -> buyback) */
    calloutRewardsPct: num("CALLOUT_REWARDS_AIRDROP_PCT", 100),
    /** minimum accumulated SOL before an airdrop executes */
    minSol: num("AIRDROP_MIN_SOL", 0.5),
    /** "linear" = pro-rata by holdings; "random" = holdings-weighted lottery */
    mode: (str("AIRDROP_MODE", "random") === "linear" ? "linear" : "random") as
      | "linear"
      | "random",
    /** random mode: number of winners splitting the pool equally */
    randomWinners: num("AIRDROP_RANDOM_WINNERS", 10),
    /** ignore dust wallets below this share of supply (e.g. 0.05 = 0.05%) */
    minHoldingPct: num("AIRDROP_MIN_HOLDING_PCT", 0.05),
    /** wallets never eligible (LPs, exchange wallets, team) — comma separated */
    exclude: list("AIRDROP_EXCLUDE"),
    maxRecipientsPerDrop: num("AIRDROP_MAX_RECIPIENTS", 200),
  },

  chain: {
    rpcUrl: str("RPC_URL", "https://api.mainnet-beta.solana.com"),
    heliusApiKey: str("HELIUS_API_KEY"),
    /** base58 or JSON-array secret key of the operator wallet (burns + airdrops) */
    walletSecretKey: str("WALLET_SECRET_KEY"),
  },

  x: {
    enabled: bool("X_ENABLED", false),
    apiKey: str("X_API_KEY"),
    apiSecret: str("X_API_SECRET"),
    accessToken: str("X_ACCESS_TOKEN"),
    accessSecret: str("X_ACCESS_SECRET"),
    userId: str("X_USER_ID"),
    engageHandles: list("X_ENGAGE_HANDLES"),
    mentionPollSec: num("X_MENTION_POLL_SEC", 120),
    maxPostsPerHour: num("MAX_POSTS_PER_HOUR", 8),
  },

  persona: {
    anthropicApiKey: str("ANTHROPIC_API_KEY"),
    model: str("PERSONA_MODEL", "claude-fable-5"),
  },

  server: {
    port: num("PORT", 3000),
    /** if set, admin endpoints accept `Authorization: Bearer <token>` from anywhere */
    adminToken: str("ADMIN_TOKEN"),
  },
} as const;

export type Config = typeof config;
