# AGENT XERO

Autonomous Solana memecoin trading agent, powered by **Claude Fable 5**, tied to the **$XERO** token.

The flywheel:

```
pump.fun creator fees ──► treasury ──► high-conviction trades ──► profits
                                                                    │
        $XERO burned ◄── on-market buyback ◄────────────────────────┤
                                          ◄── callout revenue ──────┘
```

Every trade, buyback and burn is written to a public ledger and served on the site.

## What it does

**Signal sources** (all feed one composite score per token):

| Source | Weight | What fires it |
|---|---|---|
| Smart-wallet confluence | 40 | N tracked high-quality profitable wallets buy the same token within a window (PumpPortal account stream) |
| Volume threshold | 25 | Rolling buy volume + unique-buyer count cross thresholds |
| Telegram calls | 20 | CAs posted/forwarded into an allowed chat (your alpha channels, scanner bots, signallers) |
| pump.fun scanner | 15 | Fresh launch showing early momentum while still tiny |
| External callers | 20 | Reserved for future scanner/API integrations |

**Strategy** — catch runners early: only enter while market cap is **below `ENTRY_MAX_MC_USD` (default $10k)** and the composite score clears the bar. Scale out **`TAKE_PROFIT_SELL_PCT`** when the token crosses **`TARGET_MC_USD` (default $100k)**, ride the rest with a trailing stop, hard stop-loss below entry. (Nobody can literally know in advance which sub-$10k token hits $100k — the scorer is the proxy, and every knob is tunable in `.env`.)

**Treasury & burn** — creator fees fund trading; realized profits (and callout revenue) accumulate and auto-execute $XERO buybacks, which are burned. Lifetime totals (fees, profit, SOL bought back, $XERO burned) are on the site.

**Social** — Xero posts entries, runner hits and burns on X in its own voice (Claude-generated, template fallback), and replies to mentions — including other agents like `@aixbt_agent`. Rate-limited, guard-railed (never promises profits, never invents numbers).

## Run it

```bash
npm install
cp .env.example .env   # fill in what you have; everything is optional in paper mode
npm run dev
# site + ledger: http://localhost:3000
```

**Paper mode is the default** (`PAPER_TRADING=true`). The full pipeline runs against live pump.fun data — real signals, simulated fills with slippage, no transactions — so you can watch it trade and tune thresholds before going live. Paper trades are marked `(paper)` everywhere.

Out of the box (no keys at all) you get: pump.fun scanning, volume signals, paper trading, the site, and dry-run logged posts. Add keys to unlock:

| Key(s) | Unlocks |
|---|---|
| `SMART_WALLETS` | wallet-confluence signals (the highest-weight source — curate this list) |
| `TELEGRAM_BOT_TOKEN` + chat IDs | telegram call ingestion + admin commands (`/status /halt /resume /fees /deposit`) |
| `ANTHROPIC_API_KEY` | Claude-generated posts & replies (`PERSONA_MODEL=claude-fable-5`) |
| `X_*` credentials + `X_ENABLED=true` | real posting + mention engagement |
| `PUMPPORTAL_API_KEY` + `PAPER_TRADING=false` | live execution |

## Deploy on Railway

The repo ships a `Dockerfile` + `railway.json` (healthcheck on `/api/stats`, restart on failure). Railway auto-detects both.

1. Railway → **New Project → Deploy from GitHub repo** → pick this repo/branch.
2. **Attach a volume** to the service, mount path `/data` (the Dockerfile sets `DATA_DIR=/data`). Without it, the ledger resets on every deploy.
3. Set variables (Service → Variables). Minimum useful set:
   - `PAPER_TRADING=true` (keep it true until the paper ledger earns your trust)
   - `ADMIN_TOKEN=<long random string>` — required to use the admin API remotely, e.g.
     `curl -X POST https://<app>.up.railway.app/api/admin/fees -H "Authorization: Bearer <token>" -d '{"sol":1.5}'`
     (Telegram `/fees` etc. also works and needs no token)
   - then any of: `SMART_WALLETS`, `TELEGRAM_*`, `ANTHROPIC_API_KEY`, `X_*`, `PUMPPORTAL_API_KEY`
4. **Generate a domain** (Settings → Networking) — that URL is the live site + ledger. Railway injects `PORT` automatically; the app reads it.
5. Watch logs: within seconds you should see `subscribed to new tokens + migrations` and, once signals fire, paper entries in the trade log.

Vercel is not suitable — the bot is a long-running process with persistent websockets and background loops, which serverless platforms kill between requests.

## Going live — read this first

1. Run paper mode for days, not hours. Tune `MIN_SCORE_TO_BUY`, volume thresholds and the smart-wallet list until the paper ledger looks like something you'd fund.
2. Fund a **dedicated** PumpPortal Lightning wallet with only what the treasury should trade. Record deposits with `/deposit` so the ledger matches the wallet.
3. Set `PAPER_TRADING=false`. Risk rails: `MAX_OPEN_POSITIONS`, `DAILY_LOSS_LIMIT_SOL` (halts entries for the day), `/halt` kill switch.
4. **Live burns:** buybacks execute automatically via PumpPortal, but the burn itself is an SPL transfer to the incinerator (`1nc1nerator1111…`). That transfer isn't something PumpPortal exposes, so in live mode execute it from the operator wallet (or wire in `@solana/web3.js` — the ledger records the buyback and leaves `burnTx` empty until then). Paper mode simulates the full loop.
5. Creator-fee claims and pump.fun fee-share/callout revenue arrive on-chain outside this bot — record them with `/fees <sol>` and `POST /api/admin/callout-profit {"sol": n}` so they enter the ledger and the buyback pool.

## API

`GET /api/stats · /api/positions · /api/trades · /api/burns · /api/callouts` — public, consumed by the site.
`POST /api/admin/{fees|deposit|callout-profit|halt|resume}` — localhost only.

## Layout

```
src/
  signals/    pumpfun scanner, smart-wallet watcher, volume detector, telegram ingest
  engine/     scorer (signal confluence → 0-100), risk gate, trader (entries/exits)
  treasury/   ledger accounting, buyback & burn engine
  social/     X client (zero-dep OAuth1a), Claude persona, mention engagement, callout tracker
  market/     SOL/USD feed
  server/     site + JSON API
  store/      JSON-file persistence (./data)
site/         the public dashboard
```

Zero runtime dependencies beyond `@anthropic-ai/sdk` (Node ≥ 22: built-in `fetch` + `WebSocket`).

## Disclaimers

Memecoin trading is extremely high risk; most launches go to zero. This software can lose all funds it controls. Nothing it does or posts is financial advice. Comply with your local laws and X/Telegram platform rules.
