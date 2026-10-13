"use client";
import { RevealGroup, RevealItem, SpotlightCard } from "@/components/fx";
import type { LiveData } from "@/lib/api";
import { cn } from "@/lib/cn";
import { LiveNumber } from "./LiveNumber";
import { Section } from "./Section";

type Tile = { label: string; value: number | null | undefined; unit: string; decimals?: number; sub?: string; tone?: "brand" | "accent" | "fg"; signed?: boolean };

export function Treasury({ data }: { data: LiveData | null }) {
  const t = data?.stats.treasury;
  const s = data?.stats;
  const tiles: Tile[] = [
    { label: "trading treasury", value: t?.tradingSol, unit: "SOL", tone: "brand", sub: "capital the agent trades with" },
    { label: "$XERO burned", value: t?.totalXeroBurned, unit: "XERO", decimals: 0, tone: "accent", sub: t ? `${t.totalBuybackSol.toFixed(3)} SOL bought back · ${s?.totalBurnEvents ?? 0} burns` : undefined },
    { label: "airdropped to holders", value: t?.totalAirdropSol, unit: "SOL", tone: "brand", sub: data ? `${data.airdrops.length} drops · ${s?.airdropMode ?? ""}${s?.seatsGated ? " · seats only" : ""}` : undefined },
    { label: "trading pnl (lifetime)", value: t?.totalTradingProfitSol, unit: "SOL", signed: true, tone: (t?.totalTradingProfitSol ?? 0) < 0 ? "accent" : "brand", sub: s ? (s.winRate == null ? "no closed trades yet" : `${s.winRate}% win · ${s.closedPositions} closed · ${s.openPositions} open`) : undefined },
    { label: "pending buyback", value: t?.pendingBuybackSol, unit: "SOL", tone: "fg", sub: t?.inFlightBuybackSol ? `${t.inFlightBuybackSol.toFixed(3)} SOL executing` : "fires at the min threshold" },
    { label: "pending airdrop", value: t?.pendingAirdropSol, unit: "SOL", tone: "fg", sub: t?.inFlightAirdropSol ? `${t.inFlightAirdropSol.toFixed(3)} SOL in a frozen plan` : "fires at the min threshold" },
    { label: "creator fees claimed", value: t?.totalCreatorFeesSol, unit: "SOL", tone: "fg", sub: t ? `${(t.totalAutoClaimedSol ?? 0).toFixed(3)} auto · rest manual` : undefined },
    { label: "claimable now", value: t?.claimableSol ?? null, unit: "SOL", decimals: 4, tone: "fg", sub: s ? `auto-claim: ${s.autoClaim ?? "off"}` : undefined },
  ];
  return (
    <Section id="treasury" cmd="cat /data/treasury.json" title="TREASURY" aside={<p className="text-xs text-muted">every number below is the agent&apos;s own ledger{data?.stats.mode === "paper" ? " · paper mode: simulated fills" : ""}</p>}>
      <RevealGroup className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <RevealItem key={tile.label} className="bg-bg">
            <SpotlightCard className="h-full rounded-none border-0 bg-bg p-5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted">{tile.label}</p>
              <p className={cn("mt-3 text-3xl font-semibold md:text-[2rem]", tile.tone === "brand" && "text-brand glow", tile.tone === "accent" && "text-accent glow-red", tile.tone === "fg" && "text-fg")}>
                <LiveNumber value={tile.value} decimals={tile.decimals ?? 3} signed={tile.signed} />
                <span className="ml-2 text-xs font-normal text-muted">{tile.unit}</span>
              </p>
              <p className="mt-2 min-h-4 text-[11px] text-muted">{tile.sub ?? ""}</p>
            </SpotlightCard>
          </RevealItem>
        ))}
      </RevealGroup>
    </Section>
  );
}
