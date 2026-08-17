import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { db } from "../store/db.js";
import type { AirdropEvent, BurnEvent, Position } from "../types.js";
import { log } from "../util/logger.js";

/**
 * Xero's voice — powered by Claude (Fable 5 by default).
 *
 * Generates trade posts, buyback/burn posts and replies to mentions
 * (including other AI agents like aixbt). Falls back to plain templated
 * posts when no ANTHROPIC_API_KEY is configured, so the bot never blocks
 * on the persona layer.
 */
const SYSTEM = `You are Xero, an autonomous on-chain trading agent on Solana, and the voice of the $XERO token.

Who you are:
- An AI agent powered by Claude Fable 5. You watch pump.fun launches, smart-wallet flows and volume in real time, and you only take high-conviction entries when independent signals line up.
- Your treasury is funded by pump.fun creator fees. Trading profits and callout revenue buy back and burn $XERO. Every trade, buyback and burn is documented on your site.

Voice:
- Terse, confident, a little dry. Lowercase is fine. Crypto-twitter native but never cringe, never spammy, no rocket-emoji walls (one emoji max).
- Numbers over adjectives: cite entry mc, current mc, multiples, SOL amounts.
- When interacting with other AI agents (aixbt etc.), be a peer: sharp, playful, technical.

Hard rules:
- Max 260 characters per post.
- Never promise profits, never say "guaranteed", never tell people to buy anything. You report what YOU did.
- Never invent numbers — only use the data provided in the prompt.
- No hashtag spam (max 1). Never use "$" tickers other than $XERO and the token being discussed.
- If asked for financial advice, deflect with humor and point to your track record page.

Output ONLY the post text, nothing else.`;

let client: Anthropic | undefined;
function getClient(): Anthropic | undefined {
  if (!config.persona.anthropicApiKey) return undefined;
  client ??= new Anthropic({ apiKey: config.persona.anthropicApiKey });
  return client;
}

async function generate(prompt: string): Promise<string | undefined> {
  const anthropic = getClient();
  if (!anthropic) return undefined;
  try {
    const response = await anthropic.beta.messages.create({
      model: config.persona.model,
      max_tokens: 1024,
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      log.warn("persona", "model declined to generate this post");
      return undefined;
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text.length > 0 ? text.slice(0, 280) : undefined;
  } catch (err) {
    log.error("persona", "generation failed", err);
    return undefined;
  }
}

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const persona = {
  async entryPost(p: Position): Promise<string> {
    const generated = await generate(
      `Write an entry post. You just bought ${p.symbol ?? p.mint.slice(0, 6)} (${p.mint}) at ${fmtUsd(p.entryMcUsd)} market cap with ${p.solIn} SOL. Signals that fired: ${p.sources.join(", ")}. Composite score ${p.score}/100. Your target zone starts at ${fmtUsd(config.trading.targetMcUsd)}.`,
    );
    return (
      generated ??
      `entered ${p.symbol ?? p.mint.slice(0, 6)} at ${fmtUsd(p.entryMcUsd)} mc — ${p.sources.join(" + ")} confluence, score ${p.score}/100. tracking to ${fmtUsd(config.trading.targetMcUsd)}. every trade documented on the site.`
    );
  },

  async targetHitPost(p: Position): Promise<string> {
    const multiple = p.entryMcUsd > 0 ? (p.peakMcUsd / p.entryMcUsd).toFixed(1) : "?";
    const generated = await generate(
      `Write a runner-hit post. ${p.symbol ?? p.mint.slice(0, 6)} which you entered at ${fmtUsd(p.entryMcUsd)} mc just crossed ${fmtUsd(config.trading.targetMcUsd)} (${multiple}x from your entry). You scaled out ${config.trading.takeProfitSellPct}% and profits go to the $XERO buyback+burn.`,
    );
    return (
      generated ??
      `${p.symbol ?? p.mint.slice(0, 6)}: ${fmtUsd(p.entryMcUsd)} entry → ${fmtUsd(config.trading.targetMcUsd)}+ (${multiple}x). scaled ${config.trading.takeProfitSellPct}%. profits → $XERO buyback & burn.`
    );
  },

  async burnPost(e: BurnEvent): Promise<string> {
    const generated = await generate(
      `Write a buyback-and-burn post. You just used ${e.solSpent.toFixed(3)} SOL of profits to buy back and burn ${Math.round(e.xeroBurned).toLocaleString()} $XERO. Lifetime totals: ${db.treasury.totalBuybackSol.toFixed(2)} SOL bought back, ${Math.round(db.treasury.totalXeroBurned).toLocaleString()} $XERO burned.`,
    );
    return (
      generated ??
      `🔥 burned ${Math.round(e.xeroBurned).toLocaleString()} $XERO (${e.solSpent.toFixed(3)} SOL of profits). lifetime: ${db.treasury.totalBuybackSol.toFixed(2)} SOL → ${Math.round(db.treasury.totalXeroBurned).toLocaleString()} $XERO burned. receipts on site.`
    );
  },

  async airdropPost(e: AirdropEvent): Promise<string> {
    const generated = await generate(
      `Write a holder-airdrop post. You just dropped ${e.totalSol.toFixed(3)} SOL to ${e.recipientCount} $XERO holders (${e.mode === "random" ? "holdings-weighted lottery" : "pro-rata by holdings"}), funded by callout rewards and trading profits. Lifetime airdropped: ${db.treasury.totalAirdropSol.toFixed(2)} SOL. Holding is the only way to be eligible.`,
    );
    return (
      generated ??
      `🎁 dropped ${e.totalSol.toFixed(3)} SOL to ${e.recipientCount} $XERO holders (${e.mode}). funded by callout rewards + profits. lifetime airdropped: ${db.treasury.totalAirdropSol.toFixed(2)} SOL. hold to be eligible.`
    );
  },

  async reply(mentionText: string, author?: string): Promise<string | undefined> {
    const open = db.positions.filter((p) => p.status === "open").length;
    return generate(
      `Someone ${author ? `(@${author})` : ""} mentioned you on X: "${mentionText.slice(0, 400)}". Reply in character. Context you may use: ${open} open positions, ${db.treasury.totalBuybackSol.toFixed(2)} SOL bought back lifetime, ${Math.round(db.treasury.totalXeroBurned).toLocaleString()} $XERO burned. If it's another AI agent, engage as a peer. If it's a question about how you work, explain briefly (signal confluence -> early entries -> profits burn $XERO).`,
    );
  },
};
