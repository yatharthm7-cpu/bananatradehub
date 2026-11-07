// Automatic role assignment regression: the real REST sequence the website
// uses (bot self lookup, guild member, role list, idempotent role PUT) against
// a fake fetch, so the exact production bug — "@me" on the guild-member route
// returning NUMBER_TYPE_COERCE (HTTP 400) — is covered, plus permission,
// hierarchy, transient-failure, idempotent-completion, and recovery cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../website/db');
const verification = require('../website/verification');
const { guildMember } = require('../website/discord');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const BOT = '888000000000000001';
const BOT_ROLE = '888000000000000002';
const MEMBER_ID = '777000000000000001';
const LOG = '888888888888888888';
const config = { botToken: 'fixture-token', guildId: GUILD, roleId: () => ROLE };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function dbFixture() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users(id,email,ign,password) VALUES(1,'discord:" + MEMBER_ID + "','','')").run();
  return db;
}

// Default deps: bot member above the Verified role, eligible member, and a
// recorded idempotent role PUT (Discord answers 204 and tolerates re-adds).
function depsFor({ memberRoles = [], assign, rolesList } = {}) {
  const calls = { assign: 0, memberRoutes: [] };
  const list = rolesList || [{ id: ROLE, position: 2, permissions: '0', managed: false }, { id: BOT_ROLE, position: 9, permissions: '0' }];
  return {
    calls,
    memberOf: async (_target, id) => {
      if (id === '@me') return { id: BOT, roles: [BOT_ROLE] };
      calls.memberRoutes.push(id);
      return { id, roles: id === BOT ? [BOT_ROLE] : memberRoles, joined_at: new Date(Date.now() - 86400000).toISOString(), pending: false, communication_disabled_until: null };
    },
    userOf: async () => ({ id: MEMBER_ID, username: 'member', bot: false }),
    roleOf: async () => list.find(role => role.id === ROLE) || { id: ROLE, position: 2, managed: false, permissions: '0' },
    rolesOf: async () => list,
    assign: assign || (async () => { calls.assign += 1; }),
    embedFor: opts => ({ title: opts.eventType, status: opts.status, ref: opts.ref }),
  };
}

function signIn(db, deps) {
  return verification.processSignIn(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, deps);
}
function refresh(db, deps) {
  return verification.refresh(db, config, { userId: 1, discordId: MEMBER_ID, ign: null, suspended: false, rulesVer: 1, channelId: LOG, websiteUrl: 'https://x.example' }, deps);
}

test('guildMember resolves @me through the bot self lookup, never the raw route', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ method: options.method || 'GET', url });
    if (url.endsWith('/users/@me')) return jsonResponse(200, { id: BOT, bot: true });
    if (url.endsWith(`/guilds/${GUILD}/members/${BOT}`)) return jsonResponse(200, { roles: [BOT_ROLE] });
    throw new Error(`Unexpected ${url}`);
  };
  const member = await guildMember(config, '@me', fetch);
  assert.deepEqual(member.roles, [BOT_ROLE]);
  assert.ok(calls.some(call => call.url.endsWith('/users/@me')), 'the bot self lookup resolves the numeric id');
  assert.ok(calls.some(call => call.url.endsWith(`/guilds/${GUILD}/members/${BOT}`)), 'the member route receives the resolved id');
  assert.ok(!calls.some(call => /members\/@me$/.test(call.url)), 'the literal @me route must never be requested');
});

test('the pre-fix failure shape still fails loudly: @me rejected with NUMBER_TYPE_COERCE', async () => {
  const fetch = async url => (url.endsWith('/users/@me') ? jsonResponse(400, { message: 'Invalid Form Body', code: 50035 }) : jsonResponse(200, {}));
  await assert.rejects(() => guildMember(config, '@me', fetch), /Discord self lookup failed/);
});

test('an eligible sign-in grants the role inside the authenticated flow', async () => {
  const deps = depsFor({ memberRoles: [] });
  const db = dbFixture();
  const result = await signIn(db, deps);
  assert.equal(result.outcome, 'verified');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  assert.equal(deps.calls.assign, 1, 'the role PUT ran inside the sign-in');
  const jobs = await db.prepare('SELECT content,channel_id FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(jobs.length, 2, 'the pending and completed audit events were both queued');
  db.close();
});

test('an already-verified member keeping the role completes with no further grant attempt', async () => {
  const db = dbFixture();
  const seeded = depsFor({ memberRoles: [ROLE] });
  await signIn(db, seeded);
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'verified');
  // A later refresh of the same verified member: the role is confirmed present,
  // so verification completes idempotently with no second role PUT and no new
  // audit event.
  const deps = depsFor({ memberRoles: [ROLE] });
  const result = await refresh(db, deps);
  assert.equal(result.outcome, 'verified');
  assert.equal(deps.calls.assign, 0, 'no redundant role PUT');
  const events = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(events.length, 2, 'no duplicate audit events');
  db.close();
});

test('a missing-permissions PUT classifies as a failure, not an indefinite pending', async () => {
  const deps = depsFor({
    memberRoles: [],
    assign: async () => { throw Object.assign(new Error('Discord role assignment failed.'), { status: 403 }); },
  });
  const db = dbFixture();
  const result = await signIn(db, deps);
  assert.equal(result.outcome, 'role_failed');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'role_assignment_failed');
  db.close();
});

test('an unsafe hierarchy fails before any role PUT', async () => {
  const deps = depsFor({ memberRoles: [], rolesList: [{ id: ROLE, position: 10, permissions: '0', managed: false }, { id: BOT_ROLE, position: 9, permissions: '0' }] });
  const db = dbFixture();
  const result = await signIn(db, deps);
  assert.equal(result.outcome, 'role_failed');
  assert.equal(result.code, 'hierarchy');
  assert.equal(deps.calls.assign, 0, 'no role PUT happens when the hierarchy check fails');
  db.close();
});

test('a transient Discord failure recovers on the next bounded check without duplicate events', async () => {
  let granted = false;
  const deps = depsFor({
    memberRoles: [],
    assign: async () => {
      if (!granted) { granted = true; throw Object.assign(new Error('Discord role assignment failed.'), { status: 500 }); }
    },
  });
  const db = dbFixture();
  const first = await signIn(db, deps);
  assert.equal(first.outcome, 'role_failed');
  const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.state, 'role_assignment_failed');
  // The next authenticated re-check (the page's own recovery path) completes
  // the same operation: opId reused, exactly one completed event.
  const second = await refresh(db, deps);
  assert.equal(second.outcome, 'verified');
  const after = await verification.loadRecord(db, MEMBER_ID, GUILD);
  assert.equal(record.operation_id, after.operation_id, 'the same operation id is reused');
  const events = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
  assert.equal(events.filter(row => row.event_key.includes('-complete')).length, 1, 'one completed event after recovery');
  db.close();
});

test('a failed audit delivery never blocks role assignment or the verified state', async () => {
  const deps = depsFor({ memberRoles: [] });
  const db = dbFixture();
  // The channel resolves, but the delivery post fails permanently: the embed
  // job records the failure while verification itself completes.
  const result = await signIn(db, deps);
  assert.equal(result.outcome, 'verified');
  db.prepare("UPDATE delivery_outbox SET state='exhausted' WHERE discord_id=?").run(MEMBER_ID);
  const view = await verification.verificationView(db, { discordId: MEMBER_ID, guildId: GUILD });
  assert.equal(view.verified, true, 'the verified state stands without the audit embed');
  assert.equal(view.delivery, 'exhausted');
  db.close();
});
