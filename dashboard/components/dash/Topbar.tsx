"use client";
import type { LiveData } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow } from "./useLive";

const NAV = [
  { label: "treasury", href: "#treasury" },
  { label: "flywheel", href: "#flywheel" },
  { label: "ledger", href: "#ledger" },
  { label: "rules", href: "#rules" },
];

export function Topbar({ data, lastSync, offline }: { data: LiveData | null; lastSync: number | null; offline: boolean }) {
  const now = useNow();
  const ago = now && lastSync ? Math.max(0, Math.round((now - lastSync) / 1000)) : null;
  const live = data?.stats.mode === "live";
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 text-xs">
        <a href="#top" className="shrink-0 font-semibold tracking-[0.2em] text-brand glow">
          XERO<span className="text-muted">@</span>sol
        </a>
        <span
          className={cn(
            "shrink-0 border px-1.5 py-0.5 font-semibold tracking-widest",
            !data ? "border-line text-muted" : live ? "border-accent text-accent glow-red" : "border-brand/60 text-brand",
          )}
        >
          {!data ? "[ … ]" : live ? "[ LIVE ]" : "[ PAPER ]"}
        </span>
        {data?.stats.halted && <span className="shrink-0 animate-pulse text-accent glow-red">HALTED</span>}
        <nav className="ml-2 hidden items-center gap-4 text-muted md:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="transition hover:text-brand">
              ./{n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-muted">
          <span className="hidden sm:inline">SOL {data?.stats.solUsd ? `$${data.stats.solUsd.toFixed(0)}` : "—"}</span>
          <span className="flex items-center gap-1.5" aria-live="polite">
            <span className={cn("size-1.5 animate-pulse-dot", offline ? "bg-accent" : "bg-brand")} />
            {offline ? <span className="text-accent">link down</span> : ago === null ? "syncing" : `sync ${ago}s`}
          </span>
          <span className="hidden tabular-nums lg:inline">{now ? new Date(now).toISOString().slice(11, 19) : "--:--:--"} UTC</span>
        </div>
      </div>
    </header>
  );
}
