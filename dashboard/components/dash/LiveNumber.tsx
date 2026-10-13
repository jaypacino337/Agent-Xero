"use client";
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A number that ticks: rolls from its last value to the new one and flashes
 * green (up) or red (down) when the agent's ledger changes. "—" until known.
 */
export function LiveNumber({
  value,
  decimals = 3,
  prefix = "",
  suffix = "",
  signed = false,
  className,
}: {
  value: number | null | undefined;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  signed?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<number | null>(null);
  const reduce = useReducedMotion();
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");
  const fmt = (n: number) =>
    (signed && n > 0 ? "+" : "") + prefix + n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;

  useEffect(() => {
    const el = ref.current;
    if (!el || value == null) return;
    const from = prev.current;
    prev.current = value;
    if (from === null || reduce) {
      // first paint: count up from zero (or jump, for reduced motion)
      if (reduce) {
        el.textContent = fmt(value);
        return;
      }
    }
    const start = from ?? 0;
    if (from !== null && Math.abs(value - from) > 10 ** -decimals / 2) {
      setFlash(value > from ? "flash-up" : "flash-down");
      const t = setTimeout(() => setFlash(""), 900);
      const c = animate(start, value, { duration: 0.9, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => (el.textContent = fmt(v)) });
      return () => {
        c.stop();
        clearTimeout(t);
      };
    }
    const c = animate(start, value, { duration: from === null ? 1.4 : 0.01, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => (el.textContent = fmt(v)) });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);

  return (
    <span ref={ref} className={cn("tabular-nums transition-colors", flash, className)}>
      {value == null ? "—" : fmt(0)}
    </span>
  );
}
