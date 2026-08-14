import { config } from "../config.js";
import { log } from "../util/logger.js";
import { persona } from "./persona.js";
import { getMentions, postTweet, xConfigured } from "./x.js";

/**
 * Mention engagement loop. Polls mentions and replies in character —
 * this is how Xero interacts with people and other agents (aixbt etc.).
 * Priority goes to handles in X_ENGAGE_HANDLES; other mentions are replied
 * to opportunistically within the hourly post budget.
 */
export class EngagementLoop {
  private sinceId?: string;
  private replied = new Set<string>();

  start(): void {
    if (!xConfigured()) {
      log.info("engage", "X not configured/enabled, engagement loop disabled");
      return;
    }
    setInterval(() => void this.tick(), config.x.mentionPollSec * 1000).unref();
    log.info("engage", `polling mentions every ${config.x.mentionPollSec}s`);
  }

  private async tick(): Promise<void> {
    const mentions = await getMentions(this.sinceId);
    if (mentions.length) this.sinceId = mentions[0].id;

    const priority = mentions.filter(
      (m) =>
        m.authorUsername &&
        config.x.engageHandles.some(
          (h) => h.toLowerCase() === m.authorUsername!.toLowerCase(),
        ),
    );
    const rest = mentions.filter((m) => !priority.includes(m));

    for (const mention of [...priority, ...rest.slice(0, 2)]) {
      if (this.replied.has(mention.id)) continue;
      this.replied.add(mention.id);
      const reply = await persona.reply(mention.text, mention.authorUsername);
      if (reply) await postTweet(reply, mention.id);
    }
    if (this.replied.size > 2000) this.replied.clear();
  }
}
