// Website-only verification: eligibility assessment, safe verified-role grant,
// authoritative record writes, and the staff sign-in audit embed.
//
// Every Discord fact is fetched server-side through the bot token. Nothing the
// browser sends is trusted for the decision. The notification inbox and this
// audit log are the durable records; the Discord role is the visible effect.
//
// States: none -> authenticated_pending -> role_assignment_pending -> verified
//         | blocked (not eligible now)            | revoked (was verified, no
//         longer eligible) -> role_assignment_pending again when eligible.

const { randomBytes } = require('node:crypto');
const { transaction } = require('./db');
const outbox = require('./outbox');
const {
  guildMember: defaultMemberOf, publicUser: defaultUserOf,
  fetchRole: defaultRoleOf, guildRoles: defaultRolesOf, assignRole: defaultAssign,
} = require('./discord');

const ACCOUNT_MIN_SECONDS = 24 * 60 * 60;
const MEMBER_MIN_SECONDS = 10 * 60;
const DEFAULT_RULES_VERSION = 1;
const BRAND = 'BananaSMP • Trading Hub';

const REASONS = {
  not_member: 'Join the BananaSMP Discord server first, then sign in again.',
  screening: 'Complete Discord membership screening, then sign in again.',
  timeout: 'Your Discord timeout must expire before verification can continue.',
  bot: 'Bot accounts cannot verify.',
  account_age: 'Your Discord account must be at least 24 hours old.',
  member_age: 'Stay in the server for 10 minutes after joining, then try again.',
  suspended: 'Your marketplace access is suspended by staff.',
  missing_record: 'Complete website verification to unlock listings and offers.',
  revoked: 'Your website verification is no longer active; sign in again.',
  role_failed: 'The Verified Member role could not be granted right now. Try again shortly.',
  unavailable: 'Discord verification is temporarily unavailable. Try again shortly.',
};

function snowflakeCreated(id) {
  try { return Number((BigInt(id) >> 22n) / 1000n) + 1420070400; }
  catch { return null; }
}

function rulesVersion() {
  const value = Number(process.env.RULES_VERSION);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RULES_VERSION;
}

function operationId() { return randomBytes(12).toString('hex'); }

function clean(value, max = 1000) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '?').replace(/[@<>]/g, '').slice(0, max).trim();
}

function fmt(seconds) {
  return Number.isInteger(seconds) && seconds > 0 ? `<t:${seconds}> (<t:${seconds}:R>)` : 'Unknown';
}

