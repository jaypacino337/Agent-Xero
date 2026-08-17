export type SignalSource =
  | "smart-wallet-confluence"
  | "volume-threshold"
  | "telegram-call"
  | "pumpfun-scanner"
  | "external-caller";

export interface Signal {
  id: string;
  source: SignalSource;
  mint: string;
  symbol?: string;
  name?: string;
  at: number; // epoch ms
  /** 0-100 how strong this individual signal is */
  strength: number;
  detail: string;
  /** market cap in USD at signal time, if known */
  mcUsd?: number;
}

export interface TokenState {
  mint: string;
  symbol?: string;
  name?: string;
  createdAt?: number;
  mcUsd?: number;
  priceSol?: number;
  /** rolling buy volume window */
  buys: { at: number; sol: number; buyer: string }[];
  smartWalletBuys: { wallet: string; at: number; sol: number }[];
  signals: Signal[];
  lastScored?: number;
}

export interface Position {
  id: string;
  mint: string;
  symbol?: string;
  openedAt: number;
  entryMcUsd: number;
  entryPriceSol: number;
  solIn: number;
  tokenAmount: number;
  /** remaining tokens after partial exits */
  tokensRemaining: number;
  peakMcUsd: number;
  targetHit: boolean;
  status: "open" | "closed";
  closedAt?: number;
  solOut: number;
  realizedPnlSol?: number;
  exitReason?: string;
  sources: SignalSource[];
  score: number;
  paper: boolean;
}

export interface TradeEvent {
  id: string;
  at: number;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  sol: number;
  tokenAmount: number;
  mcUsd?: number;
  reason: string;
  txSignature?: string;
  paper: boolean;
}

export interface BurnEvent {
  id: string;
  at: number;
  solSpent: number;
  xeroBought: number;
  xeroBurned: number;
  buyTx?: string;
  burnTx?: string;
  fundedBy: "trading-profit" | "creator-fees" | "callout-profit";
  paper: boolean;
}

export interface Callout {
  id: string;
  at: number;
  mint: string;
  symbol?: string;
  entryMcUsd: number;
  peakMcUsd: number;
  /** multiple on entry mc at peak, e.g. 10 = 10x */
  peakMultiple: number;
  postId?: string;
  status: "live" | "settled";
  profitSol?: number;
}

export interface AirdropEvent {
  id: string;
  at: number;
  totalSol: number;
  mode: "linear" | "random";
  recipientCount: number;
  /** top recipients stored for the site (full list in tx history) */
  recipients: { wallet: string; sol: number }[];
  txs: string[];
  fundedBy: "callout-rewards" | "trading-profit" | "creator-fees";
  paper: boolean;
}

export interface TreasuryState {
  /** SOL available to trade */
  tradingSol: number;
  /** SOL accumulated and earmarked for the next buyback */
  pendingBuybackSol: number;
  /** SOL accumulated and earmarked for the next holder airdrop */
  pendingAirdropSol: number;
  /** lifetime totals, for the site */
  totalCreatorFeesSol: number;
  totalTradingProfitSol: number;
  totalCalloutProfitSol: number;
  totalBuybackSol: number;
  totalXeroBurned: number;
  totalAirdropSol: number;
}
