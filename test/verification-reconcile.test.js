// Durable reconciliation of interrupted verifications: the crash window
// between the Discord role grant and the persisted completion is recovered by
// the cron-triggered sweep — with no second request from the member — and is
// idempotent (no duplicate completed events, grants, or deliveries).
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../website/db');
const verification = require('../website/verification');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const BOT = '888000000000000001';
const BOT_ROLE = '888000000000000002';
const MEMBER_ID = '777000000000000001';
const LOG = '888888888888888888';
const OPID = 'aabbccddeeff001122334455';
const config = { guildId: GUILD, roleId: () => ROLE };

function dbFixture({ state = 'role_assignment_pending', daysJoined = 30 } = {}) {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users(id,email,ign,password) VALUES(1,'discord:" + MEMBER_ID + "','Recover','')").run();
  db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(1, MEMBER_ID, 'member');
  db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,operation_id,created,updated) VALUES(?,?,?,?,?,unixepoch()-300,unixepoch()-300)')
    .run(MEMBER_ID, GUILD, state, 1, OPID);
  return db;
}

function depsFor({ memberRoles = [ROLE], assign, memberFails, ineligible } = {}) {
  const calls = { assign: 0, memberOf: 0 };
  return {
    calls,
    memberOf: async (_target, id) => {
      calls.memberOf += 1;
      if (memberFails) throw new Error('Discord membership lookup failed.');
      if (id === '@me') return { id: BOT, roles: [BOT_ROLE] };
      if (ineligible) return { id, roles: memberRoles, joined_at: new Date(Date.now() - 60000).toISOString(), pending: false, communication_disabled_until: null };
      return { id, roles: memberRoles, joined_at: new Date(Date.now() - daysJoined() * 86400000).toISOString(), pending: false, communication_disabled_until: null };
    },
    userOf: async () => ({ id: MEMBER_ID, username: 'member', bot: false }),
    roleOf: async () => ({ id: ROLE, position: 2, managed: false, permissions: '0' }),
    rolesOf: async () => [{ id: ROLE, position: 2, permissions: '0', managed: false }, { id: BOT_ROLE, position: 9, permissions: '0' }],
    assign: assign || (async () => { calls.assign += 1; }),
    embedFor: opts => ({ title: opts.eventType, status: opts.status, ref: opts.ref }),
  };
}
function daysJoined() { return 30; }

function reconcile(db, deps) {
  return verification.reconcileStuck(db, config, { channelId: LOG, websiteUrl: 'https://x.example' }, deps);
}
async function completedEvents(db) {
  const rows = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
  return rows.filter(row => row.event_key.endsWith('-complete'));
}
async function outboxJobs(db) {
  return db.prepare('SELECT state,content FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
}

test('a stuck record with the role already present completes without another grant', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [ROLE] });
  const summary = await reconcile(db, deps);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.completed, 1);
  assert.equal(deps.calls.assign, 0, 'no second role PUT when Discord already holds it');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  assert.equal(record.operation_id, OPID);
  const completed = await completedEvents(db);
  assert.equal(completed.length, 1, 'exactly one completed audit event');
  const jobs = await outboxJobs(db);
  assert.equal(jobs.length, 1, 'exactly one durable delivery job');
  db.close();
});

test('a stuck record without the role is granted and completed by the sweep', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [] });
  const summary = await reconcile(db, deps);
  assert.equal(summary.completed, 1);
  assert.equal(summary.granted, 1);
  assert.equal(deps.calls.assign, 1);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  assert.equal((await completedEvents(db)).length, 1);
  db.close();
});

test('a failed grant leaves the record for the next pass with the cause', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [], assign: async () => { throw Object.assign(new Error('Discord role assignment failed.'), { status: 403 }); } });
  const summary = await reconcile(db, deps);
  assert.equal(summary.completed, 0);
  assert.equal(summary.skipped, 1);
  assert.match(summary.records[0].reason, /403/);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'role_assignment_pending', 'the record is untouched for the next sweep');
  assert.equal((await completedEvents(db)).length, 0);
  db.close();
});