function avatarUrl(user) {
  if (!user?.id) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
  try { return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`; }
  catch { return null; }
}

// Authoritative eligibility from Discord itself. The caller decides what a
// failed lookup means; a network failure is never treated as ineligibility.
async function eligibility(config, discordId, { memberOf, userOf } = {}) {
  const member = await (memberOf || defaultMemberOf)(config, discordId);
  const user = await (userOf || defaultUserOf)(config, discordId);
  const now = Math.floor(Date.now() / 1000);
  const fail = reason => ({ eligible: false, reason, eligibleAt: null, member, user });
  if (!member) return fail('not_member');
  if (!user) return fail('not_member');
  if (user.bot) return fail('bot');
  if (member.pending) return fail('screening');
  if (member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now()) return fail('timeout');
  const joined = Math.floor(Date.parse(member.joined_at) / 1000);
  const account = snowflakeCreated(user.id);
  if (account !== null && now - account < ACCOUNT_MIN_SECONDS) {
    return { eligible: false, reason: 'account_age', eligibleAt: account + ACCOUNT_MIN_SECONDS, member, user };
  }
  if (Number.isFinite(joined) && now - joined < MEMBER_MIN_SECONDS) {
    return { eligible: false, reason: 'member_age', eligibleAt: joined + MEMBER_MIN_SECONDS, member, user };
  }
  return { eligible: true, reason: null, eligibleAt: null, member, user };
}

// All safety checks before the single idempotent PUT that grants the role.
async function grantVerifiedRole(config, discordId, { memberOf, roleOf, rolesOf, assign } = {}) {
  const me = await (memberOf || defaultMemberOf)(config, '@me');
  if (!me) throw Object.assign(new Error('The bot is not a member of this server.'), { code: 'bot_missing' });
  let roleId;
  try { roleId = config.roleId(); }
  catch { throw Object.assign(new Error('The Verified Member role is not configured.'), { code: 'role_unconfigured' }); }
  const role = await (roleOf || defaultRoleOf)(config, roleId);
  if (!role) throw Object.assign(new Error('The Verified Member role is missing.'), { code: 'role_missing' });
  if (role.managed) throw Object.assign(new Error('The Verified Member role is bot-managed.'), { code: 'role_managed' });
  const all = await (rolesOf || defaultRolesOf)(config);
  const position = id => all.find(item => item.id === id)?.position ?? -1;
  const botHighest = Math.max(-1, ...me.roles.map(position));
  if (role.position >= botHighest) throw Object.assign(new Error('The bot role sits below Verified Member.'), { code: 'hierarchy' });
  const admin = value => (BigInt(value || '0') & 8n) === 8n;
  if (admin(role.permissions) && !me.roles.some(id => admin(all.find(item => item.id === id)?.permissions))) {
    throw Object.assign(new Error('Only administrator bots may grant an administrator role.'), { code: 'role_forbidden' });
  }
  await (assign || defaultAssign)(config, discordId, roleId);
  return { roleId, granted: true };
}

function loadRecord(db, discordId, guildId) {
  return db.prepare('SELECT state,fail_reason,eligible_at,rules_version,verified_at,operation_id,updated FROM website_verification_records WHERE discord_id=? AND guild_id=?')
    .get(discordId, guildId);
}

// Upsert keyed on (discord_id, guild_id). Never backfills a record for a user
// who has not signed in: rows are only created by sign-in or refresh flows.
function writeRecord(db, { guildId, discordId, state, reason = null, eligibleAt = null, opId = null, verifiedAt = null, rulesVer = null }) {
  return db.prepare(`INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,rules_consent_at,eligible_at,fail_reason,verified_at,operation_id,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())
    ON CONFLICT(discord_id,guild_id) DO UPDATE SET state=excluded.state,
      eligible_at=excluded.eligible_at, fail_reason=excluded.fail_reason,
      verified_at=COALESCE(excluded.verified_at, website_verification_records.verified_at),
      operation_id=excluded.operation_id, rules_version=COALESCE(excluded.rules_version, website_verification_records.rules_version),
      updated=unixepoch()`)
    .run(discordId, guildId, state, rulesVer, rulesVer ? Math.floor(Date.now() / 1000) : null, eligibleAt, reason, verifiedAt, opId);
}

// Records one durable sign-in event. The unique event_key makes replays,
// reloads, and duplicate worker reports collapse into one embed. Returns true
// only when a brand-new event was inserted, which is also the only case that
// queues a delivery, so a log-channel failure can never duplicate the embed.
async function queueEvent(db, { guildId, discordId, userId, eventType, ref, embed, channelId, websiteUrl }) {
  const eventKey = `signin:${discordId}:${ref}`;
  const inserted = await db.prepare('INSERT OR IGNORE INTO website_signin_events(event_key,discord_id,event_type,event_ref) VALUES(?,?,?,?)')
    .run(eventKey, discordId, eventType, ref);
  if (!inserted.changes || !channelId || !embed) return false;
  await outbox.queue(db, [{ eventKey, userId, discordId, content: eventType,
    link: websiteUrl ? new URL('/#verify', websiteUrl).href : '/', channelId, embedJson: JSON.stringify(embed) }]);
  return true;
}

// The professional staff audit embed. Field values come from the authoritative
// assessment only. No secrets, tokens, emails, or private evidence appear here,
// and no mentions are ever parsed on the Discord side. Branding uses the
// publicly served site logo (HTTPS) so no local file attachment is needed.
function signInEmbed({ eventType, user, member, status, ign, ref, reasonText, method = 'Discord OAuth (website)', websiteUrl }) {
  const avatar = avatarUrl(user);
  const fields = [
    { name: 'Status', value: clean(status, 200), inline: true },
    { name: 'Discord user ID', value: clean(user?.id, 32), inline: true },
    ...(ign ? [{ name: 'Minecraft IGN', value: clean(ign, 16), inline: true }] : []),
    { name: 'Account created', value: fmt(snowflakeCreated(user?.id)), inline: true },
    { name: 'Joined server', value: fmt(Math.floor(Date.parse(member?.joined_at) / 1000)), inline: true },
    { name: 'Event time', value: fmt(Math.floor(Date.now() / 1000)), inline: true },
    { name: 'Method', value: clean(method, 100), inline: true },
    ...(reasonText ? [{ name: 'Reason', value: clean(reasonText, 400), inline: false }] : []),
    { name: 'Reference', value: clean(ref, 80) || 'n/a', inline: false },
  ];
  const logo = websiteUrl ? String(websiteUrl).replace(/\/+$/, '') + '/logo.png' : null;
  return {
    title: clean(eventType, 240),
    color: 0xba77f5,
    ...(avatar ? { author: { name: clean(user?.global_name || user?.username, 80) || 'Discord user', icon_url: avatar } } : {}),
    ...(user?.username ? { description: 'Discord username: ' + clean(user.username, 40) } : {}),
    fields,
    footer: { text: BRAND + ' · website verification', ...(logo && /^https:\/\//.test(logo) ? { icon_url: logo } : {}) },
    timestamp: new Date().toISOString(),
  };
}

async function assess(db, config, { discordId, userId, suspended, ign, rulesVer, channelId, websiteUrl, pendingEmbed = true }, deps) {
  let check;
  try { check = await eligibility(config, discordId, deps); }
  catch { return { outcome: 'unavailable', record: null }; }
  const when = unix => (Number.isInteger(unix) && unix > 0 ? new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : null);
  if (suspended) {
    const reason = 'suspended';
    await transaction(db, async () => {
      await writeRecord(db, { guildId: config.guildId, discordId, state: 'blocked', reason, opId: operationId(), rulesVer });
    });
    return { outcome: 'blocked', reason, eligibleAt: null, check };
  }
  if (!check.eligible) {
    const prior = await loadRecord(db, discordId, config.guildId);
    const state = prior?.state === 'verified' ? 'revoked' : 'blocked';
    const ref = `${state}:${check.reason}:${check.eligibleAt || 0}`;
    await transaction(db, async () => {
      const opId = operationId();
      await writeRecord(db, { guildId: config.guildId, discordId, state, reason: check.reason, eligibleAt: check.eligibleAt, opId, rulesVer });
      return queueEvent(db, { guildId: config.guildId, discordId, userId, eventType: 'Website sign-in — verification pending',
        ref, embed: pendingEmbed ? deps.embedFor({ eventType: 'Website sign-in — verification pending', user: check.user, member: check.member,
          status: 'Verification pending', ign, ref, reasonText: REASONS[check.reason] + (check.eligibleAt ? ` Eligible ${when(check.eligibleAt)}.` : ''), websiteUrl }) : null,
        channelId, websiteUrl });
    });
    return { outcome: state, reason: check.reason, eligibleAt: check.eligibleAt, check };
  }
  return { outcome: 'eligible', check };
}

// Full sign-in: assess, then optionally grant. Embeds for every stage are
// queued inside the record's transaction, so a crash between the record and
// the channel post cannot lose or duplicate the audit entry. A failure to
// grant the role or post the embed never blocks the sign-in itself.
async function processSignIn(db, config, { userId, discordId, ign, suspended, rulesVer, channelId, websiteUrl }, deps = {}, { signInEmbed: signInEmbedOn = true, pendingEmbed = true } = {}) {
  const guildId = config.guildId;
  const assessment = await assess(db, config, { discordId, userId, suspended, ign, rulesVer, channelId, websiteUrl, pendingEmbed }, deps);
  if (assessment.outcome !== 'eligible') return assessment;
  const { check } = assessment;
  const prior = await loadRecord(db, discordId, guildId);
  if (prior?.state === 'verified') {
    const roleId = safeRoleId(config, check);
    if (!roleId || !check.member.roles?.includes(roleId)) {
      try { await grantVerifiedRole(config, discordId, deps); }
      catch { return { outcome: 'role_failed', reason: 'role_failed', record: prior, check }; }
    }
    const ref = operationId();
    await transaction(db, async () => {
      await writeRecord(db, { guildId, discordId, state: 'verified', rulesVer });
      return queueEvent(db, { guildId, discordId, userId, eventType: 'Website sign-in', ref,
        embed: signInEmbedOn ? deps.embedFor({ eventType: 'Website sign-in', user: check.user, member: check.member,
          status: 'Verified Member', ign, ref, websiteUrl }) : null, channelId, websiteUrl });
    });
    return { outcome: 'verified', check, record: await loadRecord(db, discordId, guildId) };
  }
  const opId = prior?.operation_id && (prior.state === 'role_assignment_pending' || prior.state === 'role_assignment_failed') ? prior.operation_id : operationId();
  await transaction(db, async () => {
    await writeRecord(db, { guildId, discordId, state: 'role_assignment_pending', opId, rulesVer });
    return queueEvent(db, { guildId, discordId, userId, eventType: 'Website sign-in — verification pending', ref: opId,
      embed: pendingEmbed ? deps.embedFor({ eventType: 'Website sign-in — verification pending', user: check.user, member: check.member,
        status: 'Verification in progress', ign, ref: opId, websiteUrl }) : null, channelId, websiteUrl });
  });
  try { await grantVerifiedRole(config, discordId, deps); }
  catch (error) {
    // Persist the failure: an indefinite "in progress" state would hide a
    // grant error from both the member and staff. The opId is kept so a later
    // refresh completes this same operation and emits one completed event.
    await transaction(db, async () => {
      await writeRecord(db, { guildId, discordId, state: 'role_assignment_failed', reason: 'role_failed', opId, rulesVer });
    });
    return { outcome: 'role_failed', reason: 'role_failed', code: error.code, opId, check };
  }
  await transaction(db, async () => {
    await writeRecord(db, { guildId, discordId, state: 'verified', verifiedAt: Math.floor(Date.now() / 1000), opId: opId, rulesVer });
    return queueEvent(db, { guildId, discordId, userId, eventType: 'Website verification completed', ref: opId + '-complete',
      embed: deps.embedFor({ eventType: 'Website verification completed', user: check.user, member: check.member,
        status: 'Verified Member granted', ign, ref: opId, websiteUrl }), channelId, websiteUrl });
  });
  return { outcome: 'verified', opId, check, record: await loadRecord(db, discordId, guildId) };
}

function safeRoleId(config, check) {
  try { return config.roleId(); }
  catch { return null; }
}

// Durable sweep for sign-ins interrupted between the Discord role grant and
// the persisted completion — the crash window a member cannot heal themselves
// and no browser visit is required to reach. Executed by the cron-protected
// retry route (Vercel cron or an authorized ops trigger), so it runs in
// production without any user activity. Idempotent and safe to repeat: the
// completed audit event deduplicates on the operation id (queueEvent's unique
// event_key), records still genuinely pending (ineligible, unconfigured role,
// transient Discord failure) are left for the next pass, and the per-record
// outcome is read back from the record after the write.
async function reconcileStuck(db, config, { channelId, websiteUrl }, deps = {}) {
  const summary = { attempted: 0, completed: 0, granted: 0, skipped: 0, records: [] };
  const rows = await db.prepare(`SELECT discord_id, operation_id FROM website_verification_records
    WHERE state IN ('role_assignment_pending','role_assignment_failed') AND updated < unixepoch() - 120
    ORDER BY updated LIMIT 50`).all();
  for (const row of rows) {
    summary.attempted += 1;
    const outcome = { discordId: row.discord_id, operationId: row.operation_id, completed: false };
    try {
      const check = await eligibility(config, row.discord_id, deps);
      const roleId = safeRoleId(config, check);
      if (!check.eligible || !roleId) {
        summary.skipped += 1;
        outcome.reason = !check.eligible ? `not_eligible:${check.reason}` : 'role_unconfigured';
        summary.records.push(outcome);
        continue;
      }
      let grantedNow = false;
      if (!check.member.roles?.includes(roleId)) {
        await grantVerifiedRole(config, row.discord_id, deps);
        grantedNow = true;
        summary.granted += 1;
      }
      const account = await db.prepare('SELECT u.id, u.ign FROM users u JOIN discord_links l ON l.user_id=u.id WHERE l.discord_id=?').get(row.discord_id);
      if (!account) throw new Error('no linked account for this record');
      await transaction(db, async () => {
        await writeRecord(db, { guildId: config.guildId, discordId: row.discord_id, state: 'verified',
          verifiedAt: Math.floor(Date.now() / 1000), opId: row.operation_id, rulesVer: rulesVersion() });
        return queueEvent(db, { guildId: config.guildId, discordId: row.discord_id, userId: account.id,
          eventType: 'Website verification completed', ref: row.operation_id + '-complete',
          embed: deps.embedFor({ eventType: 'Website verification completed', user: check.user, member: check.member,
            status: 'Verified Member granted', ign: account.ign || null, ref: row.operation_id, websiteUrl }),
          channelId, websiteUrl });
      });
      summary.completed += 1;
      outcome.grantedNow = grantedNow;
      const after = await loadRecord(db, row.discord_id, config.guildId);
      outcome.state = after?.state ?? null;
      outcome.verifiedAt = after?.verified_at ?? null;
    } catch (error) {
      // Transient Discord or database failure: keep the record as-is; the next
      // cron pass retries. The cause is carried back for the operator.
      summary.skipped += 1;
      outcome.reason = String(error?.code ?? error?.status ?? error?.message ?? error).slice(0, 120);
    }
    summary.records.push(outcome);
  }
  return summary;
}

// Bounded re-check used by the on-page status timer and by protected actions.
// Never re-posts the sign-in embed; it only completes or repairs the record.
async function refresh(db, config, { userId, discordId, ign, suspended, rulesVer, channelId, websiteUrl }, deps = {}) {
  const record = await loadRecord(db, discordId, config.guildId);
  if (record?.state === 'verified') {
    let check;
    try { check = await eligibility(config, discordId, deps); }
    catch { return { outcome: 'unavailable', record }; }
    if (!check.eligible) {
      await transaction(db, async () => {
        await writeRecord(db, { guildId: config.guildId, discordId, state: 'revoked', reason: check.reason, eligibleAt: check.eligibleAt, opId: operationId(), rulesVer });
      });
      return { outcome: 'revoked', reason: check.reason, eligibleAt: check.eligibleAt, record };
    }
    const roleId = safeRoleId(config, check);
    if (roleId && check.member.roles?.includes(roleId)) {
      if (record.rules_version !== rulesVer) await transaction(db, async () => { await writeRecord(db, { guildId: config.guildId, discordId, state: 'verified', rulesVer }); });
      return { outcome: 'verified', record };
    }
    try { await grantVerifiedRole(config, discordId, deps); }
    catch { return { outcome: 'role_failed', reason: 'role_failed', record }; }
    await transaction(db, async () => { await writeRecord(db, { guildId: config.guildId, discordId, state: 'verified', rulesVer }); });
    return { outcome: 'verified', record: await loadRecord(db, discordId, config.guildId) };
  }
  return processSignIn(db, config, { userId, discordId, ign, suspended, rulesVer, channelId, websiteUrl }, deps, { signInEmbed: false, pendingEmbed: false });
}

async function verificationView(db, { discordId, guildId }) {
  const row = await loadRecord(db, discordId, guildId);
  if (!row) return { state: 'none', reason: null, eligibleAt: null, verified: false, message: REASONS.missing_record, rulesVersion: null, updatedAt: null, delivery: null };
  const verified = row.state === 'verified';
  const message = verified ? null : REASONS[row.fail_reason] || REASONS.missing_record;
  // The latest durable delivery for this account separates "verified" from
  // "verified and the staff audit reached the channel": a failed embed must
  // never make a verified member look unverified, but it should stay visible.
  const delivery = await db.prepare(`SELECT state FROM delivery_outbox WHERE discord_id=? ORDER BY id DESC LIMIT 1`).get(discordId) || null;
  return { state: row.state, reason: row.fail_reason, eligibleAt: row.eligible_at, verified, message, rulesVersion: row.rules_version, updatedAt: row.updated, delivery: delivery?.state || null };
}

// Dry-run migration report for the owner: for every linked Discord account,
// show the authoritative record state and the role state. Nothing is changed.
async function migrationReport(config, links, { memberOf = defaultMemberOf } = {}) {
  const report = [];
  for (const link of links) {
    let member = null;
    try { member = await memberOf(config, link.discord_id); }
    catch { report.push({ discordId: link.discord_id, username: link.username, recordState: link.record_state, roleHeld: null, action: 'unknown', note: 'Discord lookup failed' }); continue; }
    const roleHeld = Boolean(member?.roles?.includes(safeRoleId(config, {})));
    report.push({ discordId: link.discord_id, username: link.username, recordState: link.record_state, roleHeld, action: cutoverAction(link.record_state, roleHeld) });
  }
  return report;
}

function cutoverAction(recordState, roleHeld) {
  if (recordState === 'verified') return roleHeld ? 'keep' : 'repair-role';
  if (roleHeld) return 'remove-legacy-role';
  return 'keep';
}

module.exports = {
  REASONS, ACCOUNT_MIN_SECONDS, MEMBER_MIN_SECONDS, DEFAULT_RULES_VERSION,
  rulesVersion, operationId, eligibility, grantVerifiedRole,
  loadRecord, writeRecord, queueEvent, signInEmbed, processSignIn, refresh,
  verificationView, migrationReport, cutoverAction, reconcileStuck,
};
