import { config } from "./config.js";
import { risk } from "./engine/risk.js";
import { Trader } from "./engine/trader.js";
import { startSolPriceFeed } from "./market/solPrice.js";
import { startServer } from "./server/api.js";
import { CalloutTracker } from "./social/callouts.js";
import { EngagementLoop } from "./social/engage.js";
import { persona } from "./social/persona.js";
import { postTweet } from "./social/x.js";
import { PumpFunScanner } from "./signals/pumpfun.js";
import { SmartWalletWatcher } from "./signals/smartWallets.js";
import { TelegramIngest } from "./signals/telegram.js";
import { startVolumeDetector } from "./signals/volume.js";
import { db } from "./store/db.js";
import { BuybackEngine } from "./treasury/buyback.js";
import { treasury } from "./treasury/treasury.js";
import { log } from "./util/logger.js";

log.info("xero", "─".repeat(60));
log.info("xero", `AGENT XERO starting — mode: ${config.paperTrading ? "PAPER (simulated fills, no real transactions)" : "⚡ LIVE"}`);
log.info("xero", "─".repeat(60));

// market data
startSolPriceFeed();

// signal sources
const pumpfun = new PumpFunScanner();
const smartWallets = new SmartWalletWatcher();
startVolumeDetector();

// engine
const trader = new Trader();
const callouts = new CalloutTracker();
const buyback = new BuybackEngine();

// wire trader -> treasury / callouts / social
trader.on("entry", (position) => {
  void (async () => {
    const text = await persona.entryPost(position);
    const postId = await postTweet(text);
    callouts.open(position, postId);
  })();
});

trader.on("target-hit", (position) => {
  void (async () => {
    const text = await persona.targetHitPost(position);
    await postTweet(text);
  })();
});

trader.on("exit", (position) => {
  treasury.onPositionClosed(position);
  callouts.settle(position.mint);
});

buyback.onBurn = (event) => {
  void (async () => {
    const text = await persona.burnPost(event);
    await postTweet(text);
  })();
};

// telegram (signals + admin)
const telegram = new TelegramIngest({
  getStatus: () => {
    const open = db.positions.filter((p) => p.status === "open");
    return [
      `mode: ${config.paperTrading ? "paper" : "LIVE"}${risk.halted ? " (HALTED)" : ""}`,
      `treasury: ${db.treasury.tradingSol.toFixed(3)} SOL trading, ${db.treasury.pendingBuybackSol.toFixed(3)} SOL pending buyback`,
      `open positions: ${open.length}`,
      `pnl today: ${risk.realizedPnlToday().toFixed(3)} SOL`,
      `lifetime: ${db.treasury.totalBuybackSol.toFixed(2)} SOL bought back, ${Math.round(db.treasury.totalXeroBurned).toLocaleString()} XERO burned`,
    ].join("\n");
  },
  halt: () => risk.halt(),
  resume: () => risk.resume(),
  recordCreatorFees: (sol) => treasury.recordCreatorFees(sol),
  recordDeposit: (sol) => treasury.recordDeposit(sol),
});

// engagement (mentions, aixbt & friends)
const engage = new EngagementLoop();

// go
pumpfun.start();
smartWallets.start();
trader.start();
callouts.start();
buyback.start();
telegram.start();
engage.start();
startServer(callouts);

// seed paper treasury so the engine can trade out of the box
if (config.paperTrading && db.treasury.tradingSol === 0) {
  treasury.recordDeposit(10);
  log.info("xero", "seeded paper treasury with 10 SOL");
}
