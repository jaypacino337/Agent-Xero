"use client";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

/** Headline that animates in word by word. Screen readers get the plain string. */
export function SplitText({ text, className, delay = 0, as: Tag = "h1" }: { text: string; className?: string; delay?: number; as?: "h1" | "h2" | "h3" | "p" }) {
  const reduce = useReducedMotion();
  const words = text.split(" ");
  return (
    <Tag className={cn("flex flex-wrap", className)} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden className="mr-[0.25em] inline-block overflow-hidden pb-[0.1em] last:mr-0">
          <motion.span
            className="inline-block"
            initial={reduce ? false : { y: "110%", rotate: 4 }}
            animate={{ y: 0, rotate: 0 }}
            transition={{ duration: 0.8, delay: delay + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
          >
            {w}
          </motion.span>
        </span>
      ))}
    </Tag>
  );
}
