// Verification state accuracy: a failed role grant must persist as a retryable
// failed state (not an indefinite "in progress"), the refresh path must
// complete the same operation without duplicating the audit event, and the
// view must separate "verified" from "verified, audit delivery pending".
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../website/db');
const verification = require('../website/verification');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const LOG = '888888888888888888';
const MEMBER_ID = String((BigInt(Date.now() - 30 * 86400000 - 1420070400000) << 22n) + 7n);
const USER = { id: MEMBER_ID, username: 'member', bot: false, avatar: null };
const config = { guildId: GUILD, roleId: () => ROLE };

function eligibleMember() {
  return { id: MEMBER_ID, roles: [], joined_at: new Date(Date.now() - 86400000).toISOString(), pending: false, communication_disabled_until: null };
}

function dbFixture() {
  const db = openDatabase(':memory:');
  // The sign-in flow writes durable rows with FK references to the account.
  db.prepare("INSERT INTO users(id,email,ign,password) VALUES(1,'discord:" + MEMBER_ID + "','','')").run();
  return db;
}

function deps({ assignFail, roleOf } = {}) {
  return {
    memberOf: async (target, id) => id === '@me' ? { id: 'bot', roles: ['bot-role'] } : eligibleMember(),
    userOf: async () => USER,
    roleOf: async () => roleOf || { id: ROLE, position: 5, managed: false, permissions: '0' },
    rolesOf: async () => [{ id: ROLE, position: 5, permissions: '0' }, { id: 'bot-role', position: 9, permissions: '0' }],
    assign: assignFail ? async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } : async () => {},
    embedFor: opts => ({ title: opts.eventType, status: opts.status, ref: opts.ref }),
  };
}

test('a failed role grant persists as role_assignment_failed, not an indefinite pending', async () => {
  const db = dbFixture();
  const result = await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, deps({ assignFail: true }));
  assert.equal(result.outcome, 'role_failed');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'role_assignment_failed');
  assert.equal(record.fail_reason, 'role_failed');
  const view = await verification.verificationView(db, { discordId: MEMBER_ID, guildId: GUILD });
  assert.equal(view.state, 'role_assignment_failed');
  db.close();
});

test('refresh completes a failed assignment without a duplicate audit event', async () => {
  const db = dbFixture();
  const channelId = LOG;
  await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId, websiteUrl: 'https://x.example' }, deps({ assignFail: true }));
  const before = await verification.loadRecord(db, MEMBER_ID, GUILD);
  const result = await verification.refresh(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId, websiteUrl: 'https://x.example' }, deps());
  assert.equal(result.outcome, 'verified');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  // Exactly one completed audit event for the same operation.
  const events = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
  const completed = events.filter(row => row.event_key.includes('-complete'));
  assert.equal(completed.length, 1);
  assert.equal(before.operation_id, record.operation_id, 'the same operation id is reused');
  db.close();
});

test('an eligible first sign-in queues the pending and completed audit events exactly once each', async () => {
  const db = dbFixture();
  const result = await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, deps());
  assert.equal(result.outcome, 'verified');
  const jobs = await db.prepare('SELECT state,content,channel_id FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(jobs.length, 2, 'one pending job and one completed job for a first sign-in');
  for (const job of jobs) assert.equal(job.channel_id, LOG);
  const keys = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(new Set(keys.map(row => row.event_key)).size, keys.length, 'no duplicate event keys');
  db.close();
});

test('a pending or failed delivery keeps the verified state but stays visible in the view', async () => {
  const db = dbFixture();
  await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, deps());
  db.prepare("UPDATE delivery_outbox SET state='failed' WHERE discord_id=?").run(MEMBER_ID);
  let view = await verification.verificationView(db, { discordId: MEMBER_ID, guildId: GUILD });
  assert.equal(view.verified, true, 'a failed embed never makes a verified member look unverified');
  assert.equal(view.delivery, 'failed');
  db.prepare("UPDATE delivery_outbox SET state='sent' WHERE discord_id=?").run(MEMBER_ID);
  view = await verification.verificationView(db, { discordId: MEMBER_ID, guildId: GUILD });
  assert.equal(view.delivery, 'sent');
  db.close();
});

test('waiting eligibility records the reason and the eligible-at time', async () => {
  const db = dbFixture();
  const waitingDeps = deps();
  waitingDeps.memberOf = async (target, id) => id === '@me' ? { id: 'bot', roles: ['bot-role'] }
    : { ...eligibleMember(), joined_at: new Date(Date.now() - 60000).toISOString() };
  const result = await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, waitingDeps);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'member_age');
  assert.ok(result.eligibleAt > Math.floor(Date.now() / 1000));
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'blocked');
  assert.equal(record.fail_reason, 'member_age');
  db.close();
});

test('missing permissions and role-hierarchy errors classify the failure cause', async () => {
  const db = dbFixture();
  const hierarchyDeps = deps();
  hierarchyDeps.roleOf = async () => ({ id: ROLE, position: 12, managed: false, permissions: '0' });
  const result = await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, hierarchyDeps);
  assert.equal(result.outcome, 'role_failed');
  assert.equal(result.code, 'hierarchy');
  db.close();
});

test('audit delivery is skipped but harmless when no channel is configured', async () => {
  const db = dbFixture();
  const result = await verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: null, websiteUrl: 'https://x.example' }, deps());
  assert.equal(result.outcome, 'verified', 'verification itself never depends on the audit channel');
  const jobs = await db.prepare('SELECT state FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(jobs.length, 0, 'no job is queued when the channel is unreachable or unconfigured');
  db.close();
});