test('ineligible members are left to the normal flow', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [ROLE], ineligible: true });
  const summary = await reconcile(db, deps);
  assert.equal(summary.completed, 0);
  assert.equal(summary.skipped, 1);
  assert.match(summary.records[0].reason, /not_eligible:member_age/);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'role_assignment_pending');
  db.close();
});

test('transient Discord failures are retried on a later pass, not recorded as completion', async () => {
  const db = dbFixture();
  const depsFailing = depsFor({ memberFails: true });
  const first = await reconcile(db, depsFailing);
  assert.equal(first.completed, 0);
  assert.equal(first.skipped, 1);
  const depsOk = depsFor({ memberRoles: [ROLE] });
  const second = await reconcile(db, depsOk);
  assert.equal(second.completed, 1);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  db.close();
});

test('reconciliation is safe to repeat: no duplicate events, grants, or deliveries', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [] });
  await reconcile(db, deps);
  const second = await reconcile(db, deps);
  assert.equal(second.attempted, 0, 'a completed record is no longer eligible for the sweep');
  const completed = await completedEvents(db);
  assert.equal(completed.length, 1);
  const jobs = await outboxJobs(db);
  assert.equal(jobs.length, 1);
  db.close();
});

test('an already-queued completed event is never duplicated', async () => {
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [ROLE] });
  // Simulate a previous sweep that queued the event but crashed before
  // persisting the completed record state.
  const account = await db.prepare('SELECT u.id FROM users u JOIN discord_links l ON l.user_id=u.id WHERE l.discord_id=?').get(MEMBER_ID);
  await verification.queueEvent(db, { guildId: GUILD, discordId: MEMBER_ID, userId: account.id,
    eventType: 'Website verification completed', ref: OPID + '-complete', embed: { title: 'Website verification completed' },
    channelId: LOG, websiteUrl: 'https://x.example' });
  const summary = await reconcile(db, deps);
  assert.equal(summary.completed, 1);
  const completed = await completedEvents(db);
  assert.equal(completed.length, 1, 'the event key collapsed the replay into one row');
  const jobs = await outboxJobs(db);
  assert.equal(jobs.length, 1, 'one delivery job, not two');
  db.close();
});

test('the crash window itself: role granted, persistence failed, recovered server-side', async () => {
  // The exact production failure mode: the callback granted the role on Discord
  // and then the completing transaction failed. Nothing on the browser side
  // can finish it — only the durable sweep can.
  const db = dbFixture();
  const deps = depsFor({ memberRoles: [ROLE] });
  const summary = await reconcile(db, deps);
  assert.equal(summary.completed, 1);
  assert.equal(deps.calls.assign, 0, 'the role is already there; the sweep persists completion only');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  assert.ok(record.verified_at > 0);
  assert.equal((await completedEvents(db)).length, 1);
  assert.equal((await outboxJobs(db)).length, 1);
  db.close();
});

test('records fresh enough to be mid-flight are not swept', async () => {
  const db = dbFixture();
  // The sweep's two-minute age guard: a sign-in whose callback is still
  // running must not be raced by the cron sweep.
  await db.prepare('UPDATE website_verification_records SET updated=unixepoch() WHERE discord_id=?').run(MEMBER_ID);
  const summary = await reconcile(db, depsFor({ memberRoles: [ROLE] }));
  assert.equal(summary.attempted, 0, 'in-flight records are protected from the sweep');
  db.close();
});

test('a role_assignment_failed record is also recovered', async () => {
  const db = dbFixture({ state: 'role_assignment_failed' });
  const summary = await reconcile(db, depsFor({ memberRoles: [ROLE] }));
  assert.equal(summary.completed, 1);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  db.close();
});
