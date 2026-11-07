# Deployment and operations

## Environment variables (names only — never paste real values into Git or docs)

Copy `.env.example` and fill these on the hosting providers:

| Variable | Where | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | bot host | Bot login + REST (also used by the website for authoritative member/role fetches when hosted with the same env) |
| `GUILD_ID` | both | The single configured guild (17–20 digit snowflake) |
| `DEVELOPER_USER_ID` | bot host | Optional developer role + staff authorization |
| `APPLY_BANNER` | bot host | `true` only, to upload a ≥960×540 16:9 banner when the guild supports it |
| `WEBSITE_URL` | both | Public base URL of the website: verification link in Discord panels/greetings and sign-in embed links; required for website-only verification |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | website host | OAuth2 client |
| `DISCORD_REDIRECT_URI` | website host | Exact HTTPS callback: `https://<your-preview>/api/discord/callback` |
| `DISCORD_ADMIN_USER_IDS` | website host | Comma-separated admin user IDs |
| `DISCORD_VERIFIED_ROLE_ID` | website host | Optional override; default uses the role saved by bot setup |
| `DISCORD_VERIFICATION_LOG_CHANNEL_ID` | website host | Optional staff audit channel for sign-in embeds; default: the 🔐│verification channel saved by bot setup. Validated against the guild |
| `RULES_VERSION` | both | Optional integer; bumping forces members to re-accept the current rules on their next sign-in |
| `DISCORD_TRADE_FEED_CHANNEL_ID`, `DISCORD_TRADE_RADAR_ROLE_ID` | website host | Needed when the website host does not share the bot's setup data |
| `INTERNAL_WORKER_SECRET` | both | Optional shared secret for the bot delivery worker |
| `TRADE_HUB_URL` | bot host | Public base URL of the website (worker only) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | website host | Hosted libSQL |
| `CRON_SECRET` | website host | Protects `/api/feed-retry` and `/api/delivery-retry` |

## Website-only verification policy

- The old Discord "Accept rules & verify" button and the `/verify` command no
  longer grant anything. The bot answers both with a redirect to the website,
  and setup reruns cannot recreate the button (`verificationComponents()` is
  empty). Welcome, FAQ, rules, and verification panels link to
  `{WEBSITE_URL}/#verify`.
- The flow: read + accept the rules on the website → **Sign in with Discord**
  (consent is bound to the single-use OAuth state) → the website checks
  eligibility with the bot token (account ≥24h, guild membership ≥10min,
  screening complete, not a bot, no timeout, no marketplace suspension), grants
  **Verified Member** idempotently after role/hierarchy safety checks, and
  writes the authoritative `website_verification_records` row.
- Sign-in embeds go to the staff audit channel as durable outbox jobs with the
  same claim/lease/retry guarantees as trade DMs. Exactly one embed per event;
  failures never break the sign-in.
- Protected actions (list, offer, accept, counter) require a verified record
  **and** current Discord-side eligibility. Legacy role holders have no bypass;
  they complete the same website flow. No history is ever fabricated for them.
- Owner migration tools: `GET /api/admin/verification-report` (dry-run
  classification) and `POST /api/admin/verification-cutover` with the typed
  confirmation phrase `Remove legacy roles`. Bulk role removal is never an
  automatic side effect of any setup or deployment step.

## Website (Vercel)

1. Create the project from this directory. Build command and output are already
   set in `vercel.json` (`npm run web:build:vercel`, output `website/dist`).
   All `/api/*` traffic is rewritten to the single serverless function
   `api/marketplace.js` (60s max duration) — the gateway process never lives in
   a request handler.
2. Create a Turso database; set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`.
   Migrations are additive and repeat-safe; initialization runs on first
   request. **Never point this build at the original production database.**
3. Set the Discord OAuth redirect URI in the Discord application to the exact
   preview URL before enabling sign-in; `configuredDiscord()` validates it.
4. Crons: `/api/feed-retry` (daily) and `/api/delivery-retry` (4×/day) are
   protected by `CRON_SECRET`. Vercel's minimum cron interval is daily; for
   faster retries, run the bot worker below. Do not assume minute-by-minute
   cron on the current plan.
5. Fill `DISCORD_TRADE_FEED_CHANNEL_ID`/`DISCORD_TRADE_RADAR_ROLE_ID` on the
   website host (the bot's `data/` setup state is not shared with Vercel).

Local alternative: `npm run web` (SQLite at `data/marketplace.sqlite`).

## Bot (Pterodactyl)

1. Copy this repository to the Pterodactyl server (or mount it as a git deploy).
2. `npm ci --omit=dev` then `npm start` (`src/bot.js`). Node 22+.
3. Provide `DISCORD_TOKEN`, `GUILD_ID`, optionally `DEVELOPER_USER_ID`, and
   `WEBSITE_URL` (the verification link is published into the welcome/FAQ/rules
   and verification panels).
4. Slash commands upsert on startup (guild-scoped); `npm run commands:register`
   is optional. `/verify` is retired: it and the legacy button only redirect to
   the website's verification page.
5. Owner runs `/setup` in the isolated comparison guild. `plan`/`check` modes
   validate permissions without mutating; `rebuild:true` is destructive and
   explains message loss. Untracked same-name resources abort before mutation.
   The 🔐│verification channel is created staff-only as the sign-in audit log;
   reruns recreate no grant button.
6. Optional continuous delivery worker: set `TRADE_HUB_URL` and
   `INTERNAL_WORKER_SECRET` (the same value as on the website). The worker
   polls `GET /api/delivery-work`, claims leased jobs, DMs recipients, and
   reports outcomes. A lost report simply lets the lease expire so another pass
   can retry — no state is lost.
7. Restart recovery: guild setup state, verification records, invite snapshot,
   and giveaway draws are persisted in `data/`; the bot reconciles on start.

## Backup and restore (records + evidence together)

- Back up the Turso database (`turso db shell … .dump` or platform snapshots)
  **and** note that all evidence lives inside the database as normalized WebP
  blobs (`listing_proofs`, `trade_offer_items`, `trade_agreement_evidence`), so
  a database restore restores the evidence too. Accepted agreements and their
  images are never purged as routine cleanup.
- Bot state: `data/guild-<id>.json` (setup, including the published website
  URL), `data/community-<id>.json` (greetings, invites, giveaways).
  `data/backup-*.json` snapshots are written by every `/setup` apply run. To
  restore, replace the files and restart the bot; the setup state validates
  guild/bot ownership before use.
- Rate of restores: test restores on a copy first (the migration tests double
  initializations on both adapters to prove repeat-safety).

## Honest notes on delivery guarantees

- Discord cannot guarantee exactly-once delivery across every crash window.
  This build minimizes duplicates through stable event keys, message nonces
  (feed), and job leases, and reconciles ambiguous outcomes where possible.
  The **notification inbox is the durable source of truth**; DMs are a
  best-effort convenience layered on top.
- The internal worker endpoint only exposes job content and delivery state —
  never credentials or private evidence.

## Release checklist (before calling it production ready)

1. All items in "Remaining manual release gates" in `docs/FEATURE-PARITY.md`.
2. Owner confirms the comparison deployment URL, Turso database, Discord
   application credentials, and the isolated guild IDs.
3. Two-account end-to-end run including the manual in-game exchange.
4. Backup procedure exercised once on the comparison database.
