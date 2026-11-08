// Prompt automatic recovery: ordinary page traffic (GET /api/session by ANY
// visitor) drives the bounded reconciliation sweep in the background, so a
// sign-in interrupted between the role grant and the persisted completion is
// recovered within minutes — without the affected member visiting, refreshing,
// or signing in again. The sweep is throttled per instance and idempotent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { openDatabase } = require('../website/db');
const { createServer } = require('../website/server');
const verification = require('../website/verification');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const BOT = '888000000000000001';
const BOT_ROLE = '888000000000000002';
const MEMBER_ID = '777000000000000001';
const LOG = '888888888888888888';
const OPID = 'bbccddeeff00112233445566';
const DAY = 86400000;
const past = offset => new Date(Date.now() - offset).toISOString();

async function trafficRecoveredHarness({ memberRoles = [ROLE] } = {}) {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users(id,email,ign,password) VALUES(1,'discord:" + MEMBER_ID + "','','')").run();
  db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(1, MEMBER_ID, 'member');
  db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,operation_id,created,updated) VALUES(?,?,?,?,?,unixepoch()-600,unixepoch()-600)')
    .run(MEMBER_ID, GUILD, 'role_assignment_failed', 1, OPID);
  const backgroundCalls = [];
  const discord = {
    adminIds: [], redirectUri: 'http://127.0.0.1/api/discord/callback', guildId: GUILD,
    roleId: () => ROLE, botToken: 'test-bot-token', logChannelId: LOG,
  };
  const server = createServer({
    db, discord,
    // Real background execution, as Vercel's waitUntil provides: callers pass
    // a promise that continues after the response is sent.
    background: work => { backgroundCalls.push(work); return work; },
    cronSecret: 'verify-cron-secret',
    identify: async () => ({ id: MEMBER_ID, username: 'member', verified: false }),
    sendTradeMessage: null, postListing: null,
    logChannelValidate: async () => ({ id: LOG, guild_id: GUILD, type: 0 }),
    verifyDeps: {
      memberOf: async (_target, id) => (id === '@me' ? { id: BOT, roles: [BOT_ROLE] } : { id, roles: memberRoles, joined_at: past(DAY), pending: false, communication_disabled_until: null }),
      userOf: async () => ({ id: MEMBER_ID, username: 'member', bot: false }),
      roleOf: async () => ({ id: ROLE, position: 2, managed: false, permissions: '0' }),
      rolesOf: async () => [{ id: ROLE, position: 2, permissions: '0', managed: false }, { id: BOT_ROLE, position: 9, permissions: '0' }],
      assign: async () => {},
      embedFor: opts => ({ title: opts.eventType }),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const close = async () => { await new Promise(resolve => server.close(resolve)); db.close(); };
  return { db, origin, close };
}

test('a page load by any visitor recovers a stuck verification without the member visiting', async () => {
  const { db, origin, close } = await trafficRecoveredHarness();
  try {
    // An anonymous visitor opens the site: /api/session drives the sweep.
    const session = await fetch(origin + '/api/session', { headers: {} });
    assert.equal(session.status, 200, 'session status: ' + (await session.text()).slice(0, 200));
    // The background work (sweep + flush) runs with the response; let it settle.
    await new Promise(resolve => setTimeout(resolve, 250));
    const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
    assert.equal(record.state, 'verified', 'the interrupted completion is persisted by page traffic alone');
    assert.equal(record.operation_id, OPID);
    const completed = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
    assert.equal(completed.filter(row => row.event_key.endsWith('-complete')).length, 1);
    const jobs = await db.prepare('SELECT state FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
    assert.equal(jobs.length, 1, 'the completed audit event was enqueued for delivery');
  } finally { await close(); }
});

test('repeated page loads within the throttle never duplicate the completed event', async () => {
  const { db, origin, close } = await trafficRecoveredHarness();
  try {
    for (let i = 0; i < 3; i += 1) {
      await fetch(origin + '/api/session', { headers: {} });
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
    assert.equal(record.state, 'verified');
    const completed = await db.prepare('SELECT event_key FROM website_signin_events WHERE discord_id=?').all(MEMBER_ID);
    assert.equal(completed.length, 1, 'one event, no duplicates across page loads');
    const jobs = await db.prepare('SELECT count(*) AS total FROM delivery_outbox WHERE discord_id=?').all(MEMBER_ID);
    assert.equal(jobs[0].total, 1, 'one delivery job, no duplicates');
  } finally { await close(); }
});

test('the cron route reconciles without any browser activity and reports the outcome', async () => {
  const { db, origin, close } = await trafficRecoveredHarness();
  try {
    const response = await fetch(origin + '/api/delivery-retry', { headers: { Authorization: 'Bearer verify-cron-secret' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reconciliation.attempted, 1);
    assert.equal(body.reconciliation.completed, 1);
    const record = await verification.loadRecord(db, MEMBER_ID, GUILD);
    assert.equal(record.state, 'verified');
  } finally { await close(); }
});

test('the cron route rejects callers without the secret', async () => {
  const { origin, close } = await trafficRecoveredHarness();
  try {
    const response = await fetch(origin + '/api/delivery-retry', { headers: {} });
    assert.equal(response.status, 403);
  } finally { await close(); }
});
