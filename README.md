# Agent-Troy

Troy's private personal AI assistant on Telegram. Runs 24/7 on **Cloudflare Workers (free plan)** for ₱0:

- Telegram bot (grammY, webhook mode) ⇄ **Gemini** (plain REST, `gemini-2.5-flash`)
- **Memory** in Cloudflare **D1** — the bot remembers this chat across redeploys
- Owner-lock (only Troy can use it), retry-safe update dedupe, plain-text short replies

> **Current status: STEP 1 done** (skeleton: chat + memory + commands).
> Later steps (per PLAN.md): web search & notes → to-dos & reminders → documents → code runner → Gmail/Calendar.

---

## What is built right now (Step 1)

| Thing | How |
|---|---|
| Routes | `POST /webhook` (Telegram, secret-token checked) · `GET /init?secret=...` (sets the webhook + commands) · `GET /health` → `ok` |
| Memory | D1 tables `messages` + `processed_updates`, created lazily on first use (no migration step) |
| Chat | System prompt (short, casual, plain text, Asia/Manila time) + last **30** messages of the chat → Gemini → reply split into ≤ 4000-char chunks |
| Commands | `/start` · `/help` · `/reset` (forgets the chat only) · `/id` |
| Safety | Only `OWNER_ID` may chat ("Private bot." for strangers). When `OWNER_ID` is unset the bot tells anyone their user id so you can lock it. Real errors go to Cloudflare logs; you only ever see "Gemini is busy, try again in a minute." |
| Retries | Telegram retries are deduped by `update_id` — never two replies for one update |

## Project structure

```
src/index.ts      entry: routes /webhook, /init, /health
src/bot.ts        grammY bot: owner check, dedupe, commands, message handler
src/agent.ts      agent: memory -> Gemini -> save conversation
src/gemini.ts     tiny Gemini REST client (plain fetch, no SDK)
src/prompt.ts     system prompt builder (identity, current Manila time)
src/db.ts         D1 schema + typed helpers
src/telegram.ts   helpers: send messages (split long ones), typing action
wrangler.jsonc    Worker config: name, vars, D1 binding, observability
package.json      scripts: dev / deploy / typecheck
tsconfig.json
.dev.vars.example copy to .dev.vars for local secrets (never commit .dev.vars)
```

Scripts: `npm run dev` (local) · `npm run deploy` · `npm run typecheck`.

---

## Human steps (one-time setup)

> ### The short version (what to click)
> 1. Cloudflare dashboard → **Workers & Pages → Create → Workers → Import a repository** → authorize GitHub → pick `Agent-Troy` → Deploy (defaults: build `npm ci`, deploy `npx wrangler deploy`).
> 2. Open the worker → **Settings → Variables and Secrets → Add** four secrets (see table below). Save.
> 3. In the worker → **Deployments → Retry** (or push any commit) so the secrets get picked up.
> 4. Open in a browser: `https://agent-troy.<your-subdomain>.workers.dev/init?secret=<WEBHOOK_SECRET>` → you should see **"Webhook set ✅"**.
> 5. Telegram → open your bot → `/start`. It tells you your user id → add it as secret `OWNER_ID` → redeploy. Done. 🎉

### 1. Create a free Cloudflare account
Sign up at dash.cloudflare.com (email only, no credit card).

### 2. D1 database
**Already done in this repo** — `wrangler.jsonc` has the D1 binding with your database ID:

- Dashboard → **Storage & Databases → D1 SQL Database** → your database `agent_troy`
- Verify the **Database ID** on that page matches `d1_databases[0].database_id` in `wrangler.jsonc` (this repo has `197650f3-1cce-4c36-8bb4-2cdc75f005a0`). If you ever recreate the database, paste the new ID there.
- The tables are created automatically by the bot on first use — you do nothing.

### 3. Connect GitHub (auto-deploy)
Workers & Pages → **Create → Workers → Import a repository** → authorize GitHub → pick `Agent-Troy` → **Deploy**.
(Build command: `npm ci`, deploy command: `npx wrangler deploy` — the defaults usually work.)
From now on, every push to `main` redeploys the bot automatically.

### 4. Secrets
Worker → **Settings → Variables and Secrets → Add** (type: **Secret**), then save and trigger a redeploy (Deployments → ⋯ → Retry, or push a commit):

| Name | Value |
|---|---|
| `BOT_TOKEN` | Your bot token from **@BotFather** on Telegram |
| `GEMINI_API_KEY` | Your key from **aistudio.google.com → Get API key** |
| `WEBHOOK_SECRET` | Any random string, **32+ characters**. Invent one (or reuse the one in your local `.dev.vars`) and keep it — you need it for the `/init` URL below. |
| `OWNER_ID` | Your numeric Telegram user id. **Not known yet** — the bot tells you (step 6). You can leave this one for last. |

> 🔒 Never paste secrets into the code or the repo. They live only in the Cloudflare dashboard (and in your local `.dev.vars`).

### 5. Set the webhook
Open in a browser:
`https://agent-troy.<your-subdomain>.workers.dev/init?secret=<WEBHOOK_SECRET>`
You should see **"Webhook set ✅"** plus **"Commands registered ✅"**.
(`<your-subdomain>` is shown on the worker's main page, next to `workers.dev`.)
Wrong or missing secret → `403` — that is normal.

### 6. Telegram — find your id and lock the bot
Message your bot and send **`/start`**. While `OWNER_ID` is not set, anyone who messages the bot gets told their user id — send it, and the bot replies with *yours*.
Then: Worker → Settings → Variables and Secrets → add `OWNER_ID` = that number → save → redeploy.
Now the bot answers **only you**; strangers get "Private bot."

### Test it (Troy's Step-1 test)
1. `my name is Troy and I live in Davao` → ok
2. `what's my name and where do I live?` → it should answer correctly from memory
3. `/reset` → then ask again → it should **not** know anymore

### Later steps
Step 3 (reminders): nothing extra to click — the cron comes from config. Step 4 (documents): create an R2 bucket `agent-files`. Step 5: optional `GITHUB_TOKEN`. Step 6 (Gmail/Calendar): Google Cloud OAuth — detailed instructions come with that step.

### Where to look when it breaks
Worker → **Logs (Observability)** → real-time logs. Copy the red lines and paste them to the agent with the "When something breaks" prompt from PLAN.md.

---

## Local development

1. `npm ci`
2. `cp .dev.vars.example .dev.vars` and fill in your real values
3. `npm run dev` — local worker on http://127.0.0.1:8787
4. `npm run typecheck` — TypeScript check (must pass)

Note: `/init` run locally would point Telegram's webhook at `127.0.0.1` — that's only useful against a local mock. Always run `/init` against the **deployed** worker URL.
