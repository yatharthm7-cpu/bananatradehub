const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function verifyMigration(file, driver) {
  const assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const { openDatabase, openHostedDatabase } = require(require('node:path').join(process.cwd(), 'website', 'db'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = driver === 'SQLite' ? openDatabase(file) : await openHostedDatabase({ client: require('@libsql/client').createClient({ url: pathToFileURL(file).href }) });
    try {
      assert.equal((await db.prepare('SELECT terms FROM trade_snapshots WHERE trade_id=1').get()).terms, JSON.stringify({ item: 'Elytra', offer: 'Original accepted offer', version: 0 }));
      assert.equal((await db.prepare('SELECT ign FROM users WHERE id=1').get()).ign, 'OldSeller');
      assert.equal((await db.prepare('SELECT auth_method FROM sessions').get()).auth_method, 'legacy');
      assert.equal((await db.prepare('SELECT count(*) AS total FROM trade_offer_items').get()).total, 0);
      assert.equal((await db.prepare('SELECT count(*) AS total FROM trade_agreement_evidence').get()).total, 0);
    } finally { db.close(); }
  }
}

for (const driver of ['SQLite', 'Turso']) {
  test(`${driver}: additive initialization preserves legacy records across repeated migrations`, async t => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-setup-migration-'));
    const file = path.join(directory, 'legacy.sqlite');
    t.after(() => {
      assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep));
      for (const name of ['legacy.sqlite', 'legacy.sqlite-wal', 'legacy.sqlite-shm']) {
        const target = path.join(directory, name); if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      fs.rmdirSync(directory);
    });
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE,ign TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',suspended INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE listings(id INTEGER PRIMARY KEY,seller_id INTEGER NOT NULL,item TEXT NOT NULL,category TEXT NOT NULL,quantity INTEGER NOT NULL,wants TEXT NOT NULL,notes TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE trades(id INTEGER PRIMARY KEY,listing_id INTEGER NOT NULL,buyer_id INTEGER NOT NULL,offer TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',buyer_done INTEGER NOT NULL DEFAULT 0,seller_done INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE trade_snapshots(trade_id INTEGER PRIMARY KEY,terms TEXT NOT NULL);
      INSERT INTO users VALUES(1,'discord:seller','OldSeller','','member',0),(2,'discord:buyer','OldBuyer','','member',0);
      INSERT INTO sessions VALUES('old-token',1,9999999999);
      INSERT INTO listings(id,seller_id,item,category,quantity,wants,notes,status) VALUES(1,1,'Elytra','Rare',1,'Old terms','','reserved');
      INSERT INTO trades(id,listing_id,buyer_id,offer,status) VALUES(1,1,2,'Original accepted offer','accepted');`);
    const accepted = JSON.stringify({ item: 'Elytra', offer: 'Original accepted offer', version: 0 });
    raw.prepare('INSERT INTO trade_snapshots VALUES(1,?)').run(accepted); raw.close();
    // The native libSQL driver can retain Windows file handles until process exit.
    if (driver === 'Turso') require('node:child_process').execFileSync(process.execPath, ['-e',
      `(${verifyMigration.toString()})(${JSON.stringify(file)}, 'Turso').catch(error => { console.error(error); process.exitCode=1; })`], { cwd: process.cwd(), timeout: 30000 });
    else await verifyMigration(file, driver);
  });
}
