import type { Signal, SignalSource, TokenState } from "../types.js";

/**
 * Composite signal scoring.
 *
 * Each source contributes a weighted share of the 0-100 score; signal
 * strength decays linearly over its useful lifetime so stale signals stop
 * counting. Multiple independent sources firing on the same token (true
 * confluence) is what pushes a token over the buy threshold — a single
 * telegram call or a lone volume spike generally should not.
 */
const WEIGHTS: Record<SignalSource, number> = {
  "smart-wallet-confluence": 40,
  "volume-threshold": 25,
  "telegram-call": 20,
  "pumpfun-scanner": 15,
  "external-caller": 20,
};

const SIGNAL_TTL_MS: Record<SignalSource, number> = {
  "smart-wallet-confluence": 10 * 60_000,
  "volume-threshold": 5 * 60_000,
  "telegram-call": 15 * 60_000,
  "pumpfun-scanner": 5 * 60_000,
  "external-caller": 15 * 60_000,
};

function decayedStrength(signal: Signal, now: number): number {
  const ttl = SIGNAL_TTL_MS[signal.source];
  const age = now - signal.at;
  if (age >= ttl) return 0;
  return signal.strength * (1 - age / ttl);
}

export interface ScoreResult {
  score: number;
  sources: SignalSource[];
  breakdown: Record<string, number>;
}

export function scoreToken(token: TokenState, now = Date.now()): ScoreResult {
  // best live signal per source
  const bestPerSource = new Map<SignalSource, number>();
  for (const signal of token.signals) {
    const s = decayedStrength(signal, now);
    if (s <= 0) continue;
    bestPerSource.set(signal.source, Math.max(bestPerSource.get(signal.source) ?? 0, s));
  }

  let score = 0;
  const breakdown: Record<string, number> = {};
  for (const [source, strength] of bestPerSource) {
    const contribution = (strength / 100) * WEIGHTS[source];
    score += contribution;
    breakdown[source] = Math.round(contribution);
  }

  // confluence bonus: 2+ independent sources agreeing is the core thesis
  if (bestPerSource.size >= 2) {
    const bonus = (bestPerSource.size - 1) * 8;
    score += bonus;
    breakdown["confluence-bonus"] = bonus;
  }

  return {
    score: Math.min(100, Math.round(score)),
    sources: [...bestPerSource.keys()],
    breakdown,
  };
}
