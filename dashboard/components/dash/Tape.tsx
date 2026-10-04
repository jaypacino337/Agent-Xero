import { Marquee } from "@/components/fx";
import { fmtInt, fmtSol, type LiveData } from "@/lib/api";
import { cn } from "@/lib/cn";

/** Scrolling event tape: latest trades, burns, drops and fee claims. */
export function Tape({ data }: { data: LiveData | null }) {
  type Item = { at: number; text: string; tone: "up" | "down" | "info" };
  const items: Item[] = [];
  for (const t of data?.trades.slice(0, 12) ?? []) {
    items.push({ at: t.at, text: `${t.side.toUpperCase()} ${t.symbol ?? t.mint.slice(0, 4)} ${fmtSol(t.sol)} SOL`, tone: t.side === "buy" ? "up" : "down" });
  }
  for (const b of data?.burns.slice(0, 6) ?? []) items.push({ at: b.at, text: `BURN ${fmtInt(b.xeroBurned)} $XERO`, tone: "down" });
  for (const d of data?.airdrops.slice(0, 6) ?? []) items.push({ at: d.at, text: `DROP ${fmtSol(d.totalSol)} SOL → ${d.recipientCount} holders`, tone: "up" });
  for (const c of data?.claims.slice(0, 4) ?? []) items.push({ at: c.at, text: `FEES +${fmtSol(c.sol, 4)} SOL (${c.source})`, tone: "info" });
  items.sort((a, b) => b.at - a.at);
  const shown = items.length
    ? items.slice(0, 20)
    : [
        { at: 0, text: "WAITING FOR FIRST SIGNAL", tone: "info" as const },
        { at: 0, text: "SCANNING PUMP.FUN", tone: "info" as const },
        { at: 0, text: "WATCHING SMART WALLETS", tone: "info" as const },
        { at: 0, text: "BURN ENGINE ARMED", tone: "down" as const },
      ];
  return (
    <div className="border-b border-line bg-surface/60 py-2.5 text-xs" aria-label="recent agent activity">
      <Marquee duration={Math.max(24, shown.length * 4)} gap="2.5rem">
        {shown.map((it, i) => (
          <span key={i} className="flex items-center gap-2 whitespace-nowrap">
            <span className={cn("size-1.5", it.tone === "up" ? "bg-brand" : it.tone === "down" ? "bg-accent" : "bg-muted")} />
            <span className={cn(it.tone === "up" ? "text-brand" : it.tone === "down" ? "text-accent" : "text-muted")}>{it.text}</span>
          </span>
        ))}
      </Marquee>
    </div>
  );
}
