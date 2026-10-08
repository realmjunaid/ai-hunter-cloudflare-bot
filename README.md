# Ai Hunter

A Cloudflare Worker that hunts **free AI models and free-access announcements** and posts them to Discord. It runs entirely on Cloudflare's free plan — Workers + Cron Triggers + KV. No server needed.

## What it watches

| Source | What triggers an alert |
| --- | --- |
| **OpenRouter** (`openrouter.ai/api/v1/models`) | A `:free` model is added or removed |
| **Infron** (`api.infron.ai/v1/models`) | A `:free` model is added or removed |
| **OpenCode Zen** (`opencode.ai/zen/v1/models`) | A `-free` model is added or removed |
| **X (Twitter)** — 37 curated accounts | A post from the **last 24 hours** about free model/API access, new releases, or promo campaigns |

Model alerts and X-post alerts can go to **two different Discord channels**.

### Smart X-post filter

Instead of a single keyword, posts must pass a signal-based filter:

- **Free-access signal** — `free`, `$0`, `credits`, `trial`, `promo`, `quota`, …
- **AND a model/API signal** (`model`, `api`, `endpoint`, `tier`, …) **or a release/campaign signal** (`launch`, `limited-time`, `campaign`, `anniversary`, `black friday`, …)
- **Noise is rejected** — hiring, webinars, podcasts, giveaway spam, `feel free to …`

Only posts published in the **last 24 hours** are considered, so old posts never resurface.

### Discord slash commands

| Command | What it does |
| --- | --- |
| `/free` | Shows the current free-model lists (OpenRouter / Infron / Zen) |
| `/run` | Triggers a check right now |
| `/watch list` | Lists all watched X accounts |
| `/watch add @handle` | Adds an X account to the watch list (stored in KV) |

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) 18 or newer
- A Discord server where you can create webhooks (and optionally an application for slash commands)

## Setup — step by step

### 1. Install dependencies

```bash
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create KV
```

Copy the `id` from the output into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"
```

### 4. Set secrets

Secrets are never stored in files. Set each one with Wrangler (paste the value when prompted):

```bash
npx wrangler secret put RUN_KEY
npx wrangler secret put DISCORD_WEBHOOK_URL
```

| Secret | Required | Purpose |
| --- | --- | --- |
| `RUN_KEY` | Yes | Any long random string. Protects the manual-trigger URL (`/run?key=…`) |
| `DISCORD_WEBHOOK_URL` | Yes | Default channel webhook. Fallback for both alert types |
| `DISCORD_X_WEBHOOK_URL` | No | X-post alerts channel. Falls back to the default above |
| `DISCORD_MODELS_WEBHOOK_URL` | No | Model add/remove alerts channel. Falls back to the default above |
| `DISCORD_PUBLIC_KEY` | For slash commands | Application → General Information → Public Key |
| `DISCORD_APPLICATION_ID` | For slash commands | Application → General Information → Application ID |

> For local development (`wrangler dev`), copy `.dev.vars.example` to `.dev.vars` and fill in your values. `.dev.vars` is gitignored and never uploaded.

### 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://ai-hunter.YOURNAME.workers.dev`. From now on Cloudflare runs it at the start of every hour (UTC). To change the schedule, edit `crons` in `wrangler.toml` (cron syntax, UTC).

### 6. Test it

Open this in a browser:

```text
https://ai-hunter.YOURNAME.workers.dev/run?key=YOUR_RUN_KEY
```

**The first run never sends alerts.** It only saves a baseline. This is intentional — from the second run on, only real changes are posted.

To force a model alert (all current free models appear as "Added"):

```bash
npx wrangler kv key put --binding=KV zen_free_models '[]' --remote
```

Then open the `/run` URL again. (`free_models` and `infron_free_models` work the same way.)

To re-observe X posts:

```bash
npx wrangler kv key put --binding=KV seen_posts '[]' --remote
```

**Debugging:** run `npx wrangler tail` in one terminal, then open the `/run` URL. Errors appear in the log (e.g. Discord `404` = wrong webhook URL, `429` = rate limited).

## Slash-command setup (optional)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it (e.g. `Ai Hunter`).
2. On the **General Information** page:
   - Copy **Application ID** and **Public Key** → set them as secrets (see table above).
   - Paste your Worker URL + `/interactions` into **Interactions Endpoint URL**, e.g. `https://ai-hunter.YOURNAME.workers.dev/interactions` → **Save Changes**. (If saving fails with "could not be verified", the Public Key secret is not set yet — set it first, wait ~30 seconds, save again.)
3. Go to the **Bot** tab → **Reset Token** → copy the **Bot Token** (keep it private, never commit it).
4. Register the commands from your own terminal (the token stays in your shell only):

```powershell
$env:DISCORD_APPLICATION_ID='<app id>'; $env:DISCORD_BOT_TOKEN='<bot token>'; npm run register-commands
```

```bash
DISCORD_APPLICATION_ID='<app id>' DISCORD_BOT_TOKEN='<bot token>' npm run register-commands
```

Expected output: `Registered: /free, /run, /watch`. Global commands can take up to ~1 hour to appear in Discord.

## Configuration

All tuning lives in the `SETTINGS` section at the top of `src/index.js`:

| Setting | Purpose |
| --- | --- |
| `ACCOUNTS` | Built-in X handles (without `@`). Extra ones added via `/watch add` are stored in KV |
| `FREE_SIG` / `MODEL_SIG` / `NEW_SIG` / `NOISE_SIG` | The post-relevance signals (see "Smart X-post filter" above) |
| `INSTANCES` | Nitter/RSS instances, tried in order — they change often, update when they die |
| `POST_MAX_AGE_MS` | Max post age (default: 24 hours) |
| `BATCH` (in `checkX`) | Parallel RSS fetch batch size |

KV keys used: `free_models`, `infron_free_models`, `zen_free_models`, `seen_posts`, `extra_accounts`, `x_source_down_at`.

## Project structure

```text
ai-hunter/
  src/index.js                 Worker code (watchers + X monitor + slash commands)
  scripts/register-commands.mjs One-time Discord command registration (local only)
  wrangler.toml                Cloudflare config (cron schedule, KV binding, observability)
  package.json                 Scripts and dependencies
  .dev.vars.example            Template for local secrets (copy to .dev.vars, never commit)
  README.md
```

## Security

- **No secrets in this repo.** Webhook URLs, bot tokens, `RUN_KEY`, and the Discord public key live only in Wrangler secrets / `.dev.vars` (gitignored).
- `/run` is protected by `RUN_KEY` compared in constant time (`timingSafeEqual`).
- The interactions endpoint verifies Discord's Ed25519 signature on the raw body.
- If a webhook URL or token ever leaks (chat logs, screenshots), regenerate it in Discord and re-run the corresponding `wrangler secret put`.

## Known limitations

- **X data is the fragile part.** X has no free read API. This project uses public Nitter-style RSS instances, which are often slow or go offline. When all instances fail you get one "source down" message per day in the X channel. Find working instances (search for a Nitter-instances health tracker) and update `INSTANCES`.
- Cloudflare's free plan allows a limited number of outbound requests per run (50). The X watcher fetches accounts in parallel batches to stay well under this.
- Discord embeds hold up to 4096 characters — very long model lists are automatically split across multiple embeds.
- Scraping X via third-party mirrors is a grey area under X's terms. Use it for personal monitoring only.

## Changing things later

Edit `src/index.js` (or settings), then:

```bash
npx wrangler deploy
```
