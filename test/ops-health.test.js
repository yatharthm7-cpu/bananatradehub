// Ops health: the sweep heartbeat, the consolidated sanitized roll-up, the
// config-drift canary (with its rate-limited operator notice), the cron route
// wiring, and the pass/fail rendering scripts/check-production.js prints.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { openDatabase } = require('../website/db');
const { createServer } = require('../website/server');
const ops = require('../website/ops-health');
const { report } = require('../scripts/check-production');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const OTHER_ROLE = '999000000000000008';
const BOT = '888000000000000001';
const BOT_ROLE = '888000000000000002';
const LOG = '888888888888888888';
const DAY = 86400000;
const past = offset => new Date(Date.now() - offset).toISOString();

async function insertUser(db, id = 1, discordId = '777000000000000001') {
  await db.prepare("INSERT INTO users(id,email,ign,password) VALUES(?,?,'','')").run(id, 'discord:' + discordId);
  await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(id, discordId, 'member');
}

function directDeps({ rolesList, channel, member, state } = {}) {
  return {
    rolesOf: async () => rolesList !== undefined ? rolesList : [{ id: ROLE, name: 'Verified Member', position: 2, managed: false, permissions: '0' }, { id: BOT_ROLE, name: 'Bot', position: 9, managed: false, permissions: '0' }],
    memberOf: async () => member === undefined ? { id: BOT, user: { id: BOT }, roles: [BOT_ROLE] } : member,
    channelOf: async () => channel === undefined ? { id: LOG, name: 'audit', guild_id: GUILD, type: 0 } : channel,
    state: state === undefined ? null : state,
    env: { VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' },
  };
}

const directConfig = () => ({
  botToken: 'test-bot-token', guildId: GUILD, logChannelId: LOG,
  roleId: () => ROLE,
});

async function harness({ rolesList, channel, state, post } = {}) {
  const db = openDatabase(':memory:');
  const postedNotices = [];
  const server = createServer({
    db,
    discord: { adminIds: [], redirectUri: 'http://127.0.0.1/api/discord/callback', guildId: GUILD, roleId: () => ROLE, botToken: 'test-bot-token', logChannelId: LOG },
    cronSecret: 'ops-cron-secret', sendTradeMessage: null, postListing: null,
    postVerificationLog: post || (async (channelId, embed) => { postedNotices.push({ channelId, embed }); return 'msg-id'; }),
    logChannelValidate: async () => (channel === null ? null : channel || { id: LOG, name: 'audit', guild_id: GUILD, type: 0 }),
    opsDeps: {
      rolesOf: async () => rolesList || [{ id: ROLE, name: 'Verified Member', position: 2, managed: false, permissions: '0' }, { id: BOT_ROLE, name: 'Bot', position: 9, managed: false, permissions: '0' }],
      memberOf: async (_config, target) => (target === '@me' ? { id: BOT, user: { id: BOT }, roles: [BOT_ROLE] } : { id: target, roles: [ROLE], joined_at: past(DAY), pending: false, communication_disabled_until: null }),
      channelOf: async () => (channel === undefined ? { id: LOG, name: 'audit', guild_id: GUILD, type: 0 } : channel),
      state: state === undefined ? null : state,
    },
  });
  // Await the bind: server.address() is null until listening, and harnesses
  // that compute the origin too early throw before close() can ever run.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const close = async () => { await new Promise(resolve => server.close(resolve)); db.close(); };
  const sweep = async () => {
    const response = await fetch(origin + '/api/delivery-retry?stats=1', { headers: { Authorization: 'Bearer ops-cron-secret' } });
    return { status: response.status, body: await response.json() };
  };
  return { db, origin, close, sweep, postedNotices };
}

// --- Heartbeats -----------------------------------------------------------

test('recordHeartbeat upserts and readHeartbeat reports absence as null', async () => {
  const db = openDatabase(':memory:');
  await ops.recordHeartbeat(db, ops.HEARTBEAT_KEYS.cron, 100);
  assert.equal(await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.cron), 100);
  await ops.recordHeartbeat(db, ops.HEARTBEAT_KEYS.cron, 200);
  assert.equal(await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.cron), 200, 'a second fire updates, not inserts');
  assert.equal(await ops.readHeartbeat(db, 'never-written'), null);
});

// --- The roll-up ----------------------------------------------------------

