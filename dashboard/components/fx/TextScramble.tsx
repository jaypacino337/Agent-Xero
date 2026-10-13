"use client";
import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";

const GLYPHS = "!<>-_\\/[]{}—=+*^?#$%01";

/** Hacker-style scramble that resolves into the text when scrolled into view. */
export function TextScramble({ text, className, speed = 28 }: { text: string; className?: string; speed?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (!inView || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const done = Math.floor(frame / 2);
      setOut(text.split("").map((c, i) => (i < done || c === " " ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join(""));
      if (done >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [inView, text, speed]);
  return <span ref={ref} className={className} aria-label={text}>{out}</span>;
}
