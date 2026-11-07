# BananaTrade — BananaSMP Trading Hub (remake, Phase 2 complete)

A Minecraft Java item marketplace for Rare and P2W items with Discord-only
authentication, structured offers with evidence, an immutable accepted-agreement
record, staff review and disputes, a companion Discord community bot, and the
full Phase 2 layer: persistent notification inbox, durable DM delivery, live
trade updates, explicit receipts with exchange arrangements, and mutual
cancellation.

This is the **remake**. It lives in this directory only and never touches the
original workspace at `C:/Users/admin/Documents/BananaSMP Trading Hub`, its
production data, its deployment, or its Discord server.

## Stack

- **Website**: Node.js API (single Vercel function), React 19 islands bundled
  with esbuild, Tailwind v4 for the island components, hand-written CSS for the
  shell, TypeScript for `components/ui` and `website/frontend`.
- **Data**: local SQLite (`node:sqlite`) for development, Turso/libSQL for
  hosted production. Both adapters are exercised by the test suite.
- **Bot**: discord.js v14 CommonJS service, separately hosted (Pterodactyl).
- **Image handling**: Sharp (decode, normalize, strip metadata, WebP output).
- Node 22+ required; Node 24 recommended for the website.

## Layout

```
api/marketplace.js         Vercel entry; rewrites /api/* to the shared handler
website/
  server.js                API + static shell (auth, listings, trades, Phase 2)
  db.js                    schema + additive migrations, SQLite + libSQL adapters
  discord.js               OAuth config, identity, member checks, DM + feed senders
  listing-proof.js         listing validation + screenshot normalization
  trade-offers.js          structured offer validation, saving, history
  minecraft-skins.js       same-origin Java skin proxy (bounded, cached)
  notifications.js         Phase 2 inbox store
  outbox.js                Phase 2 durable DM outbox (claims/leases/backoff)
  catalog.js               the Rare/P2W reference catalog (choices, not listings)
  public/                  index.html, style.css, app.js (client entry), sprites
  frontend/                React islands + trade-room renderer + spotlight.css
components/ui/             flow-button, spotlight-card, text-block-animation,
                           circular-navigation (+ demo files, type-checked only)
src/                       the Discord bot (setup, community, emojis, worker)
scripts/                   live-check (bot), probe (local HTTP smoke)
test/                      the whole suite
docs/                      parity matrix, comparison, deployment, operations
```

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Type check | `npm run typecheck` (or `npx tsc`) |
| Build the website | `npm run web:build` |
| Run the website locally | `npm run web` (port 3000, or `WEB_PORT=3123`) |
| Run every test | `npm test` |
| Bot planning / checking / setup | `npm run plan` / `npm run check` / `npm run setup` |
| Start the bot | `npm start` |
| Register slash commands | `npm run commands:register` |
| Local smoke check of the website | `node scripts/probe.js` (start the site first) |
| Bot live integration check | `node scripts/live-check.js` (needs live credentials) |

## Honesty rules this build enforces

- **No dummy listings or fabricated activity anywhere.** Marketplace cards come
  only from genuine approved rows in the database. With none, the page shows
  "No approved listings yet" and an appropriate sign-in or submission action.
  The reference project's example-card fallback is deliberately gone.
- Empty, no-match, loading, and failed-request states are distinct; a service
  error never masquerades as an empty marketplace.
- Catalog entries (Elytra, Nether star, …) are reference choices in forms, never
  listings.
- Verification is **website-only**: members read and accept the rules on the
  site, sign in with Discord, and the bot grants Verified Member after
  authoritative eligibility checks. The old Discord button and `/verify` no
  longer grant anything. Every sign-in is audit-logged to the staff
  🔐│verification channel. IGNs are self-reported. Skins, Premium/Cracked
  roles, and staff review of evidence never prove Minecraft ownership.
- The website cannot move items, hold escrow, or verify delivery. Receipts are
  player-reported acknowledgements.

See `docs/FEATURE-PARITY.md` for the complete capability matrix and
`docs/COMPARISON-GUIDE.md` for how this build differs from the original.
