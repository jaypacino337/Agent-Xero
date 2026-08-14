import { config } from "../config.js";
import { log, shortId } from "../util/logger.js";
import { tracker } from "./bus.js";

/**
 * Telegram ingestion.
 *
 * Two jobs:
 *  1. Signal channel — any message in an allowed chat containing a Solana
 *     mint address (raw CA, pump.fun / dexscreener / birdeye link) becomes a
 *     "telegram-call" signal. Forward calls from your alpha channels (or any
 *     scanner/signaller bot) into a chat the bot can read and Xero will take
 *     them into consideration alongside its own signals.
 *  2. Admin commands from TELEGRAM_ADMIN_IDS:
 *       /status          — quick engine status
 *       /halt            — stop opening new positions
 *       /resume          — resume trading
 *       /fees <sol>      — record claimed pump.fun creator fees into treasury
 *       /deposit <sol>   — record a treasury deposit (trading capital)
 */
const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const LINK_RE = /(?:pump\.fun\/(?:coin\/)?|dexscreener\.com\/solana\/|birdeye\.so\/token\/)([1-9A-HJ-NP-Za-km-z]{32,44})/g;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: { id: number; title?: string };
    from?: { id: number; username?: string };
    forward_origin?: unknown;
  };
}

export interface TelegramHooks {
  getStatus: () => string;
  halt: () => void;
  resume: () => void;
  recordCreatorFees: (sol: number) => void;
  recordDeposit: (sol: number) => void;
}

export class TelegramIngest {
  private offset = 0;
  private stopped = false;

  constructor(private hooks: TelegramHooks) {}

  start(): void {
    if (!config.telegram.botToken) {
      log.info("telegram", "no TELEGRAM_BOT_TOKEN configured, ingestion disabled");
      return;
    }
    log.info("telegram", "long-polling for updates");
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(
          `${this.api("getUpdates")}?timeout=30&offset=${this.offset}`,
          { signal: AbortSignal.timeout(45_000) },
        );
        const json = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        for (const update of json.result ?? []) {
          this.offset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            log.warn("telegram", "update handling failed", err);
          }
        }
      } catch (err) {
        log.warn("telegram", "poll failed, retrying in 5s", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    const text = msg.text ?? msg.caption ?? "";
    const chatId = String(msg.chat.id);
    const fromId = String(msg.from?.id ?? "");

    if (text.startsWith("/") && config.telegram.adminIds.includes(fromId)) {
      await this.handleCommand(text, chatId);
      return;
    }

    if (!config.telegram.allowedChats.includes(chatId)) return;

    const mints = this.extractMints(text);
    for (const mint of mints) {
      const t = tracker.getOrCreate(mint);
      tracker.recordSignal({
        id: shortId(),
        source: "telegram-call",
        mint,
        symbol: t.symbol,
        at: Date.now(),
        strength: 65,
        detail: `called in "${msg.chat.title ?? chatId}"${msg.forward_origin ? " (forwarded)" : ""}`,
        mcUsd: t.mcUsd,
      });
      log.info("telegram", `call ingested: ${mint} from chat ${chatId}`);
    }
  }

  private extractMints(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(LINK_RE)) found.add(m[1]);
    // bare CAs: only accept plausible token-length base58 strings
    for (const m of text.matchAll(BASE58_RE)) {
      if (m[0].length >= 40) found.add(m[0]);
    }
    return [...found];
  }

  private async handleCommand(text: string, chatId: string): Promise<void> {
    const [cmd, arg] = text.trim().split(/\s+/);
    let reply = "unknown command";
    switch (cmd) {
      case "/status":
        reply = this.hooks.getStatus();
        break;
      case "/halt":
        this.hooks.halt();
        reply = "🛑 trading halted — no new positions will be opened";
        break;
      case "/resume":
        this.hooks.resume();
        reply = "✅ trading resumed";
        break;
      case "/fees": {
        const sol = Number(arg);
        if (Number.isFinite(sol) && sol > 0) {
          this.hooks.recordCreatorFees(sol);
          reply = `recorded ${sol} SOL creator fees into treasury`;
        } else reply = "usage: /fees <sol>";
        break;
      }
      case "/deposit": {
        const sol = Number(arg);
        if (Number.isFinite(sol) && sol > 0) {
          this.hooks.recordDeposit(sol);
          reply = `recorded ${sol} SOL trading deposit`;
        } else reply = "usage: /deposit <sol>";
        break;
      }
    }
    await fetch(this.api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    }).catch(() => undefined);
  }
}
