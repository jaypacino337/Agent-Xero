"use client";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Card with a glow that follows the cursor + a lit border. */
export function SpotlightCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        ref.current!.style.setProperty("--x", `${e.clientX - r.left}px`);
        ref.current!.style.setProperty("--y", `${e.clientY - r.top}px`);
      }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-line bg-surface/60 p-6 backdrop-blur-sm transition-colors duration-300 hover:border-white/20",
        "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition-opacity before:duration-300 hover:before:opacity-100",
        "before:bg-[radial-gradient(400px_circle_at_var(--x)_var(--y),color-mix(in_oklab,var(--color-brand)_18%,transparent),transparent_60%)]",
        className
      )}
    >
      <div className="relative">{children}</div>
    </div>
  );
}
