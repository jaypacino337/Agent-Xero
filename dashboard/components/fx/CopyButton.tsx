"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/** Contract-address pill: truncates, copies, confirms. */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className={cn("rounded-full border border-line px-4 py-2 font-mono text-sm text-muted", className)}>CA: coming soon</span>;
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className={cn("group inline-flex items-center gap-2 rounded-full border border-line bg-white/5 px-4 py-2 font-mono text-sm transition hover:border-brand/50 hover:bg-white/10", className)}
      aria-label="Copy contract address"
    >
      <span className="text-muted">CA</span>
      <span>{value.slice(0, 6)}…{value.slice(-6)}</span>
      {copied ? <Check className="size-4 text-brand" /> : <Copy className="size-4 text-muted transition group-hover:text-fg" />}
    </button>
  );
}
