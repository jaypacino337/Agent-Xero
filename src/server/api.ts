import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { risk } from "../engine/risk.js";
import { getSolUsd } from "../market/solPrice.js";
import { db } from "../store/db.js";
import { treasury } from "../treasury/treasury.js";
import { autoClaimLive } from "../treasury/fees.js";
import { loadPlan, planProgress } from "../treasury/payout.js";
import { LEDGER_DIR } from "../store/db.js";
import { log } from "../util/logger.js";
import type { CalloutTracker } from "../social/callouts.js";
import type { AirdropEngine } from "../treasury/airdrop.js";

/**
 * Serves the dashboard (static Next.js export in dashboard/out, built by
 * `npm run build:dashboard`) and the read-only JSON API it polls.
 * A couple of localhost-only admin endpoints mirror the telegram commands.
 */
const SITE_DIR = path.resolve(process.env.DASHBOARD_DIR ?? path.join(process.cwd(), "dashboard", "out"));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function activeAirdrop() {
  const job = db.jobs.airdrop;
  if (!job) return null;
  const plan = loadPlan(LEDGER_DIR, job.id);
  if (!plan) return { id: job.id, sol: job.sol, startedAt: job.startedAt, paid: 0, total: 0 };
  const p = planProgress(LEDGER_DIR, plan);
  return { id: job.id, sol: job.sol, startedAt: job.startedAt, paid: p.paid, total: p.total, mode: plan.mode, slot: plan.slot };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function isAdmin(req: http.IncomingMessage): boolean {
  // localhost always allowed
  const addr = req.socket.remoteAddress ?? "";
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  // remote deployments (Railway etc.): set ADMIN_TOKEN and send it as a bearer token
  if (config.server.adminToken) {
    const auth = req.headers.authorization ?? "";
    if (auth === `Bearer ${config.server.adminToken}`) return true;
  }
  return false;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function startServer(callouts: CalloutTracker, airdrop?: AirdropEngine): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    try {
      if (p === "/api/links") {
        return json(res, 200, {
          buyUrl:
            config.links.buyUrl ||
            (config.xero.mint ? `https://pump.fun/coin/${config.xero.mint}` : null),
          xHandle: config.links.xHandle || null,
          telegramUrl: config.links.telegramUrl || null,
          mint: config.xero.mint || null,
        });
      }
      if (p === "/api/stats") {
        const openPositions = db.positions.filter((x) => x.status === "open");
        const closed = db.positions.filter((x) => x.status === "closed");
        const wins = closed.filter((x) => (x.realizedPnlSol ?? 0) > 0).length;
        return json(res, 200, {
          mode: config.paperTrading ? "paper" : "live",
          halted: risk.halted,
          solUsd: getSolUsd(),
          treasury: db.treasury,
          openPositions: openPositions.length,
          closedPositions: closed.length,
          winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
          totalBurnEvents: db.burns.length,
          liveCallouts: db.callouts.filter((c) => c.status === "live").length,
          airdropMode: config.airdrop.mode,
          seatsGated: !!config.seats.url,
          autoClaim: config.claims.autoClaim ? (autoClaimLive() ? "live" : "read-only") : "off",
          activeBuyback: db.jobs.buyback ?? null,
          activeAirdrop: activeAirdrop(),
          serverTime: Date.now(),
        });
      }
      if (p === "/api/positions")
        return json(res, 200, [...db.positions].reverse().slice(0, 100));
      if (p === "/api/trades")
        return json(res, 200, [...db.trades].reverse().slice(0, 200));
      if (p === "/api/burns") return json(res, 200, [...db.burns].reverse());
      if (p === "/api/callouts")
        return json(res, 200, [...db.callouts].reverse().slice(0, 100));
      if (p === "/api/airdrops") return json(res, 200, [...db.airdrops].reverse());
      if (p === "/api/claims") return json(res, 200, [...db.claims].reverse().slice(0, 100));
      if (p === "/api/health") return json(res, 200, { ok: true, mode: config.paperTrading ? "paper" : "live" });

      // --- admin (localhost only) ---
      if (p.startsWith("/api/admin/")) {
        if (!isAdmin(req)) return json(res, 403, { error: "unauthorized" });
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        const body = (await readBody(req)) as { sol?: number; force?: boolean };
        const sol = Number(body.sol);
        if (p === "/api/admin/fees" && sol > 0) {
          // manual fallback; auto-claim already credits fees, so don't double count
          if (autoClaimLive() && body.force !== true) {
            return json(res, 409, { error: "auto-claim is live and credits creator fees itself; send force:true to add fees it can't see" });
          }
          treasury.recordCreatorFees(sol, { source: "manual" });
          return json(res, 200, { ok: true, treasury: db.treasury });
        }
        if (p === "/api/admin/deposit" && sol > 0) {
          treasury.recordDeposit(sol);
          return json(res, 200, { ok: true, treasury: db.treasury });
        }
        if (p === "/api/admin/callout-profit" && sol > 0) {
          callouts.recordProfit(sol);
          return json(res, 200, { ok: true, treasury: db.treasury });
        }
        if (p === "/api/admin/airdrop-now") {
          const ok = (await airdrop?.runOnce()) ?? false;
          return json(res, 200, { ok, treasury: db.treasury });
        }
        if (p === "/api/admin/halt") {
          risk.halt();
          return json(res, 200, { ok: true });
        }
        if (p === "/api/admin/resume") {
          risk.resume();
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: "bad request" });
      }

      // --- static site ---
      const rel = decodeURIComponent(p === "/" ? "index.html" : p.slice(1));
      for (const candidate of [rel, `${rel}.html`, path.join(rel, "index.html")]) {
        const file = path.resolve(SITE_DIR, candidate);
        if (file.startsWith(SITE_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, {
            "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
            "cache-control": candidate.startsWith("_next/static/") ? "public, max-age=31536000, immutable" : "no-cache",
          });
          return void res.end(fs.readFileSync(file));
        }
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });
      const notFound = path.join(SITE_DIR, "404.html");
      if (fs.existsSync(notFound)) {
        res.writeHead(404, { "content-type": MIME[".html"] });
        return void res.end(fs.readFileSync(notFound));
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(fs.existsSync(SITE_DIR) ? "not found" : "dashboard not built: run `npm run build:dashboard`");
    } catch (err) {
      log.error("api", "request failed", err);
      json(res, 500, { error: "internal error" });
    }
  });

  server.listen(config.server.port, () => {
    log.info("api", `site + API listening on http://localhost:${config.server.port}`);
  });
}
