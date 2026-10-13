"use client";
import { motion, useScroll, useSpring } from "motion/react";

/** Thin brand-colored bar at the top showing scroll progress. */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  return <motion.div aria-hidden style={{ scaleX }} className="fixed inset-x-0 top-0 z-[70] h-0.5 origin-left bg-gradient-to-r from-brand to-accent" />;
}
