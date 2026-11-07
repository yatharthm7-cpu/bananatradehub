# Comparison guide: this remake vs. the original

Reference: https://bananatradehub.vercel.app/ · original repo:
`github.com/yatharthm7-cpu/BananaTrade` · original workspace (preserved, read
only): `C:/Users/admin/Documents/BananaSMP Trading Hub`.

## Method

The original source in the workspace was used as parity evidence. The remake
reproduces its behavior on the same stack (Node API + esbuild React islands +
SQLite/Turso + discord.js) and adds the Phase 2 layer from the specification.
The original application, its production data, its deployment, and its Discord
server were never modified.

## Route compatibility

All baseline routes keep their names, methods, and bodies, so existing clients
and bookmarks keep working. New routes are additive only.

| Route | Baseline | Status |
|---|---|---|
| `GET /api/session` | ✔ | same, plus `unread` count |
| `GET/POST /api/listings`, `GET /api/listings/:id` | ✔ | same |
| `POST /api/listings/:id/{request,withdraw,hide,restore,approve,reject}` | ✔ | same |
| `GET /api/listings/:id/screenshot` | ✔ | same |
| `GET /api/trades/:id`, `GET /api/disputes/:id` | ✔ | same, plus `cancellation`/`arrangement` payloads |
| `POST /api/trades/:id/{accept,decline,counter,cancel,confirm,moderate}` | ✔ | `confirm` semantics strengthened (see below) |
| `GET /api/trades/:id/proposals/:v/items/:p/screenshot` | ✔ | same |
| `GET /api/trades/:id/agreement/:side/:p/screenshot` | ✔ | same |
| `POST /api/profile`, `/api/preferences/trade-notifications`, `/api/logout` | ✔ | same |
| `POST /api/admin/users/:id/{suspend,reinstate}` | ✔ | same |
| `GET /api/feed-retry` (cron) | ✔ | same |
| `GET /api/minecraft/:ign/{avatar,body}` | ✔ | same |
| `GET /api/notifications`, `/api/notifications/count` | new | Phase 2 inbox |
| `POST /api/notifications/:id/read`, `/api/notifications/read-all` | new | Phase 2 inbox |
| `GET /api/trades/:id/version` | new | lightweight change check for live updates |
| `POST /api/trades/:id/arrangement`, `/api/trades/:id/arrangement/ack` | new | Phase 2 arrangements |
| `POST /api/trades/:id/cancel-request[/:decision]` | new | Phase 2 mutual cancellation |
| `GET /api/delivery-retry` (cron), `GET/POST /api/delivery-work` (worker) | new | Phase 2 durable delivery |
| `POST /api/discord/login` | ✔ | same URL, now requires rules consent (`accepted`, `rulesVersion`) |
| `POST /api/verify/refresh` | new | bounded verification status re-check / pending grant completion |
| `GET /api/admin/verification-report` | new | dry-run legacy role migration report |
| `POST /api/admin/verification-cutover` | new | explicit owner-reviewed legacy role removal |
| `#verify` (page route) | new | rules acceptance + sign-in with Discord + verification status |

## Intentional deviations from the original

1. **No sample/example cards (spec §2 absolute rule).** The original showed
   three labelled example cards when the marketplace was empty and labelled the
   button "View example". The remake removes the fallback entirely: zero
   approved listings renders "No approved listings yet" with a sign-in or
   submission action. `test/phase2-flows.test.js` pins this.
2. **Accepted-trade cancellation is mutual or via dispute (spec §16).** The
   original allowed an admin to `POST /api/trades/:id/moderate` an accepted
   trade with no receipts, cancelling and reopening the listing. The remake
   refuses that route for accepted trades ("use the mutual cancellation request
   or dispute review") so no ordinary route bypasses the safeguards, and an
   agreed mutual cancellation withdraws the listing instead of republishing
   potentially outdated inventory. Pending trades, dispute resolution, hide, and
   suspension behavior are unchanged.
3. **Trade DMs are durable.** The original sent trade DMs best-effort directly
   at request time. The remake writes outbox rows inside the business event
   transaction and delivers through the outbox (Vercel background attempt +
   cron retry + optional Pterodactyl bot worker). Consent
   (`trade_notification_preferences`) is unchanged, and the inbox always works
   even when DMs are blocked or disabled.
4. **Receipt wording.** The original called confirmation "Confirm in-game
   exchange". The remake requires the explicit "I received the agreed items."
   acknowledgement against the immutable agreement's expected received items,
   stores per-participant timestamps, and shows both states.
5. **Cron schedule.** The original ran one daily feed retry. The remake keeps
   that and adds four daily delivery retries (`/api/delivery-retry`), since the
   hosting plan's minimum cron interval is daily — the bot worker is the
   continuous path when low latency is wanted.
6. **Verification moved to the website (spec priorities 1–3).** The original
   granted Verified Member from a Discord button or `/verify`. The remake
   disables both (redirect-only) and routes members to `/#verify`: rules
   acceptance is bound to the single-use OAuth state, eligibility is checked
   with authoritative bot-REST data (24h account, 10min membership, screening,
   no timeout, no suspension), the role is granted idempotently after
   hierarchy/managed checks, and every sign-in writes a verified record plus a
   durable audit embed in the staff 🔐│verification channel. Protected actions
   need the record *and* live eligibility; legacy role holders have no bypass,
   and bulk role removal is an explicit owner action via
   `/api/admin/verification-cutover`.

## Unverified parity assumptions

- The original's production Vercel/Turso deployment was not inspected; the
  remake's hosted path is configured from the same documented environment
  variables and verified locally.
- Exact production latency/rate-limit behavior of Discord APIs can only be
  validated in the manual live-integration gate.
