# Database backup and restore rehearsal

The marketplace keeps its state in a single Turso (libSQL) database:
accounts, sessions, Discord links, verification records, sign-in events,
delivery jobs, listings, trades, notifications. That is the one asset that a
deploy cannot reconstruct. This document is the procedure for backing it up
and — equally important — for rehearsing a restore, so the first time anyone
points the app at a recovered database is not an incident.

Related: [docs/VERIFICATION-RECOVERY.md](./VERIFICATION-RECOVERY.md) covers the
verification sweep and the authorized ops trigger this procedure complements;
`scripts/check-production.js` is the pass/fail check to run against any
database the app is pointed at, restored or not.

## What to back up

- **Production database** (Vercel env `TURSO_DATABASE_URL`, authenticated with
  `TURSO_AUTH_TOKEN`). Find the name without touching credentials:
  `turso db list` prints each database with its hostname.
- **Local preview state** (`data/marketplace.sqlite`) — optional; it only
  exists wherever the local server was run. Copy the file while the local
  server is stopped (WAL mode leaves the file consistent, but a copy made
  mid-write can still miss the last commits).

## 1. Take a dump (portable SQL text)

```bash
turso db list                       # confirm the database name and region
turso db dump <database-name> --output-file backups/$(date +%Y-%m-%d)-<database-name>.sql
```

The dump is plain SQL: `CREATE TABLE …` and `INSERT …` for every row. It is
the recommended backup format because it survives engine upgrades and can be
restored into any libSQL database. Verify it is not empty and matches the live
row counts before considering the backup good:

```bash
grep -c '^INSERT INTO' backups/<file>.sql          # rough row count
turso db shell <database-name> ".tables"           # live tables
```

Compare against the live counts with the ops roll-up (this is the same check
`scripts/check-production.js` prints, so a backup-and-check is one sequence):

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$WEBSITE_URL/api/delivery-retry?stats=1" | node scripts/check-production.js --json \
  | node -e "process.stdin.on('data',d=>{const h=JSON.parse(d).lookup?.health;console.log(h?.database?.counts)})"
```

Store the dump somewhere outside this machine (it contains Discord user IDs and
IGNs — no secrets, but personal data). Dumps are per-database history, so keep
a rotating set; a single backup tells you nothing about when a bad change landed.

## 2. Take a snapshot (fast, managed)

Snapshots are Turso's native point-in-time copies; restoring one is faster
than replaying a dump but the format is engine-specific:

```bash
turso db snapshots create <database-name>        # prints the snapshot name
turso db snapshots list <database-name>
```

Keep both: snapshots for speed within a Turso lifetime, dumps for portability
and for the case where the database itself is unreachable or deleted.

## 3. Restore rehearsal (do this on a scratch database, not production)

The only way to know a backup works is to restore it and run the app against
it. This rehearsal never touches the production database.

1. **Create a scratch database** and restore the dump into it:

   ```bash
   turso db create rehearsal-$(date +%Y%m%d)
   turso db shell rehearsal-<date> < backups/<file>.sql
   ```

   Snapshots restore instead with (confirm the verb for your CLI version —
   older releases used `turso db snapshots restore`):

   ```bash
   turso db restore rehearsal-<date> <snapshot-name>
   ```

2. **Point a local copy of the app at the scratch database** (never change
   production env to rehearse):

   ```env
   TURSO_DATABASE_URL=<scratch database URL from `turso db show rehearsal-<date> --url`>
   TURSO_AUTH_TOKEN=<scratch token from `turso db tokens create rehearsal-<date>` — paste into .env, never into chat>
   CRON_SECRET=<any value for the rehearsal run>
   ```

   `turso db show --url` and `turso db tokens create` print values for the
   scratch database only; still put them straight into `.env` (which is never
   committed) rather than sharing them.

3. **Verify the restored state as the app sees it**, with the ops sweep:

   ```bash
   node scripts/check-production.js --base http://127.0.0.1:3000
   ```

   The roll-up must report the same table counts as the live backup step, and
   the config-drift canary must be clean (the scratch database has its own
   Discord configuration checks — they read the live guild, so a restored
   database does not change the expected role/channel results).

4. **Spot-check the data the app cares about**, not only counts: sign in with a
   Discord account that has a verification record and confirm the record is
   found (`?member=<discordId>` on the sweep route shows it), or run the test
   suite against the restored database with the same env.

5. **Tear down**:

   ```bash
   turso db destroy rehearsal-<date>
   ```

A rehearsal that passes all four checks is the evidence that a real restore
will be a known drill (minutes, with a checklist) instead of an unknown one.

## Restore into production (incident use)

1. Announce the window: sign-ins during the restore can write to the old state
   and be lost. Vercel requests are short-lived, so a restore under a minute
   loses at most in-flight requests.
2. Prefer restoring a **snapshot in place** (`turso db restore <database>
   <snapshot>`) when the database still exists — fastest, same identity, no env
   change. If the database is gone or the platform account is inaccessible,
   create a replacement database, restore the dump into it, and update the
   production `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` env vars (then redeploy
   so the app picks them up).
3. Immediately after, run the checks:
   `node scripts/check-production.js` — the roll-up's database counts,
   heartbeats, and drift canary are the post-restore acceptance gate.
4. Record the incident: which backup, what was lost between the backup and the
   failure, and what the sweep recovered on its own (see
   VERIFICATION-RECOVERY.md — interrupted verifications are designed to
   complete themselves after a restore, so manual fixups should be the
   exception).

## Rhythm

- A dump after every /setup-driven configuration change and at least weekly;
  snapshot before any manual database operation.
- A restore rehearsal after any schema migration or Turso CLI upgrade — the two
  events that silently break a backup procedure.
- `node scripts/check-production.js` on demand; it is also the fastest way to
  confirm the app and the database agree after any deployment.
