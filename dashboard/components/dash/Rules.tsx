import { RevealGroup, RevealItem } from "@/components/fx";
import { site } from "@/lib/site";
import { Section } from "./Section";

export function Rules() {
  return (
    <Section id="rules" cmd="man xero-treasury" title="HARD RULES">
      <RevealGroup className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {site.guarantees.map((g, i) => (
          <RevealItem key={g.k} className="bg-bg p-5">
            <p className="text-xs text-brand">
              <span className="text-muted">{String(i + 1).padStart(2, "0")} ::</span> {g.k}
            </p>
            <p className="mt-2 text-pretty text-xs leading-relaxed text-fg/75">{g.v}</p>
          </RevealItem>
        ))}
      </RevealGroup>
      <p className="mt-6 text-xs leading-relaxed text-muted">
        how the flywheel works: pump.fun creator fees fund the trading treasury. xero takes high-conviction entries only (tracked wallets buying in
        confluence, buy-volume thresholds, early pump.fun momentum, telegram calls), sub-$10k entries hunting $100k+ runners. profits split
        between $XERO buybacks (burned) and the holder airdrop pool; callout rewards go to holder drops. hold $XERO to be in every draw.
      </p>
    </Section>
  );
}
