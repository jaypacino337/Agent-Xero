import crypto from "node:crypto";
import { config } from "../config.js";
import { log } from "../util/logger.js";

/**
 * Minimal X (Twitter) API v2 client with OAuth 1.0a user-context signing.
 * Zero dependencies — signing implemented with node:crypto.
 */
const pctEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method: string, url: string, queryParams: Record<string, string> = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: config.x.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: config.x.accessToken,
    oauth_version: "1.0",
  };
  const allParams = { ...oauth, ...queryParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(allParams[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join("&");
  const signingKey = `${pctEncode(config.x.apiSecret)}&${pctEncode(config.x.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(", ")
  );
}

// simple rolling rate limit
const postTimes: number[] = [];
function canPost(): boolean {
  const cutoff = Date.now() - 3600_000;
  while (postTimes.length && postTimes[0] < cutoff) postTimes.shift();
  return postTimes.length < config.x.maxPostsPerHour;
}

export function xConfigured(): boolean {
  return (
    config.x.enabled &&
    !!config.x.apiKey &&
    !!config.x.apiSecret &&
    !!config.x.accessToken &&
    !!config.x.accessSecret
  );
}

export async function postTweet(
  text: string,
  replyToId?: string,
): Promise<string | undefined> {
  if (!xConfigured()) {
    log.info("x", `[dry-run] would post: ${text.slice(0, 120)}…`);
    return undefined;
  }
  if (!canPost()) {
    log.warn("x", "hourly post cap reached, skipping post");
    return undefined;
  }
  const url = "https://api.twitter.com/2/tweets";
  const body: Record<string, unknown> = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: oauthHeader("POST", url),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: { id: string }; errors?: unknown };
    if (!res.ok || !json.data?.id) {
      log.error("x", "post failed", json);
      return undefined;
    }
    postTimes.push(Date.now());
    log.info("x", `posted ${json.data.id}: ${text.slice(0, 80)}…`);
    return json.data.id;
  } catch (err) {
    log.error("x", "post error", err);
    return undefined;
  }
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
}

export async function getMentions(sinceId?: string): Promise<Mention[]> {
  if (!xConfigured() || !config.x.userId) return [];
  const base = `https://api.twitter.com/2/users/${config.x.userId}/mentions`;
  const query: Record<string, string> = {
    "tweet.fields": "author_id",
    expansions: "author_id",
    "user.fields": "username",
    max_results: "20",
  };
  if (sinceId) query.since_id = sinceId;
  const qs = new URLSearchParams(query).toString();
  try {
    const res = await fetch(`${base}?${qs}`, {
      headers: { authorization: oauthHeader("GET", base, query) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn("x", `mentions fetch failed HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as {
      data?: { id: string; text: string; author_id: string }[];
      includes?: { users?: { id: string; username: string }[] };
    };
    const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u.username]));
    return (json.data ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      authorUsername: users.get(t.author_id),
    }));
  } catch (err) {
    log.warn("x", "mentions error", err);
    return [];
  }
}