test('opsHealth reports counts, deploy SHA, role hierarchy, and a validated channel', async () => {
  const db = openDatabase(':memory:');
  await insertUser(db);
  const health = await ops.opsHealth(db, directConfig(), directDeps());
  assert.equal(health.database.reachable, true);
  assert.equal(health.database.counts.users, 1);
  assert.equal(health.database.counts.discordLinks, 1);
  assert.equal(health.deploySha, '0123456789ab', 'the roll-up shortens the injected SHA');
  assert.equal(health.verifiedRole.checked, true);
  assert.equal(health.verifiedRole.botCanGrant, true, 'bot highest 9 > role 2');
  assert.equal(health.auditChannel.validated, true);
  assert.equal(health.auditChannel.sameGuild, true);
  assert.deepEqual(health.drift, [], 'a correctly configured guild reports no drift');
});

test('opsHealth degrades to a database failure without leaking credentials', async () => {
  const failing = {
    prepare: () => { throw Object.assign(new Error('HTTP_401 Something failed for libsql://host?authToken=secret'), { code: 'HTTP_401' }); },
  };
  const health = await ops.opsHealth(failing, directConfig(), directDeps());
  assert.equal(health.database.reachable, false);
  assert.equal(health.database.errorClass, 'database_unreachable');
  assert.equal(String(health.database.message).includes('libsql://'), false, 'the classifier keeps the connection string out of the response');
  assert.equal(ops.deploySha({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha' }), null);
});

test('opsHealth skips Discord probes without a bot token but still reports the database', async () => {
  const db = openDatabase(':memory:');
  await insertUser(db);
  const health = await ops.opsHealth(db, { guildId: GUILD, logChannelId: LOG }, directDeps());
  assert.equal(health.database.reachable, true);
  assert.equal(health.verifiedRole, null);
  assert.ok(String(health.discord).includes('bot token'));
});

// --- The drift canary -----------------------------------------------------

test('driftWarnings names the missing role, hierarchy, and channel problems with a fix', () => {
  const role = { id: ROLE, name: 'Verified Member', position: 2, managed: false };
  assert.equal(ops.driftWarnings({ roleId: ROLE, role: null, botHighest: 9, channel: {}, state: null, envChannelId: LOG })[0].code, 'role_missing');
  assert.equal(ops.driftWarnings({ roleId: ROLE, role: { ...role, managed: true }, botHighest: 9, channel: {}, state: null, envChannelId: LOG })[0].code, 'role_managed');
  assert.equal(ops.driftWarnings({ roleId: ROLE, role, botHighest: 1, channel: {}, state: null, envChannelId: LOG })[0].code, 'bot_hierarchy_too_low');
  assert.equal(ops.driftWarnings({ roleId: ROLE, role, botHighest: 9, channel: null, state: null, envChannelId: LOG })[0].code, 'audit_channel_invalid');
  assert.equal(ops.driftWarnings({ roleId: null, role: null, botHighest: 9, channel: {}, state: null, envChannelId: LOG })[0].code, 'role_unconfigured');
  const drift = ops.driftWarnings({ roleId: OTHER_ROLE, role, botHighest: 9, channel: { id: OTHER_ROLE }, state: { roles: { verified: ROLE }, channels: { verify: LOG } }, envChannelId: OTHER_ROLE });
  assert.deepEqual(drift.map(warning => warning.code), ['role_id_drift', 'channel_id_drift'], 'setup-state mismatch surfaces as actionable drift');
  assert.ok(drift[0].fix.includes('/setup'), 'each warning points at the fix');
});

test('postDriftNotice posts once per window and reports throttle, skip, and failure', async () => {
  const db = openDatabase(':memory:');
  const posted = [];
  const post = async (channelId, embed) => { posted.push({ channelId, embed }); return 'id'; };
  const warnings = [{ code: 'role_missing', detail: 'd', fix: 'f' }];
  assert.equal(await ops.postDriftNotice(db, warnings, { post, channelId: LOG }), 'posted');
  assert.equal(await ops.postDriftNotice(db, warnings, { post, channelId: LOG }), 'throttled', 'the second fire inside the gap is rate limited');
  assert.equal(posted.length, 1);
  assert.equal(await ops.postDriftNotice(db, [], { post, channelId: LOG }), 'skipped');
  assert.equal(await ops.postDriftNotice(db, warnings, { post: null, channelId: LOG }), 'skipped');
  const failing = async () => { throw new Error('Discord rate limited'); };
  const fresh = openDatabase(':memory:');
  assert.equal(await ops.postDriftNotice(fresh, warnings, { post: failing, channelId: LOG }), 'failed');
  fresh.close();
  assert.match(posted[0].embed.title, /drift/i);
});

// --- The sweep route wiring -----------------------------------------------

test('the sweep route records a cron heartbeat and returns the health roll-up', async () => {
  const { db, close, sweep } = await harness();
  try {
    await insertUser(db);
    const { status, body } = await sweep();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.lookup.health.database.reachable, true);
    assert.equal(body.lookup.health.database.counts.users, 1);
    assert.equal(body.lookup.counts.users, 1, 'the documented counts shape is preserved');
    assert.equal(body.lookup.health.verifiedRole.botCanGrant, true);
    assert.deepEqual(body.drift, []);
    assert.equal(body.driftNotice, 'none');
    const heartbeat = await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.cron);
    assert.ok(heartbeat > 0, 'the fire persisted a cron heartbeat');
    const lastSweep = await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.sweep);
    assert.ok(lastSweep > 0, 'the completed sweep persisted a last_sweep heartbeat');
  } finally { await close(); }
});

