/**
 * Client for the agent's read-only JSON API (src/server/api.ts).
 * Same origin in production (the agent serves this export). For `next dev`
 * against a running agent, set NEXT_PUBLIC_API_BASE=http://localhost:3000.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export interface Treasury {
  tradingSol: number;
  pendingBuybackSol: number;
  pendingAirdropSol: number;
  totalCreatorFeesSol: number;
  totalTradingProfitSol: number;
  totalCalloutProfitSol: number;
  totalBuybackSol: number;
  totalXeroBurned: number;
  totalAirdropSol: number;
  inFlightBuybackSol?: number;
  inFlightAirdropSol?: number;
  totalAutoClaimedSol?: number;
  claimableSol?: number | null;
  claimableAt?: number | null;
}

export interface Stats {
  mode: "paper" | "live";
  halted: boolean;
  solUsd: number | null;
  treasury: Treasury;
  openPositions: number;
  closedPositions: number;
  winRate: number | null;
  totalBurnEvents: number;
  liveCallouts: number;
  airdropMode?: "linear" | "random" | "equal";
  seatsGated?: boolean;
  autoClaim?: "live" | "read-only" | "off";
  activeBuyback?: { id: string; sol: number; startedAt: number } | null;
  activeAirdrop?: { id: string; sol: number; startedAt: number; paid: number; total: number; mode?: string; slot?: number } | null;
  serverTime?: number;
}

export interface Position {
  id: string;
  mint: string;
  symbol?: string;
  openedAt: number;
  entryMcUsd: number;
  peakMcUsd: number;
  solIn: number;
  status: "open" | "closed";
  realizedPnlSol?: number;
  sources: string[];
  score: number;
  paper: boolean;
}

export interface Trade {
  id: string;
  at: number;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  sol: number;
  mcUsd?: number;
  reason: string;
  txSignature?: string;
  paper: boolean;
}

export interface Burn {
  id: string;
  at: number;
  solSpent: number;
  xeroBought: number;
  xeroBurned: number;
  buyTx?: string;
  burnTx?: string;
  fundedBy: string;
  paper: boolean;
}

export interface Drop {
  id: string;
  at: number;
  totalSol: number;
  mode: string;
  recipientCount: number;
  recipients: { wallet: string; sol: number }[];
  txs: string[];
  slot?: number;
  seated?: boolean;
  fundedBy: string;
  paper: boolean;
}

export interface Claim {
  id: string;
  at: number;
  sol: number;
  source: "auto" | "manual";
  signature?: string;
  paper: boolean;
}

export interface Links {
  buyUrl: string | null;
  xHandle: string | null;
  telegramUrl: string | null;
  mint: string | null;
}

export interface LiveData {
  stats: Stats;
  positions: Position[];
  trades: Trade[];
  burns: Burn[];
  airdrops: Drop[];
  claims: Claim[];
  links: Links;
}

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function fetchLive(): Promise<LiveData | null> {
  const stats = await get<Stats | null>("/api/stats", null);
  if (!stats) return null;
  const [positions, trades, burns, airdrops, claims, links] = await Promise.all([
    get<Position[]>("/api/positions", []),
    get<Trade[]>("/api/trades", []),
    get<Burn[]>("/api/burns", []),
    get<Drop[]>("/api/airdrops", []),
    get<Claim[]>("/api/claims", []),
    get<Links>("/api/links", { buyUrl: null, xHandle: null, telegramUrl: null, mint: null }),
  ]);
  return { stats, positions, trades, burns, airdrops, claims, links };
}

export const fmtSol = (n: number | null | undefined, d = 3) => (n == null ? "—" : `${n.toFixed(d)}`);
export const fmtUsd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
export const short = (s: string, a = 4, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const hhmm = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export const isRealSig = (s?: string) => !!s && !s.startsWith("paper-") && s.length > 60;
