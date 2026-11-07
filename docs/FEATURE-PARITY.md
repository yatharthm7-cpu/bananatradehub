# Feature-parity matrix

Columns: **Baseline** (was it reproduced?), **Phase 2** (new work implemented?),
**Evidence / test result**. Tests are the `node --test` suite in `test/` unless
noted; "manual" means a documented human check.

## 1. Brand and interface

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Official logo in header/favicon, banner in hero | ✔ reproduced | — | assets present; `/logo.png` `image/png`, `/banner.png` served (startup probe; browser DOM shows hero banner `naturalWidth>0`) |
| Black/grey surfaces, purple/pink accents, responsive cards | ✔ reproduced | — | browser inspection at 1280px and 390px: no horizontal overflow, header wraps, hero adapts |
| Pointer spotlight/glow cards, touch skip, reduced-motion | ✔ reproduced | — | `spotlight-card.tsx` skips touch pointers; reduced-motion CSS hides overlays; keyboard focus colors card border (`:focus-within`) |
| Flow Buttons (sliding arrows, fill, focus, reduced motion) | ✔ reproduced | — | `components/ui/flow-button.tsx` + CSS; type-checked, bundled; reduced-motion fallback in `spotlight.css` |
| TextBlockAnimation (blockColor, scroll, delay, duration, stagger) | ✔ reproduced | — | `components/ui/text-block-animation.tsx`: WAAPI + IntersectionObserver, `matchMedia` cancel, CSS fallback; visible without JS |
| Circular Explore navigation (modal, focus trap, arrows, Escape, scroll lock) | ✔ reproduced | — | browser check: 5 links for anonymous (no Admin), arrow-key focus moves, Escape closes and restores focus, body locked, backdrop rendered |
| Real destinations incl. Admin only for admins | ✔ reproduced | — | browser check: no Admin entry when signed out; server 403s `/api/admin` regardless |
| Loading / empty / validation / permission / closed / disputed states | ✔ reproduced | extended | `test/phase2-flows.test.js` (empty marketplace), marketplace tests (error paths), trade room states |
| **Honest empty marketplace (no example cards)** | n/a — original had fallback | ✔ implemented | `test/phase2-flows.test.js` "empty marketplace stays honest": `/api/listings` `[]`, bundle contains `No approved listings yet`, no `View example`, no `sample:` |

## 2. Authentication and identity

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Discord-only OAuth, exact callback path, single-use state, nonce cookie | ✔ reproduced | — | `test/marketplace.test.js`: forged cookie 403, consumed state 403, redirect targets per role |
| Session cookies HttpOnly/SameSite, Secure when HTTPS | ✔ reproduced | — | marketplace test asserts `Secure` presence equals the driver flag |
| Server-validated, revocable sessions; suspension kills sessions | ✔ reproduced | — | marketplace test: suspended member's session reports `user: null` |
| Admin allowlist by Discord user ID; name matching grants nothing | ✔ reproduced | — | admin checks use `adminIds` set from env only |
| Live Verified Member role / screening / timeout rechecks, fail closed | ✔ reproduced | extended | trade-offers acceptance tests: revoked member 403, Discord failure 503, mid-acceptance suspension 403 |
| **Website-only verification (no Discord button or /verify grant)** | intentional deviation | ✔ implemented | `test/verification.test.js`: rules-consent-bound login, authoritative eligibility, verified record + role grant, replay rejected, redirect-only bot handler `test/community.test.js` |
| **Professional sign-in audit embeds in the staff verification channel** | — | ✔ implemented | `verification.signInEmbed` + outbox channel jobs: pending/completed/sign-in event types, one durable embed per event, no secrets/mentions, channel validated against the guild |
| **Owner migration report (dry-run) + explicit legacy role cutover** | — | ✔ implemented | `test/verification.test.js`: report classifies keep/repair/remove, cutover needs the typed phrase and only removes legacy roles |
| IGN required before trading, format validated | ✔ reproduced | — | `/api/profile` pattern checks; `/api/listings` 409 without IGN |
| Same-origin bounded skin proxy with logo fallback | ✔ reproduced | — | `test/minecraft-skins.test.js` (4 tests, both adapters covered): UUID resolution, caching, 400/404/503, no session creation |
| Skin display never implies ownership | ✔ reproduced | — | UI copy + `test/minecraft-skins.test.js` "no sign-in path" |

