"use client";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { fmtInt, fmtSol, fmtUsd, hhmm, isRealSig, short, type LiveData } from "@/lib/api";
import { cn } from "@/lib/cn";
import { site } from "@/lib/site";
import { Section } from "./Section";

const TABS = ["trades", "positions", "burns", "drops", "fees"] as const;
type Tab = (typeof TABS)[number];

function Tx({ sig }: { sig?: string }) {
  if (!sig) return <span className="text-muted">—</span>;
  if (!isRealSig(sig)) return <span className="text-muted">{sig.startsWith("paper-") ? "paper" : short(sig)}</span>;
  return (
    <a href={`${site.explorer}${sig}`} target="_blank" rel="noreferrer" className="text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
      {short(sig)}
    </a>
  );
}

const Paper = ({ on }: { on: boolean }) => (on ? <span className="ml-1 text-[10px] text-muted">(paper)</span> : null);

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-10 text-center text-muted">
                {empty}
                <span className="ml-1 inline-block h-3 w-1.5 translate-y-0.5 animate-blink bg-muted" aria-hidden />
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <motion.tr key={i} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="border-b border-line/50 hover:bg-brand/[0.04]">
                {r.map((c, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {c}
                  </td>
                ))}
              </motion.tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Ledger({ data }: { data: LiveData | null }) {
  const [tab, setTab] = useState<Tab>("trades");
  const counts: Record<Tab, number> = {
    trades: data?.trades.length ?? 0,
    positions: data?.positions.filter((p) => p.status === "open").length ?? 0,
    burns: data?.burns.length ?? 0,
    drops: data?.airdrops.length ?? 0,
    fees: data?.claims.length ?? 0,
  };
  const label = (r: { symbol?: string; mint: string }) => r.symbol ?? short(r.mint);

  const body = () => {
    if (!data) return <Table head={["status"]} rows={[]} empty="connecting to agent…" />;
    switch (tab) {
      case "trades":
        return (
          <Table
            head={["time", "side", "token", "SOL", "mc", "reason", "tx"]}
            empty="no trades yet: waiting for a high-conviction entry"
            rows={data.trades.slice(0, 60).map((t) => [
              hhmm(t.at),
              <span key="s" className={t.side === "buy" ? "text-brand" : "text-accent"}>{t.side.toUpperCase()}</span>,
              <>{label(t)}<Paper on={t.paper} /></>,
              fmtSol(t.sol),
              fmtUsd(t.mcUsd),
              <span key="r" className="text-muted">{t.reason}</span>,
              <Tx key="tx" sig={t.txSignature} />,
            ])}
          />
        );
      case "positions":
        return (
          <Table
            head={["token", "entry mc", "peak mc", "SOL in", "signals", "score", "opened"]}
            empty="flat: no open positions"
            rows={data.positions.filter((p) => p.status === "open").map((p) => [
              <>{label(p)}<Paper on={p.paper} /></>,
              fmtUsd(p.entryMcUsd),
              <span key="pk" className="text-brand">{fmtUsd(p.peakMcUsd)}</span>,
              fmtSol(p.solIn),
              <span key="sg" className="text-muted">{p.sources.join(", ")}</span>,
              p.score,
              hhmm(p.openedAt),
            ])}
          />
        );
      case "burns":
        return (
          <Table
            head={["time", "SOL spent", "$XERO bought", "$XERO burned", "funded by", "buy tx", "burn tx"]}
            empty="no burns yet: buybacks fire once the pool crosses the minimum"
            rows={data.burns.map((b) => [
              <>{hhmm(b.at)}<Paper on={b.paper} /></>,
              fmtSol(b.solSpent),
              fmtInt(b.xeroBought),
              <span key="b" className="text-accent">{fmtInt(b.xeroBurned)}</span>,
              <span key="f" className="text-muted">{b.fundedBy}</span>,
              <Tx key="bt" sig={b.buyTx} />,
              <Tx key="burn" sig={b.burnTx} />,
            ])}
          />
        );
      case "drops":
        return (
          <Table
            head={["time", "SOL", "recipients", "mode", "slot (seed)", "top recipient", "txs"]}
            empty="no drops yet: hold $XERO to be in every draw"
            rows={data.airdrops.map((d) => [
              <>{hhmm(d.at)}<Paper on={d.paper} /></>,
              <span key="s" className="text-brand">{fmtSol(d.totalSol)}</span>,
              d.recipientCount,
              `${d.mode}${d.seated ? " · seats" : ""}`,
              d.slot ?? "—",
              d.recipients[0] ? `${short(d.recipients[0].wallet)} ${fmtSol(d.recipients[0].sol, 4)}` : "—",
              d.txs.filter(isRealSig).length ? <Tx key="tx" sig={d.txs.filter(isRealSig)[0]} /> : <span key="tx" className="text-muted">{d.paper ? "paper" : d.txs.length}</span>,
            ])}
          />
        );
      case "fees":
        return (
          <Table
            head={["time", "SOL", "source", "tx"]}
            empty="no creator fees recorded yet"
            rows={data.claims.map((c) => [
              <>{hhmm(c.at)}<Paper on={c.paper} /></>,
              <span key="s" className="text-brand">+{fmtSol(c.sol, 4)}</span>,
              <span key="src" className={c.source === "auto" ? "text-brand" : "text-muted"}>{c.source}</span>,
              <Tx key="tx" sig={c.signature} />,
            ])}
          />
        );
    }
  };

  return (
    <Section id="ledger" cmd={`tail -f /data/${tab}.json`} title="LEDGER">
      <div className="border border-line bg-surface/40">
        <div role="tablist" aria-label="ledger" className="flex overflow-x-auto border-b border-line text-xs">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "relative shrink-0 px-4 py-3 tracking-widest transition",
                tab === t ? "bg-brand text-bg" : "text-muted hover:bg-brand/10 hover:text-brand",
              )}
            >
              {t.toUpperCase()} <span className={cn("ml-1", tab === t ? "text-bg/70" : "text-muted/70")}>{counts[t]}</span>
            </button>
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
            {body()}
          </motion.div>
        </AnimatePresence>
      </div>
    </Section>
  );
}
