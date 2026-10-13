"use client";
import { motion, useReducedMotion } from "motion/react";
import { CopyButton, TextScramble } from "@/components/fx";
import type { LiveData } from "@/lib/api";
import { site } from "@/lib/site";

export function Hero({ data }: { data: LiveData | null }) {
  const reduce = useReducedMotion();
  const links = data?.links;
  const t = data?.stats.treasury;
  const boot = [
    `> boot agent-xero ............ ok`,
    `> mode ...................... ${data ? data.stats.mode.toUpperCase() : "…"}`,
    `> treasury .................. ${t ? `${t.tradingSol.toFixed(3)} SOL` : "…"}`,
    `> burn engine ............... armed (delta-only)`,
    `> airdrop engine ............ armed (${data?.stats.airdropMode ?? "…"}${data?.stats.seatsGated ? ", seats" : ""})`,
    `> fee claims ................ ${data?.stats.autoClaim ?? "…"}`,
  ];
  return (
    <section id="top" className="relative overflow-hidden border-b border-line">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] bg-[size:48px_48px] opacity-30 mask-fade-b" />
      <div className="relative mx-auto grid max-w-7xl gap-10 px-4 pb-16 pt-14 md:grid-cols-[1.25fr_1fr] md:pb-24 md:pt-20">
        <div>
          <p className="text-xs tracking-[0.3em] text-muted">// AUTONOMOUS PUMP.FUN TRADING AGENT</p>
          <h1 className="mt-4 font-display text-[clamp(4rem,13vw,9.5rem)] leading-[0.85] tracking-wider text-brand glow animate-flicker">
            <TextScramble text="AGENT XERO" />
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-sm leading-relaxed text-fg/80 md:text-base">
            {site.tagline}
            <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-blink bg-brand" aria-hidden />
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {links?.buyUrl ? (
              <a
                href={links.buyUrl}
                target="_blank"
                rel="noreferrer"
                className="border border-brand bg-brand px-5 py-2.5 text-sm font-bold tracking-widest text-bg transition hover:bg-transparent hover:text-brand active:scale-95"
              >
                BUY ${site.ticker}
              </a>
            ) : (
              <span className="border border-line px-5 py-2.5 text-sm tracking-widest text-muted">${site.ticker}: launching soon</span>
            )}
            {links?.xHandle && (
              <a href={`https://x.com/${links.xHandle}`} target="_blank" rel="noreferrer" className="border border-line px-4 py-2.5 text-sm text-fg transition hover:border-brand hover:text-brand">
                𝕏 @{links.xHandle}
              </a>
            )}
            {links?.telegramUrl && (
              <a href={links.telegramUrl} target="_blank" rel="noreferrer" className="border border-line px-4 py-2.5 text-sm text-fg transition hover:border-brand hover:text-brand">
                telegram
              </a>
            )}
            <CopyButton value={links?.mint ?? ""} className="rounded-none" />
          </div>
        </div>
        <div className="self-end border border-line bg-surface/70 box-glow">
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[11px] text-muted">
            <span className="size-2 bg-accent" />
            <span className="size-2 bg-muted/60" />
            <span className="size-2 bg-brand" />
            <span className="ml-2">xero@solana: ~/agent</span>
          </div>
          <ol className="space-y-1.5 p-4 text-xs leading-relaxed text-fg/85 sm:text-[13px]">
            {boot.map((line, i) => (
              <motion.li
                key={i}
                initial={reduce ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.25 + i * 0.18, duration: 0.35 }}
                className="truncate"
              >
                {line.replace(/ok$|armed.*$/, "")}
                <span className="text-brand">{line.match(/ok$|armed.*$/)?.[0]}</span>
              </motion.li>
            ))}
            <li className="text-brand">
              {">"} <span className="inline-block h-3.5 w-2 translate-y-0.5 animate-blink bg-brand" aria-hidden />
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
