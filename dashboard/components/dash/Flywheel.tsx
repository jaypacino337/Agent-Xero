"use client";
import { Reveal } from "@/components/fx";
import type { LiveData } from "@/lib/api";
import { cn } from "@/lib/cn";
import { LiveNumber } from "./LiveNumber";
import { Section } from "./Section";

/** fees → treasury → trades → profit → { burn, drops } with live values and data pulses on each link. */
export function Flywheel({ data }: { data: LiveData | null }) {
  const t = data?.stats.treasury;
  const s = data?.stats;
  const nodes = [
    { k: "01", name: "CREATOR FEES", v: t?.totalCreatorFeesSol, note: s?.autoClaim === "live" ? "auto-claimed via PumpPortal" : s?.autoClaim === "read-only" ? "claimable shown, claim manual" : "manual entry" },
    { k: "02", name: "TREASURY", v: t?.tradingSol, note: "trading capital" },
    { k: "03", name: "TRADES", v: s ? s.openPositions : undefined, unit: "open", dec: 0, note: "confluence · volume · scanner" },
    { k: "04", name: "PROFIT", v: t?.totalTradingProfitSol, note: "split: buyback / drops" },
  ];
  const ab = s?.activeAirdrop;
  const bb = s?.activeBuyback;
  return (
    <Section id="flywheel" cmd="xero flywheel --watch" title="FLYWHEEL">
      <Reveal>
        <div className="grid gap-px border border-line bg-line md:grid-cols-4">
          {nodes.map((n, i) => (
            <div key={n.k} className="relative overflow-hidden bg-bg p-5">
              <p className="text-[11px] text-muted">
                [{n.k}] <span className="text-fg">{n.name}</span>
              </p>
              <p className="mt-3 text-2xl text-brand glow">
                <LiveNumber value={n.v} decimals={n.dec ?? 3} />
                <span className="ml-2 text-xs text-muted">{n.unit ?? "SOL"}</span>
              </p>
              <p className="mt-1 text-[11px] text-muted">{n.note}</p>
              {i < nodes.length - 1 && (
                <div aria-hidden className="absolute inset-x-0 bottom-0 h-px overflow-hidden md:inset-y-0 md:left-auto md:right-0 md:h-auto md:w-px">
                  <div className="animate-flow h-px w-1/4 bg-gradient-to-r from-transparent via-brand to-transparent md:h-full" />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="grid gap-px border-x border-b border-line bg-line md:grid-cols-2">
          <JobPanel
            title="BUYBACK → BURN"
            tone="accent"
            lines={[
              ["pending", t ? `${t.pendingBuybackSol.toFixed(4)} SOL` : "—"],
              ["executing", bb ? `${bb.sol.toFixed(4)} SOL · job ${bb.id.slice(-8)}` : "idle"],
              ["lifetime", t ? `${t.totalBuybackSol.toFixed(3)} SOL → ${Math.round(t.totalXeroBurned).toLocaleString("en-US")} XERO` : "—"],
              ["rule", "burn exactly what the buy delivered"],
            ]}
          />
          <JobPanel
            title="AIRDROP → HOLDERS"
            tone="brand"
            lines={[
              ["pending", t ? `${t.pendingAirdropSol.toFixed(4)} SOL` : "—"],
              ["plan", ab ? `${ab.paid}/${ab.total} paid · ${ab.sol.toFixed(4)} SOL${ab.slot ? ` · slot ${ab.slot}` : ""}` : "no plan in flight"],
              ["lifetime", t ? `${t.totalAirdropSol.toFixed(3)} SOL to holders` : "—"],
              ["mode", s?.airdropMode ? `${s.airdropMode}${s.seatsGated ? " · seated wallets only" : ""}` : "—"],
            ]}
            progress={ab && ab.total ? ab.paid / ab.total : null}
          />
        </div>
      </Reveal>
    </Section>
  );
}

function JobPanel({ title, lines, tone, progress }: { title: string; lines: [string, string][]; tone: "brand" | "accent"; progress?: number | null }) {
  return (
    <div className="bg-bg p-5">
      <p className={cn("text-xs tracking-[0.2em]", tone === "brand" ? "text-brand" : "text-accent")}>{title}</p>
      <dl className="mt-3 space-y-1.5 text-xs">
        {lines.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-20 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-fg/90">{v}</dd>
          </div>
        ))}
      </dl>
      {progress != null && (
        <div className="mt-4 h-1.5 w-full border border-line" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="airdrop progress">
          <div className="h-full bg-brand transition-[width] duration-700" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
