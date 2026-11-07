// node:sqlite is Node 22+ and only needed by the local/preview adapter. It is
// required lazily so the hosted (Vercel) path, which always uses libSQL, never
// crashes on a runtime without it.
let databaseSync;
function nodeSqlite() {
  if (!databaseSync) databaseSync = require('node:sqlite').DatabaseSync;
  return databaseSync;
}
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, ign TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      suspended INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL,
      auth_method TEXT NOT NULL DEFAULT 'legacy'
    );
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id),
      item TEXT NOT NULL, category TEXT NOT NULL, quantity INTEGER NOT NULL,
      wants TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id), offer TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', buyer_done INTEGER NOT NULL DEFAULT 0,
      seller_done INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_request ON trades(listing_id,buyer_id)
      WHERE status IN ('pending','accepted');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, target INTEGER NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS discord_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), discord_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL, verified INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disputes (
      trade_id INTEGER PRIMARY KEY REFERENCES trades(id), opened_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decision TEXT, resolution TEXT,
      resolved_by INTEGER REFERENCES users(id), created INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved INTEGER
    );
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL REFERENCES disputes(trade_id),
      author INTEGER NOT NULL REFERENCES users(id), note TEXT NOT NULL, url TEXT,
      created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS trade_proposals (
      trade_id INTEGER NOT NULL REFERENCES trades(id), version INTEGER NOT NULL,
      author INTEGER NOT NULL REFERENCES users(id), terms TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(trade_id,version)
    );
    CREATE TABLE IF NOT EXISTS trade_events (
      id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL REFERENCES trades(id),
      actor INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS listing_proofs (
      listing_id INTEGER PRIMARY KEY REFERENCES listings(id),
      details TEXT NOT NULL, image BLOB NOT NULL, review_note TEXT
    );
    CREATE TABLE IF NOT EXISTS trade_snapshots (
      trade_id INTEGER PRIMARY KEY REFERENCES trades(id), terms TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_offer_items (
      trade_id INTEGER NOT NULL, version INTEGER NOT NULL, position INTEGER NOT NULL,
      details TEXT NOT NULL, image BLOB NOT NULL, submitted_by INTEGER NOT NULL REFERENCES users(id),
      created INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(trade_id,version,position),
      FOREIGN KEY(trade_id,version) REFERENCES trade_proposals(trade_id,version)
    );
    CREATE INDEX IF NOT EXISTS offer_author_time ON trade_proposals(author,created);
    CREATE TABLE IF NOT EXISTS trade_agreement_evidence (
      trade_id INTEGER NOT NULL REFERENCES trades(id), side TEXT NOT NULL, position INTEGER NOT NULL,
      image BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(trade_id,side,position)
    );
    CREATE TABLE IF NOT EXISTS trade_notification_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS listing_feed (
      listing_id INTEGER PRIMARY KEY REFERENCES listings(id),
      delivered INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
    );
    -- Phase 2: persistent notification inbox. One row per event and recipient.
    -- The UNIQUE key makes retries, double clicks, and worker restarts produce one record.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      event_key TEXT NOT NULL, event_type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, link TEXT,
      read INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(event_key, user_id)
    );
    CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id, read, id DESC);
    -- Phase 2: durable DM outbox with bounded claim/lease, bounded retries, last safe error.
    -- channel_id/embed_json extend it to deliver branded embeds to a channel (the
    -- verification audit log) in addition to opt-in user DMs.
    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id INTEGER PRIMARY KEY, event_key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
      discord_id TEXT NOT NULL, content TEXT NOT NULL, link TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, message_id TEXT,
      channel_id TEXT, embed_json TEXT,
      created INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(event_key, user_id)
    );
    CREATE INDEX IF NOT EXISTS delivery_claim ON delivery_outbox(state, next_attempt_at, lease_until);
    -- Phase 2: private exchange arrangement (server/location, optional meeting time and timezone).
    -- Player-reported; it never modifies the accepted item terms.
    CREATE TABLE IF NOT EXISTS trade_arrangements (
      trade_id INTEGER PRIMARY KEY REFERENCES trades(id),
      server TEXT NOT NULL, meeting_time TEXT, timezone TEXT,
      proposed_by INTEGER NOT NULL REFERENCES users(id),
      acknowledged_by INTEGER REFERENCES users(id),
      created INTEGER NOT NULL DEFAULT (unixepoch()),
      updated INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Phase 2: mutual cancellation requests for accepted trades.
    CREATE TABLE IF NOT EXISTS cancellation_requests (
      trade_id INTEGER PRIMARY KEY REFERENCES trades(id),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER, decided_at INTEGER,
      created INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Website-only verification policy: authoritative records scoped to a Discord
    -- user in the configured guild. Only a real website sign-in flow may create or
    -- advance them; legacy role holders are never backfilled.
    CREATE TABLE IF NOT EXISTS website_verification_records (
      id INTEGER PRIMARY KEY, discord_id TEXT NOT NULL, guild_id TEXT NOT NULL,
      state TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'discord_oauth_website',
      rules_version INTEGER NOT NULL, rules_consent_at INTEGER,
      join_timestamp INTEGER, verified_at INTEGER, fail_reason TEXT,
      eligible_at INTEGER, operation_id TEXT, created INTEGER NOT NULL DEFAULT (unixepoch()),
      updated INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(discord_id, guild_id)
    );
    CREATE INDEX IF NOT EXISTS website_verification_lookup ON website_verification_records(discord_id, guild_id);
    CREATE INDEX IF NOT EXISTS website_verification_pending ON website_verification_records(state, updated);
    -- Durable sign-in events for the verification audit channel. The unique event
    -- key prevents replays and duplicate embeds.
    CREATE TABLE IF NOT EXISTS website_signin_events (
      id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
      discord_id TEXT NOT NULL, event_type TEXT NOT NULL,
      event_ref TEXT NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `;

function openDatabase(file = path.join(__dirname, '..', 'data', 'marketplace.sqlite')) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const raw = new (nodeSqlite())(file);
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  raw.exec(schema);
  if (!raw.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'auth_method')) {
    raw.exec("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!raw.prepare('PRAGMA table_info(trades)').all().some(column => column.name === 'buyer_confirmed_at')) {
    raw.exec('ALTER TABLE trades ADD COLUMN buyer_confirmed_at INTEGER');
  }
  if (!raw.prepare('PRAGMA table_info(trades)').all().some(column => column.name === 'seller_confirmed_at')) {
    raw.exec('ALTER TABLE trades ADD COLUMN seller_confirmed_at INTEGER');
  }
  if (!raw.prepare('PRAGMA table_info(delivery_outbox)').all().some(column => column.name === 'channel_id')) {
    raw.exec('ALTER TABLE delivery_outbox ADD COLUMN channel_id TEXT');
  }
  if (!raw.prepare('PRAGMA table_info(delivery_outbox)').all().some(column => column.name === 'embed_json')) {
    raw.exec('ALTER TABLE delivery_outbox ADD COLUMN embed_json TEXT');
  }
  if (!raw.prepare('PRAGMA table_info(oauth_states)').all().some(column => column.name === 'rules_consent')) {
    raw.exec('ALTER TABLE oauth_states ADD COLUMN rules_consent INTEGER NOT NULL DEFAULT 0');
  }
  if (!raw.prepare('PRAGMA table_info(oauth_states)').all().some(column => column.name === 'rules_version')) {
    raw.exec('ALTER TABLE oauth_states ADD COLUMN rules_version INTEGER');
  }
  if (!raw.prepare('PRAGMA table_info(website_verification_records)').all().some(column => column.name === 'eligible_at')) {
    raw.exec('ALTER TABLE website_verification_records ADD COLUMN eligible_at INTEGER');
  }
  const active = new AsyncLocalStorage();
  let queue = Promise.resolve();
  function exclusive(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  const invoke = (sql, method, args) => {
    const work = () => raw.prepare(sql)[method](...args);
    return active.getStore() ? work() : exclusive(work);
  };
  return {
    prepare: sql => ({
      get: (...args) => invoke(sql, 'get', args),
      all: (...args) => invoke(sql, 'all', args),
      run: (...args) => invoke(sql, 'run', args),
    }),
    transaction: work => exclusive(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await active.run(true, work);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => raw.close(),
  };
}

async function openHostedDatabase({ url, authToken, client: suppliedClient }) {
  if (!suppliedClient && (!url || !authToken)) throw new Error('Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  const client = suppliedClient || require('@libsql/client/web').createClient({ url, authToken });
  const active = new AsyncLocalStorage();
  const execute = (sql, args) => (active.getStore() || client).execute({ sql, args });
  const db = {
    prepare: sql => ({
      get: async (...args) => (await execute(sql, args)).rows[0],
      all: async (...args) => (await execute(sql, args)).rows,
      run: async (...args) => {
        const result = await execute(sql, args);
        return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid) };
      },
    }),
    async transaction(work) {
      const tx = await client.transaction('write');
      try {
        const result = await active.run(tx, work);
        await tx.commit();
        return result;
      } catch (error) {
        if (!tx.closed) await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    },
    close: () => client.close(),
  };
  try {
    await client.batch(schema.replace(/^[\t ]*--[^\n]*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean), 'write');
    await db.transaction(async () => {
      const columns = await db.prepare('PRAGMA table_info(sessions)').all();
      if (!columns.some(column => column.name === 'auth_method')) {
        await db.prepare("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy'").run();
      }
      const tradeColumns = await db.prepare('PRAGMA table_info(trades)').all();
      if (!tradeColumns.some(column => column.name === 'buyer_confirmed_at')) {
        await db.prepare('ALTER TABLE trades ADD COLUMN buyer_confirmed_at INTEGER').run();
      }
      if (!tradeColumns.some(column => column.name === 'seller_confirmed_at')) {
        await db.prepare('ALTER TABLE trades ADD COLUMN seller_confirmed_at INTEGER').run();
      }
      const outboxColumns = await db.prepare('PRAGMA table_info(delivery_outbox)').all();
      if (!outboxColumns.some(column => column.name === 'channel_id')) {
        await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN channel_id TEXT').run();
      }
      if (!outboxColumns.some(column => column.name === 'embed_json')) {
        await db.prepare('ALTER TABLE delivery_outbox ADD COLUMN embed_json TEXT').run();
      }
      const oauthColumns = await db.prepare('PRAGMA table_info(oauth_states)').all();
      if (!oauthColumns.some(column => column.name === 'rules_consent')) {
        await db.prepare('ALTER TABLE oauth_states ADD COLUMN rules_consent INTEGER NOT NULL DEFAULT 0').run();
      }
      if (!oauthColumns.some(column => column.name === 'rules_version')) {
        await db.prepare('ALTER TABLE oauth_states ADD COLUMN rules_version INTEGER').run();
      }
      const verificationColumns = await db.prepare('PRAGMA table_info(website_verification_records)').all();
      if (!verificationColumns.some(column => column.name === 'eligible_at')) {
        await db.prepare('ALTER TABLE website_verification_records ADD COLUMN eligible_at INTEGER').run();
      }
    });
    return db;
  } catch (error) {
    client.close();
    // Tag the phase that failed so the 503 can separate an unreachable or
    // unauthorized database (bot config, wrong URL/token pair) from a schema
    // or migration problem. Transport failures surface as HTTP_* (libsql) or
    // socket errors no matter which statement tripped first.
    const transport = /^(HTTP_|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|EPIPE|fetch|network|getaddrinfo|socket)/i
      .test(String(error?.code || '') + ' ' + String(error?.message || ''));
    error.dbStage = transport ? 'database_unreachable' : error.dbStage || 'database_schema';
    throw error;
  }
}

const transaction = (db, action) => db.transaction(action);
module.exports = { openDatabase, openHostedDatabase, transaction };