## 3. Listings and the nine-slot rule

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Rare/P2W only; structured details; compulsory screenshot | ✔ reproduced | — | `test/trade-offers.test.js` rejects wrong category, missing screenshot, >3 items |
| Server-side image validation (PNG/JPEG/WebP, ≤2 MiB, ≥320×180, still) | ✔ reproduced | — | `website/listing-proof.js` + trade-offers tests with synthesized Sharp PNGs |
| Staff review before publication; rejection reason; seller cannot self-approve | ✔ reproduced | + seller notification | marketplace tests: approve needs `proofReviewed`, self-approve 403; `test/notifications.test.js` covers listing-approved/rejected inbox rows |
| Nine-slot rule, transactional | ✔ reproduced | — | marketplace test fills to 9, 10th 409, withdraw frees a slot |
| Slot rules on hide/restore and suspension | ✔ reproduced | — | marketplace tests: hide/restore, suspension removes public listings |
| Search/category/enchantment filters, sort, deep links | ✔ reproduced | — | client filter logic in `website/public/app.js`; `?listing=<id>` deep link handled |
| Public screenshots prominent; evidence private when not public | ✔ reproduced | — | marketplace + trade-offers tests: anonymous 404 on pending screenshots |
| Trade Radar announcement on approval only, whitelisted mention | ✔ reproduced | — | marketplace test: no feed post while pending; exactly one post on approval (nonce + role allowlist in `discord.js`) |
| Durable feed queue with claims, retries, concurrency guard | ✔ reproduced | — | `listing_feed` + `flushListingFeed` claim/lease; `/api/feed-retry` cron protected (403 without `CRON_SECRET`) |

## 4. Structured offers and negotiation

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| 1–3 Rare/P2W items per proposal, quantity/attributes/origin/notes | ✔ reproduced | — | trade-offers tests |
| Combined source and stored bytes ≤ 2 MiB; 2,820,000-byte request cap | ✔ reproduced | — | trade-offers tests (700×500 PNG pair rejected) |
| Immutable numbered revisions; only the other participant responds | ✔ reproduced | — | counteroffer tests: buyer countering own version 409; latest-only response |
| Evidence reuse rules (same trade, same facts, equal/lower quantity) | ✔ reproduced | — | trade-offers: reuse with quantity increase or changed facts 400; unchanged reuse succeeds; submitter identity preserved |
| 20 proposals/author/minute, 50-counteroffer ceiling | ✔ reproduced | — | `website/trade-offers.js` rate limit; counteroffer ceiling in server |
| Pending duplicates blocked | ✔ reproduced | — | duplicate request 409 (unique partial index `one_live_request`) |
| Private evidence access (participants + staff only) | ✔ reproduced | — | offer/agreement screenshot tests: 404 for outsider and anonymous |
| Legacy text-only offers require structured evidence before acceptance | ✔ reproduced | — | trade-offers legacy test: `requiresEvidence`, accept 409 until counteroffer |
| **Notifications for offers/counteroffers/accept/decline** | — | ✔ implemented | `test/notifications.test.js`: recipient-scoped rows, unread isolation, transactional creation |
| **Trade DMs routed through the durable outbox** | — | ✔ implemented | outbox tests: queued with DM opt-in, flushed by cron/worker, no duplicates |

## 5. Acceptance, agreements, disputes

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Acceptance requires explicit review confirmation + current version | ✔ reproduced | — | accept tests: `agreementReviewed` required, stale version 409 |
| Accept eligibility fail-closed (both players, live check) | ✔ reproduced | — | trade-offers acceptance tests |
| Atomic reservation; exactly one of two competing acceptances wins | ✔ reproduced | — | competing acceptance test: `[200, 409]`, one `accepted`, one snapshot |
| Immutable agreement (schemaVersion 2): both sides, IGNs, hashes, frozen images | ✔ reproduced | — | competing acceptance test: later DB mutations leave served snapshot byte-identical; sha256 verified |
| Competing requests closed with a recorded reason | ✔ reproduced | + notifications | event label; closed-request inbox row in `test/notifications.test.js` |
| Confirmed trades cannot be moderated, hidden, or un-reserved | ✔ reproduced | — | marketplace post-acceptance assertions |
| Disputes: participants only, pause actions, evidence, staff-only resolve, conflict-of-interest | ✔ reproduced | — | dispute tests: outsider 404, confirm-while-disputed 409, self-resolve 403, admin resume → confirm → complete |
| **Receipts: "I received the agreed items."** | — | ✔ implemented | `test/phase2-flows.test.js`: per-side timestamps recorded, idempotent repeats, completion exactly once, both notified |
| **Exchange arrangements (server/location, meeting time, timezone)** | — | ✔ implemented | arrangement tests: author identified, acknowledgement required, changes reset ack and never touch terms |
| **Mutual cancellation (request/agree/decline/withdraw)** | — | ✔ implemented | `test/mutual-cancellation.test.js` (7 scenarios × 2 adapters): races, receipts force dispute, admin has no bypass |

