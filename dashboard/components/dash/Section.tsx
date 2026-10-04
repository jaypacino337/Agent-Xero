import type { ReactNode } from "react";
import { Reveal } from "@/components/fx";

export function Section({ id, cmd, title, children, aside }: { id: string; cmd: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 border-b border-line">
      <div className="mx-auto max-w-7xl px-4 py-16 md:py-20">
        <Reveal>
          <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs text-muted">
                <span className="text-brand">$</span> {cmd}
              </p>
              <h2 className="mt-2 font-display text-4xl tracking-wider text-fg md:text-5xl">{title}</h2>
            </div>
            {aside}
          </div>
        </Reveal>
        {children}
      </div>
    </section>
  );
}
