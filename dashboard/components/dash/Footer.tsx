import { site } from "@/lib/site";

export function Footer() {
  return (
    <footer className="mx-auto max-w-7xl px-4 py-10 text-[11px] leading-relaxed text-muted">
      <p>
        <span className="text-brand">{site.name.toLowerCase().replace(" ", "-")}</span> is an experiment in autonomous trading. nothing here is
        financial advice. paper-mode entries are simulated against live prices and marked (paper).
      </p>
      <p className="mt-2">
        <span className="text-accent">exit 0</span> · data: the agent&apos;s own ledger, refreshed every {site.pollMs / 1000}s
      </p>
    </footer>
  );
}