## 6. Discord bot

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Separately hosted discord.js service with restart recovery | ✔ reproduced | — | `src/bot.js` loads state, validates bot/guild ownership, 15s recovery loop |
| `/setup` owner-only, idempotent, untracked-resource protection, rebuild:true | ✔ reproduced | — | `test/setup.test.js`, `test/setup-command.test.js`: rerun zero extra posts, lock release, "already running" |
| 14 roles / 21 channels / 5 categories; hierarchy bot > Owner > … > Verified | ✔ reproduced | — | `test/blueprint.test.js`, `test/setup.test.js` position normalization |
| Nine self-service roles; Trade Radar needs verification; zero authority preference roles | ✔ reproduced | — | blueprint tests: no Administrator anywhere, Developer has no moderation bits |
| Verification: 24h account, 10min membership, screening, no timeout, bots denied | ✔ reproduced | extended | `test/verification.test.js` (authoritative bot-REST checks on the website); `test/community.test.js` redirect-only verify |
| /greet, /invites, /giveaway, /poll, /embed, /container, /bot-status | ✔ reproduced | — | `test/community.test.js` (11 tests): attribution ambiguity, persisted draws, reroll exclusion, V2 container flags, mass-mention suppression |
| /emoji-import with source validation, readback, collision refusal | ✔ reproduced | — | `test/import-emoji.test.js`, `test/slash-command.test.js` |
| Guild-scoped command registration (10 commands, no bulk overwrite) | ✔ reproduced | — | `test/slash-command.test.js` registration test (`/verify` retired) |
| Welcome/FAQ/rules panels point to the website verification page; `{WEBSITE_URL}` placeholder | intentional deviation | ✔ implemented | `test/community.test.js` welcome test routes to `/#verify`; `test/blueprint.test.js` copy; `test/setup.test.js` |
| 🔐│verification channel is staff-only by default; setup reruns recreate no grant button | intentional deviation | ✔ implemented | `test/setup.test.js` readback: staff overwrites on the channel, `verificationComponents()` is empty |
| **Delivery worker for the website's outbox** | — | ✔ implemented | `src/delivery-worker.js` + `/api/delivery-work` protocol (claim/report) verified in `test/notifications.test.js` |

## 7. Security, data, operations

| Capability | Baseline | Phase 2 | Evidence / test result |
|---|---|---|---|
| Parameterized SQL, transactions for invariants, both adapters | ✔ reproduced | — | all tests run on SQLite **and** libSQL (`file::memory:`) |
| Bounded requests, origin checks, rate limits, short-lived OAuth state | ✔ reproduced | — | marketplace tests: origin 403, brute-force limiter, body caps |
| Sanitized rendering, no mass mentions | ✔ reproduced | — | all templates escape server strings; `allowedMentions.parse=[]` everywhere |
| Additive, repeat-safe migrations; legacy preserved | ✔ reproduced | — | `test/marketplace-migrations.test.js` (both adapters; double migration) |
| Secrets outside Git/client; env names only in docs | ✔ reproduced | — | `.env.example` lists names; no values; `.vercelignore`/`.gitignore` |
| **Persistent notification inbox surviving restarts** | — | ✔ implemented | inbox rows in the database; `test/notifications.test.js` durability tests |
| **Durable DM delivery with leases, backoff, permanent-stop** | — | ✔ implemented | outbox tests: transient→failed/backoff, permanent→no retry storm, lease prevents double-send, worker protocol |
| **Visibility-aware polling with backoff and draft preservation** | — | ✔ implemented | client module in `website/public/app.js`; version endpoint covered in `test/phase2-flows.test.js` |

## Verification actually run

- `npx tsc` — clean.
- `npm run web:build` — esbuild bundle 283.5 KB + Tailwind output.
- `npm test` — **106 tests passing** (48 baseline parity carried over, 41 Phase 2,
  12 website-only verification; every database-backed suite runs on both SQLite
  and libSQL).
- Local startup check: the site serves `/`, `/admin`, `/api/listings` (`[]`),
  `/api/session`, protected endpoints 401/403, unknown route 404.
- Browser inspection (ZCode in-app browser): rendered shell, honest empty state,
  circular navigation keyboard/Escape/focus behavior, mobile 390px layout, no
  console errors, `#verify` page renders rules + gated sign-in and enables the
  button on consent.

### Remaining manual release gates (honest, cannot be automated here)

1. **Live Discord integration** — needs two real Discord accounts and an
   isolated authorized guild: genuine listing + screenshot upload, admin
   approval, offer, counteroffer, latest-version acceptance, reservation, saved
   agreement, manual Minecraft exchange (the in-game step is by nature manual),
   both receipts, notifications, and a dispute/cancellation scenario; plus a
   real unverified member completing the website-only flow and the audit embed
   appearing in the staff `🔐│verification` channel.
2. **Browser file upload** — the in-app browser cannot perform real file
   chooser uploads; the upload path is covered by API-level tests with real
   synthesized PNG bytes, and manual upload remains a pre-release check.
3. **Service setup by the owner** — Vercel project + Turso database creation,
   Pterodactyl bot process, Discord application credentials, the isolated
   comparison guild, and `WEBSITE_URL` (see `docs/DEPLOYMENT.md`).
4. **Production data migration** — intentionally not performed; the comparison
   build starts from an honest empty database and must never connect to the
   original production data without a separate authorized migration plan.
5. **Legacy Verified Member cutover** — by design an explicit owner action:
   review `GET /api/admin/verification-report`, then run the typed-phrase
   `POST /api/admin/verification-cutover` after informing members. No
   automatic bulk role removal exists anywhere in the deployment.
