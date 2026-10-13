/**
 * THE file to edit for the dashboard's copy. Live numbers come from the
 * agent's API (/api/*); links (buy, X, telegram, CA) come from /api/links so
 * they follow the agent's env without a rebuild.
 */
export const site = {
  name: "Agent Xero",
  ticker: "XERO",
  tagline: "autonomous pump.fun trading agent. profits buy back and burn $XERO and drop SOL to holders.",
  description:
    "Live terminal for Agent Xero: treasury, trades, buyback-and-burns, holder airdrops and creator-fee claims, straight from the agent's ledger.",
  url: "https://agent-xero.up.railway.app",
  /** poll interval for /api/* (ms) */
  pollMs: 4000,
  explorer: "https://solscan.io/tx/",
  guarantees: [
    { k: "burn = bought", v: "each buyback burns exactly the tokens that buy delivered (balance delta, capped by the tx's own delta). never the wallet's balance." },
    { k: "burnChecked", v: "SPL burn with the detected token program (SPL or Token-2022). supply really drops; no incinerator transfer." },
    { k: "frozen plans", v: "every airdrop is frozen to disk with its snapshot slot (the lottery seed) before a single lamport moves." },
    { k: "sig before send", v: "every batch signature is fsync'd to a ledger before broadcast. restarts reconcile on-chain: nobody is paid twice." },
    { k: "rent-aware", v: "brand-new wallets that would get less than rent-exemption are dropped and the pot is re-split, so batches never bounce." },
    { k: "auto-claim", v: "creator fees are claimed via PumpPortal and credited from the claim tx itself. manual entry stays as a fallback." },
  ],
} as const;