test('drift lands in the sweep response with one operator notice per window', async () => {
  const { db, close, sweep, postedNotices } = await harness({
    // /setup's role is gone from the live guild: exactly the drift that cost a session.
    rolesList: [{ id: OTHER_ROLE, name: 'Other', position: 2, managed: false, permissions: '0' }, { id: BOT_ROLE, name: 'Bot', position: 9, managed: false, permissions: '0' }],
  });
  try {
    const first = await sweep();
    assert.deepEqual(first.body.drift.map(warning => warning.code), ['role_missing']);
    assert.match(first.body.drift[0].fix, /setup/);
    assert.equal(first.body.driftNotice, 'posted');
    assert.equal(postedNotices.length, 1, 'the operator notice went to the audit channel once');
    assert.equal(postedNotices[0].channelId, LOG);
    const second = await sweep();
    assert.equal(second.body.driftNotice, 'throttled', 'a repeat fire inside the gap does not spam the channel');
    assert.equal(postedNotices.length, 1);
    assert.equal(await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.driftNotice), await ops.readHeartbeat(db, ops.HEARTBEAT_KEYS.driftNotice));
  } finally { await close(); }
});

test('the sweep route still rejects callers without the secret', async () => {
  const { origin, close } = await harness();
  try {
    const response = await fetch(origin + '/api/delivery-retry?stats=1');
    assert.equal(response.status, 403);
  } finally { await close(); }
});

// --- check-production.js rendering ----------------------------------------

test('report passes a healthy roll-up and fails on every section that can break', async () => {
  // The healthy baseline is a real sweep response (with its heartbeats), not a
  // hand-built one: report is only ever fed sweep responses in practice.
  const { close, sweep } = await harness();
  let healthy;
  try {
    const { body } = await sweep();
    healthy = body;
  } finally { await close(); }
  assert.equal(report(healthy).exitCode, 0);
  assert.equal(report({ ok: false }).exitCode, 1, 'a non-ok sweep body fails');
  assert.equal(report({ ok: true }).exitCode, 1, 'a response without the roll-up fails');

  const base = healthy.lookup.health;
  const variant = health => report({ ok: true, drift: health === base ? healthy.drift : [], lookup: { health } });

  const unreachable = variant({ ...base, database: { reachable: false, errorClass: 'database_unreachable', message: 'refused' } });
  assert.equal(unreachable.exitCode, 1);
  assert.ok(unreachable.lines.join('\n').includes('not reachable'));

  const botTooLow = variant({ ...base, verifiedRole: { checked: true, id: ROLE, name: 'Verified Member', position: 20, managed: false, botCanGrant: false }, bot: { highestRolePosition: 9 } });
  assert.equal(botTooLow.exitCode, 1);
  assert.ok(botTooLow.lines.join('\n').includes('cannot grant'));

  const auditChannelInvalid = variant({ ...base, auditChannel: { checked: true, validated: false, id: LOG } });
  assert.equal(auditChannelInvalid.exitCode, 1);

  const staleSweep = variant({ ...base, heartbeat: { cronHeartbeat: base.heartbeat.cronHeartbeat, lastSweep: base.heartbeat.cronHeartbeat - 4 * 3600, cronStaleAfter: ops.CRON_STALE_AFTER } });
  assert.equal(staleSweep.exitCode, 1, 'a cron that fires while sweeps never complete is a failure');

  const drifting = report({ ok: true, drift: [{ code: 'role_id_drift', detail: 'setup had X', fix: 'rerun /setup' }], lookup: { health: base } });
  assert.equal(drifting.exitCode, 1);
  assert.ok(drifting.lines.join('\n').includes('role_id_drift'));
});
