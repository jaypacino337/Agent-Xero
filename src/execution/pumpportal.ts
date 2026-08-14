import { config } from "../config.js";
import { log } from "../util/logger.js";

/**
 * Trade execution via the PumpPortal Lightning API.
 *
 * Live mode requires PUMPPORTAL_API_KEY (a lightning wallet linked to that
 * key). While PAPER_TRADING=true nothing here is ever called — the trader
 * simulates fills against live stream prices instead.
 */
export interface ExecResult {
  ok: boolean;
  signature?: string;
  error?: string;
}

export async function executeTrade(params: {
  action: "buy" | "sell";
  mint: string;
  /** for buys: SOL amount; for sells: token amount (or "100%") */
  amount: number | string;
  denominatedInSol: boolean;
  pool?: "auto" | "pump" | "raydium";
}): Promise<ExecResult> {
  if (!config.execution.pumpPortalApiKey) {
    return { ok: false, error: "PUMPPORTAL_API_KEY not configured" };
  }
  try {
    const res = await fetch(
      `https://pumpportal.fun/api/trade?api-key=${config.execution.pumpPortalApiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: params.action,
          mint: params.mint,
          amount: params.amount,
          denominatedInSol: String(params.denominatedInSol),
          slippage: config.execution.slippagePct,
          priorityFee: config.execution.priorityFeeSol,
          pool: params.pool ?? "auto",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const json = (await res.json()) as { signature?: string; errors?: unknown };
    if (!res.ok || !json.signature) {
      log.error("exec", `trade failed`, json);
      return { ok: false, error: JSON.stringify(json) };
    }
    log.info("exec", `${params.action} ${params.mint.slice(0, 8)}… tx ${json.signature}`);
    return { ok: true, signature: json.signature };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
