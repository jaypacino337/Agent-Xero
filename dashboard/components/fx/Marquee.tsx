import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Infinite horizontal ticker. Pure CSS, pauses on hover. */
export function Marquee({
  children,
  reverse = false,
  duration = 30,
  gap = "2rem",
  className,
}: {
  children: ReactNode;
  reverse?: boolean;
  duration?: number;
  gap?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("group mask-fade-x flex overflow-hidden", className)}
      style={{ ["--duration" as string]: `${duration}s`, ["--gap" as string]: gap, gap }}
    >
      {[0, 1].map((k) => (
        <div
          key={k}
          aria-hidden={k === 1}
          className={cn(
            "flex shrink-0 items-center group-hover:[animation-play-state:paused]",
            reverse ? "animate-marquee-reverse" : "animate-marquee"
          )}
          style={{ gap }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}
