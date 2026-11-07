// Website-only verification: the OAuth sign-in flow, authoritative eligibility,
// the safe role grant, durable audit embeds, reconciliation, and the owner
// migration tools. All Discord facts come from injected seams; no real
// Discord token is used anywhere in this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const sharp = require('sharp');
const { openDatabase } = require('../website/db');
const { createServer } = require('../website/server');
const verification = require('../website/verification');

const GUILD = '987654321098765432';
const ROLE = '999000000000000009';
const LEGACY = '777777777777777771';
const VERIFIED_MEMBER = '666666666666666662';
const LOG = '888888888888888888';
const DAY = 86400000;
const future = offset => new Date(Date.now() + offset).toISOString();
const past = offset => new Date(Date.now() - offset).toISOString();
const snowflake = date => String((BigInt(Date.parse(date) - 1420070400000) << 22n) + 7n);
const MEMBER_ID = snowflake(past(40 * DAY));
const USER = { id: MEMBER_ID, username: 'tester', global_name: 'Tester', avatar: 'a1b2c3d4', bot: false };

function member({ roles = [], pending = false, joined = past(DAY), timedOut = false } = {}) {
  return { roles, pending, joined_at: joined, communication_disabled_until: timedOut ? future(3600000) : null };
}

async function harness(t, overrides = {}) {
  const db = openDatabase(':memory:');
  const calls = { assign: 0, logs: [], removes: [], members: [] };
  const defaults = {
    memberOf: async () => member({ roles: [ROLE] }),
    userOf: async () => USER,
    memberLookup: async () => member({ roles: [ROLE] }),
    roleOf: async () => ({ id: ROLE, position: 5, managed: false, permissions: '0' }),
    rolesOf: async () => [{ id: ROLE, position: 5, permissions: '0' }, { id: 'bot', position: 9, permissions: '8' }],
    assign: async () => { calls.assign++; },
    channelValidate: async () => ({ id: LOG, guild_id: GUILD, type: 0 }),
    postLog: async (channelId, embed) => { calls.logs.push({ channelId, embed }); return String(calls.logs.length); },
    checkMember: async () => true,
    identify: async () => ({ id: MEMBER_ID, username: 'tester', verified: false }),
    removeRole: async (_config, userId, roleId) => { calls.removes.push({ userId, roleId }); },
  };
  const config = { ...defaults, ...overrides };
  // The bot's own member (for grant hierarchy checks) is separate from the
  // signing-in member, just like in a real guild.
  const bot = member({ roles: ['bot'] });
  const memberFor = config.memberOf;
  const memberOf = async (target, userId) => (userId === '@me' ? bot : memberFor(target, userId));
  const discord = { adminIds: overrides.adminIds || [], redirectUri: 'http://127.0.0.1/api/discord/callback', guildId: GUILD,
    roleId: () => ROLE, botToken: 'test-bot-token', logChannelId: LOG };
  const server = createServer({ db, discord, background: null, cronSecret: 'verify-cron-secret',
    identify: config.identify, checkMember: config.checkMember, memberLookup: config.memberLookup,
    sendTradeMessage: null, postListing: null, postVerificationLog: config.postLog,
    logChannelValidate: config.channelValidate, removeRoleFn: config.removeRole,
    verifyDeps: { memberOf, userOf: config.userOf, roleOf: config.roleOf, rolesOf: config.rolesOf, assign: config.assign } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  discord.redirectUri = origin + '/api/discord/callback';
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const signIn = async () => {
    const start = await fetch(origin + '/api/discord/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin },
      body: JSON.stringify({ accepted: true, rulesVersion: 1 }),
    });
    assert.equal(start.status, 200);
    const { url } = await start.json();
    const oauthCookie = start.headers.get('set-cookie').split(';')[0];
    const location = new URL(url);
    const response = await fetch(origin + '/api/discord/callback?code=any&state=' + location.searchParams.get('state'),
      { headers: { cookie: oauthCookie }, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location'),
      cookie: response.headers.get('set-cookie')?.split(';')[0], state: location.searchParams.get('state'), oauthCookie };
  };
  const api = async (path, cookie, body) => {
    const response = await fetch(origin + '/api' + path, body === undefined ? { headers: cookie ? { cookie } : {} } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  };
  const session = async cookie => (await api('/session', cookie)).data;
  const record = async () => (await db.prepare('SELECT state,fail_reason,eligible_at,operation_id,rules_version FROM website_verification_records WHERE discord_id=?').get(MEMBER_ID));
  const outbox = async () => (await db.prepare('SELECT channel_id,embed_json,state FROM delivery_outbox WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id').all('discord:' + MEMBER_ID));
  const events = async () => (await db.prepare('SELECT event_type FROM website_signin_events WHERE discord_id=? ORDER BY id').all(MEMBER_ID));
  const flush = async () => (await fetch(origin + '/api/delivery-retry', { headers: { Authorization: 'Bearer verify-cron-secret' } })).json();
  return { db, origin, calls, signIn, api, session, record, outbox, events, flush };
}

test('login without accepting the current rules never starts an OAuth flow', async t => {
  const { origin } = await harness(t);
  for (const body of [{}, { accepted: true }, { accepted: true, rulesVersion: 999 }]) {
    const response = await fetch(origin + '/api/discord/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test('an unverified member signs in: record, durable audit embed, and one idempotent grant', async t => {
  const { signIn, record, outbox, events, calls, session } = await harness(t);
  const result = await signIn();
  assert.equal(result.status, 303);
  assert.match(result.location, /discord=verified/);
  assert.equal((await record()).state, 'verified');
  assert.equal(calls.assign, 1); // idempotent: one PUT per completed sign-in
  // The audit embed is a durable outbox job bound to the single-use event.
  const jobs = await outbox();
  assert.equal(jobs.length, 2); // verification-pending, then verification-completed
  assert.equal(jobs[0].channel_id, LOG);
  assert.match(JSON.parse(jobs[0].embed_json).title, /verification pending/);
  assert.match(JSON.parse(jobs[1].embed_json).title, /Website verification completed/);
  assert.deepEqual((await events()).map(row => row.event_type), ['Website sign-in — verification pending', 'Website verification completed']);
  // A repeated sign-in reuses the verified record without re-granting.
  const again = await signIn();
  assert.match(again.location, /discord=verified/);
  assert.equal(calls.assign, 1);
  assert.equal((await record()).state, 'verified');
  assert.equal((await outbox()).length, 3);
  const profile = await session(result.cookie);
  assert.equal(profile.verification.state, 'verified');
});

test('a callback replay with a consumed state is rejected and cannot duplicate embeds', async t => {
  const local = await harness(t);
  const first = await local.signIn();
  assert.match(first.location, /discord=verified/);
  const again = await fetch(local.origin + '/api/discord/callback?code=any&state=' + first.state,
    { headers: { cookie: first.oauthCookie }, redirect: 'manual' });
  assert.equal(again.status, 403);
  const jobs = await local.outbox();
  const before = jobs.length;
  // The consumed state cannot be replayed, so no new record, grant, or embed.
  assert.equal((await local.record()).state, 'verified');
  assert.equal((await local.outbox()).length, before);
  assert.equal((await local.events()).length, before);
});

test('each eligibility failure blocks, records the reason and eligible time, and grants nothing', async t => {
  const { signIn, record, calls } = await harness(t, { memberOf: async () => null });
  let result = await signIn();
  assert.match(result.location, /discord=pending/);
  assert.equal((await record()).state, 'blocked');
  assert.equal((await record()).fail_reason, 'not_member');
  assert.equal(calls.assign, 0);
  const cases = [
    [{ pending: true }, 'screening'],
    [{ timedOut: true }, 'timeout'],
    [{ joined: past(60000) }, 'member_age'],
  ];
  for (const [overrides, reason] of cases) {
    const local = await harness(t, { memberOf: async () => member(overrides) });
    const res = await local.signIn();
    assert.match(res.location, /discord=pending/, reason);
    const row = await local.record();
    assert.equal(row.state, 'blocked');
    assert.equal(row.fail_reason, reason);
    assert.ok(Number.isInteger(row.eligible_at) || reason === 'screening' || reason === 'timeout' || reason === 'not_member', reason);
  }
  const young = await harness(t, { userOf: async () => ({ ...USER, id: snowflake(past(3600000)) }) });
  const res = await young.signIn();
  assert.match(res.location, /discord=pending/);
  const row = await young.record();
  assert.equal(row.fail_reason, 'account_age');
  assert.ok(row.eligible_at > Math.floor(Date.now() / 1000) - 100);
  const botAccount = await harness(t, { userOf: async () => ({ ...USER, bot: true }) });
  assert.equal((await botAccount.signIn()) && (await botAccount.record()).fail_reason, 'bot');
});

test('a suspended marketplace account cannot sign in', async t => {
  const { db, origin } = await harness(t);
  const id = (await db.prepare("INSERT INTO users(email,ign,password,suspended) VALUES(?, 'SuspendedIGN', '', 1)").run('discord:' + MEMBER_ID)).lastInsertRowid;
  await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(id, MEMBER_ID, 'tester');
  const start = await fetch(origin + '/api/discord/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify({ accepted: true, rulesVersion: 1 }),
  });
  const state = new URL((await start.json()).url).searchParams.get('state');
  const oauthCookie = start.headers.get('set-cookie').split(';')[0];
  const response = await fetch(origin + '/api/discord/callback?code=any&state=' + state,
    { headers: { cookie: oauthCookie }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /discord=suspended/);
});

test('a verification failure never breaks the sign-in session', async t => {
  const local = await harness(t, { memberOf: async () => { throw new Error('Discord down'); } });
  const result = await local.signIn();
  assert.equal(result.status, 303);
  assert.match(result.location, /discord=linked/);
  const profile = await local.session(result.cookie);
  assert.equal(profile.user.id > 0, true);
  assert.equal(profile.verification.state, 'none');
  assert.equal((await local.record()), undefined); // nothing fabricated
});

test('an unsafe role hierarchy leaves the record in a retryable failed state and the sign-in intact', async t => {
  const local = await harness(t, { rolesOf: async () => [{ id: ROLE, position: 5, permissions: '0' }] }); // bot above nothing
  const result = await local.signIn();
  assert.match(result.location, /discord=pending/);
  assert.equal((await local.record()).state, 'role_assignment_failed');
  assert.equal(local.calls.assign, 0);
});

test('verification gates protected actions while a member waits and after a failed grant', async t => {
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#9871b2' } }).png().toBuffer();
  const image = 'data:image/png;base64,' + png.toString('base64');
  const item = { catalogId: 'dragon-egg', category: 'Rare', quantity: 1, rarityReason: 'Rare dragon egg.', enchantments: [], durability: null, screenshot: image };
  const postListing = async (harness, cookie) => {
    // Set the IGN first so the profile requirement does not mask the gate.
    await harness.api('/profile', cookie, { ign: 'TesterIGN' });
    return harness.api('/listings', cookie, { ...item, wants: 'Rare items', notes: 'Test' });
  };
  const local = await harness(t, { memberOf: async () => member({ joined: past(60000), roles: [ROLE] }) });
  const blocked = await local.signIn();
  const blockedListing = await postListing(local, blocked.cookie);
  assert.equal(blockedListing.status, 403);
  assert.match(blockedListing.data.error, /website verification/i);
  // A legacy role holder with no record has no bypass either.
  const legacy = await harness(t);
  const noRecord = await legacy.signIn(); // record created here...
  await legacy.db.prepare("DELETE FROM website_verification_records WHERE discord_id=?").run(MEMBER_ID);
  assert.equal((await postListing(legacy, noRecord.cookie)).status, 403);
  // And a verified member whose Discord role is gone fails too.
  const stale = await harness(t, { checkMember: async () => false });
  const verified = await stale.signIn();
  assert.equal((await postListing(stale, verified.cookie)).status, 403);
});

test('refresh completes a pending grant exactly once and never re-posts embeds', async t => {
  let highHierarchy = true;
  const local = await harness(t, {
    rolesOf: async () => highHierarchy ? [{ id: ROLE, position: 5, permissions: '0' }] : [{ id: ROLE, position: 5, permissions: '0' }, { id: 'bot', position: 9, permissions: '8' }],
  });
  const first = await local.signIn();
  assert.match(first.location, /discord=pending/);
  assert.equal((await local.record()).state, 'role_assignment_failed');
  highHierarchy = false;
  const refreshed = await local.api('/verify/refresh', first.cookie, {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.state, 'verified');
  assert.equal((await local.record()).state, 'verified');
  const jobs = await local.outbox();
  assert.equal(jobs.filter(job => job.embed_json && /completed/.test(job.embed_json)).length, 1);
  // A second refresh is a no-op for the audit log and the grant.
  await local.api('/verify/refresh', first.cookie, {});
  assert.equal((await local.outbox()).filter(job => job.embed_json && /completed/.test(job.embed_json)).length, 1);
  assert.equal(local.calls.assign, 1);
  assert.equal((await local.events()).filter(row => /completed/.test(row.event_type)).length, 1);
});

test('refresh repairs a lost role and revokes when the member leaves the guild', async t => {
  let memberState = member({ roles: [ROLE] });
  const local = await harness(t, { memberOf: async () => memberState });
  const signed = await local.signIn();
  assert.equal(signed.status, 303);
  // Role removed in Discord after verification: the bounded refresh re-grants.
  memberState = member({ roles: [] });
  const repaired = await local.api('/verify/refresh', signed.cookie, {});
  assert.equal(repaired.status, 200);
  assert.equal(repaired.data.state, 'verified');
  assert.equal(local.calls.assign, 2);
  // Leaving the guild revokes instead of looping.
  memberState = null;
  const revoked = await local.api('/verify/refresh', signed.cookie, {});
  assert.equal(revoked.data.state, 'revoked');
  assert.equal((await local.record()).state, 'revoked');
});

test('the audit embed carries authoritative facts, no secrets, and no mentions', async t => {
  const local = await harness(t);
  await local.signIn();
  const [job] = (await local.outbox()).slice(-1);
  const embed = JSON.parse(job.embed_json);
  assert.equal(embed.color, 0xba77f5);
  assert.equal(embed.author.name, 'Tester');
  assert.match(embed.author.icon_url, /^https:\/\/cdn\.discordapp\.com\//);
  const names = embed.fields.map(field => field.name).join('|');
  assert.match(names, /Status/);
  assert.match(names, /Discord user ID/);
  assert.match(names, /Account created/);
  assert.match(names, /Joined server/);
  assert.match(names, /Method/);
  assert.match(names, /Reference/);
  const serialized = JSON.stringify(embed);
  assert.ok(!/token|secret|password|email/i.test(serialized));
  assert.ok(!/@/.test(serialized));
  for (const field of embed.fields) {
    assert.ok(field.name.length <= 256 && field.value.length <= 1024);
  }
  // Only the authoritatively checked account appears; nothing is forged in.
  assert.equal(embed.fields.find(field => field.name === 'Discord user ID').value, MEMBER_ID);
  // Delivering through the durable outbox succeeds with the configured channel.
  const summary = await local.flush();
  assert.equal(summary.delivery.sent >= 1, true);
  assert.equal(local.calls.logs.length >= 1, true);
  assert.equal(local.calls.logs[0].channelId, LOG);
});

test('the channel gate accepts staff-only channels and rejects wrong guilds and types', async () => {
  const { channelBelongsToGuild } = require('../website/discord');
  const config = { botToken: 'test', guildId: GUILD };
  const responds = channel => async () => ({ ok: true, json: async () => channel });
  // Text channel in the guild: accepted.
  assert.ok(await channelBelongsToGuild(config, LOG, responds({ id: LOG, guild_id: GUILD, type: 0, permission_overwrites: [] })));
  // Wrong guild, wrong type, and unreachable channels: rejected.
  assert.equal(await channelBelongsToGuild(config, LOG, responds({ id: LOG, guild_id: '1'.repeat(18), type: 0 })), null);
  assert.equal(await channelBelongsToGuild(config, LOG, responds({ id: LOG, guild_id: GUILD, type: 2 })), null);
  assert.equal(await channelBelongsToGuild(config, LOG, async () => ({ ok: false })), null);
  assert.equal(await channelBelongsToGuild(config, 'not-a-snowflake', responds({ id: LOG, guild_id: GUILD, type: 0 })), null);
  // The audit channel is staff-only by design: @everyone denied View Channel
  // (and Send/Embed) must still qualify, with the bot's own access proven by
  // delivery rather than guessed from the @everyone overwrite.
  const staffOnly = deny => ({ id: LOG, guild_id: GUILD, type: 0, permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny }] });
  assert.ok(await channelBelongsToGuild(config, LOG, responds(staffOnly(String(1n << 10n)))), '@everyone ViewChannel deny must not disqualify the staff-only audit channel');
  assert.ok(await channelBelongsToGuild(config, LOG, responds(staffOnly(String(1n << 10n | 1n << 11n | 1n << 14n)))));
  // Announcement channels are also accepted.
  assert.ok(await channelBelongsToGuild(config, LOG, responds({ id: LOG, guild_id: GUILD, type: 5, permission_overwrites: [] })));
});

test('a missing or misconfigured log channel never blocks the sign-in or fabricates an embed', async t => {
  const unavailable = await harness(t, { channelValidate: async () => null });
  const result = await unavailable.signIn();
  assert.match(result.location, /discord=verified/);
  assert.equal((await unavailable.record()).state, 'verified');
  // The event row is still recorded for the audit trail, but no delivery is queued.
  assert.deepEqual((await unavailable.events()).map(row => row.event_type), ['Website sign-in — verification pending', 'Website verification completed']);
  assert.equal((await unavailable.outbox()).length, 0);
});

test('a failed embed post stays as visible pending work without breaking the sign-in', async t => {
  const local = await harness(t, {
    postLog: async () => { throw Object.assign(new Error('Discord permission failure (403).'), { status: 403 }); },
  });
  const result = await local.signIn();
  assert.match(result.location, /discord=verified/);
  assert.equal((await local.record()).state, 'verified');
  // Delivery runs and fails: the job records safe state and error information.
  const summary = await local.flush();
  assert.equal(summary.delivery.permanent >= 2, true);
  const jobs = await local.db.prepare('SELECT state,last_error FROM delivery_outbox').all();
  assert.ok(jobs.length >= 2);
  for (const job of jobs) {
    assert.equal(job.state, 'permanent'); // a 403 is permanent: no retry storm, but it stays visible
    assert.match(job.last_error, /Discord permission failure/);
  }
  // A transient failure stays in the bounded retry loop instead of vanishing.
  const transient = await harness(t, {
    postLog: async () => { throw Object.assign(new Error('Discord internal error (500).'), { status: 500 }); },
  });
  await transient.signIn();
  const first = await transient.flush();
  assert.ok(first.delivery.failed >= 1);
  await transient.db.prepare("UPDATE delivery_outbox SET next_attempt_at=0 WHERE state='failed'").run();
  const retried = await transient.flush();
  assert.ok(retried.delivery.attempted >= 1);
  const stillOpen = (await transient.db.prepare("SELECT count(*) AS total FROM delivery_outbox WHERE state IN ('pending','failed','exhausted')").get()).total;
  assert.ok(stillOpen >= 1, 'a failed embed stays visible to staff instead of being discarded');
});

test('embed payloads respect Discord size limits and carry the public branding', async t => {
  process.env.WEBSITE_URL = 'https://bananatradehub.vercel.app';
  t.after(() => { delete process.env.WEBSITE_URL; });
  const local = await harness(t);
  await local.signIn();
  const [job] = (await local.outbox()).slice(-1);
  const serialized = job.embed_json;
  assert.ok(serialized.length <= 6000, 'serialized embed must stay under the 6000-character Discord limit');
  const embed = JSON.parse(serialized);
  assert.ok(embed.fields.length <= 25);
  assert.equal(embed.color, 0xba77f5);
  assert.match(embed.author.icon_url, /^https:\/\/cdn\.discordapp\.com\//);
  // Branding uses the publicly served site logo, not a localhost file attachment.
  assert.equal(embed.footer.icon_url, 'https://bananatradehub.vercel.app/logo.png');
});

test('the owner report is a dry run; cutover is explicit and only removes legacy roles', async t => {  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#9871b2' } }).png().toBuffer();
  const email = 'discord:' + MEMBER_ID;
  const local = await harness(t, {
    adminIds: [MEMBER_ID],
    removeRole: async (_config, userId, roleId) => { local.calls.removes.push({ userId, roleId }); },
  });
  // A legacy role holder with a linked account but no website verification record.
  const legacy = (await local.db.prepare("INSERT INTO users(email,ign,password) VALUES(?,'LegacyIGN','')").run('discord:' + LEGACY)).lastInsertRowid;
  await local.db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(legacy, LEGACY, 'legacy');
  // A website-verified member (distinct from the signing-in admin) who keeps the role.
  const verifiedMember = (await local.db.prepare("INSERT INTO users(email,ign,password) VALUES(?,'VerifiedIGN','')").run('discord:' + VERIFIED_MEMBER)).lastInsertRowid;
  await local.db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(verifiedMember, VERIFIED_MEMBER, 'verified');
  await local.db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,verified_at) VALUES(?,?,?,1,unixepoch())').run(VERIFIED_MEMBER, GUILD, 'verified');
  // The admin is the signed-in owner of this deployment.
  const owner = await local.signIn();
  const cookie = owner.cookie;
  const report = await local.api('/admin/verification-report', cookie);
  assert.equal(report.status, 200);
  const byId = Object.fromEntries(report.data.accounts.map(account => [account.discordId, account]));
  assert.equal(byId[LEGACY].action, 'remove-legacy-role');
  assert.equal(byId[VERIFIED_MEMBER].action, 'keep');
  // Nothing changed from the dry run.
  assert.equal(local.calls.removes.length, 0);
  // Cutover requires the typed phrase.
  assert.equal((await local.api('/admin/verification-cutover', cookie, { confirm: 'yes' })).status, 400);
  const cutover = await local.api('/admin/verification-cutover', cookie, { confirm: 'Remove legacy roles' });
  assert.equal(cutover.status, 200);
  assert.equal(cutover.data.removed, 1);
  assert.equal(local.calls.removes[0].userId, LEGACY);
  assert.equal((await local.api('/admin/verification-report', cookie)).data.accounts.length, 3);
  // Non-admins cannot run either tool.
  const outsider = await harness(t);
  const outsiderSession = await outsider.signIn();
  assert.equal((await outsider.api('/admin/verification-report', outsiderSession.cookie)).status, 403);
  assert.equal((await outsider.api('/admin/verification-cutover', outsiderSession.cookie, { confirm: 'Remove legacy roles' })).status, 403);
  assert.equal(local.calls.removes.length, 1);
});
