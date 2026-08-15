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

export const config = {
  paperTrading: bool("PAPER_TRADING", true),

  trading: {
    solPerTrade: num("SOL_PER_TRADE", 0.25),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 6),
    dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 2.0),
    entryMaxMcUsd: num("ENTRY_MAX_MC_USD", 10_000),
    targetMcUsd: num("TARGET_MC_USD", 100_000),
    takeProfitSellPct: num("TAKE_PROFIT_SELL_PCT", 60),
    stopLossPct: num("STOP_LOSS_PCT", 45),
    trailingStopPct: num("TRAILING_STOP_PCT", 30),
    minScoreToBuy: num("MIN_SCORE_TO_BUY", 55),
  },

  smartWallets: {
    wallets: list("SMART_WALLETS"),
    confluenceMin: num("CONFLUENCE_MIN_WALLETS", 2),
    windowSec: num("CONFLUENCE_WINDOW_SEC", 300),
  },

  volume: {
    thresholdSol: num("VOLUME_THRESHOLD_SOL", 40),
    windowSec: num("VOLUME_WINDOW_SEC", 120),
    minUniqueBuyers: num("MIN_UNIQUE_BUYERS", 25),
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
    buybackProfitPct: num("BUYBACK_PROFIT_PCT", 100),
    buybackMinSol: num("BUYBACK_MIN_SOL", 0.1),
    burnAddress: str("BURN_ADDRESS", "1nc1nerator11111111111111111111111111111111"),
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
