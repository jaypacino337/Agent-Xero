import fs from "node:fs";
import path from "node:path";
import type {
  AirdropEvent,
  BurnEvent,
  Callout,
  ClaimEvent,
  Position,
  TradeEvent,
  TreasuryState,
} from "../types.js";
import { log } from "../util/logger.js";

// DATA_DIR env overrides (Railway: attach a volume and set DATA_DIR=/data)
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));

interface DbShape {
  treasury: TreasuryState;
  positions: Position[];
  trades: TradeEvent[];
  burns: BurnEvent[];
  callouts: Callout[];
  airdrops: AirdropEvent[];
  claims: ClaimEvent[];
  /** jobs that must survive a restart: the buyback/airdrop currently executing */
  jobs: {
    buyback?: { id: string; sol: number; startedAt: number };
    airdrop?: { id: string; sol: number; startedAt: number };
  };
}

/** crash-safe ledgers + frozen airdrop plans live next to the JSON collections */
export const LEDGER_DIR = path.join(DATA_DIR, "ledgers");

const defaults: DbShape = {
  treasury: {
    tradingSol: 0,
    pendingBuybackSol: 0,
    pendingAirdropSol: 0,
    totalCreatorFeesSol: 0,
    totalTradingProfitSol: 0,
    totalCalloutProfitSol: 0,
    totalBuybackSol: 0,
    totalXeroBurned: 0,
    totalAirdropSol: 0,
    inFlightBuybackSol: 0,
    inFlightAirdropSol: 0,
    totalAutoClaimedSol: 0,
    claimableSol: null,
    claimableAt: null,
  },
  positions: [],
  trades: [],
  burns: [],
  callouts: [],
  airdrops: [],
  claims: [],
  jobs: {},
};

/**
 * Simple JSON-file persistence. One file per collection under ./data.
 * Writes are debounced so hot paths (trade streams) don't thrash disk.
 */
class Db {
  private state: DbShape;
  private dirty = new Set<keyof DbShape>();
  private flushTimer?: NodeJS.Timeout;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.state = structuredClone(defaults);
    for (const key of Object.keys(defaults) as (keyof DbShape)[]) {
      const file = this.fileFor(key);
      if (fs.existsSync(file)) {
        try {
          (this.state as unknown as Record<string, unknown>)[key] = JSON.parse(
            fs.readFileSync(file, "utf8"),
          );
        } catch (err) {
          log.warn("db", `failed to parse ${file}, starting fresh`, err);
        }
      }
    }
    // migrate: fill in any treasury fields added after the ledger was created
    this.state.treasury = { ...defaults.treasury, ...this.state.treasury };
  }

  private fileFor(key: keyof DbShape) {
    return path.join(DATA_DIR, `${key}.json`);
  }

  get treasury() {
    return this.state.treasury;
  }
  get positions() {
    return this.state.positions;
  }
  get trades() {
    return this.state.trades;
  }
  get burns() {
    return this.state.burns;
  }
  get callouts() {
    return this.state.callouts;
  }
  get airdrops() {
    return this.state.airdrops;
  }
  get claims() {
    return this.state.claims;
  }
  get jobs() {
    return this.state.jobs;
  }

  markDirty(...keys: (keyof DbShape)[]) {
    for (const k of keys) this.dirty.add(k);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 1000);
    }
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const key of this.dirty) {
      const file = this.fileFor(key);
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fd, JSON.stringify(this.state[key], null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
    this.dirty.clear();
  }

  /**
   * Mark + write to disk immediately. Used before any broadcast that spends
   * pooled SOL, so a crash can never leave the pool un-decremented.
   */
  commit(...keys: (keyof DbShape)[]) {
    this.markDirty(...keys);
    this.flush();
  }
}

export const db = new Db();

process.on("exit", () => db.flush());
process.on("SIGINT", () => {
  db.flush();
  process.exit(0);
});
process.on("SIGTERM", () => {
  db.flush();
  process.exit(0);
});
