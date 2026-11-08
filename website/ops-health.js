// Ops health: one sanitized roll-up of everything that has to be true for the
// marketplace and its verification flow to work, plus the config-drift canary.
//
// The sweep (GET /api/delivery-retry, cron-secret protected) persists a
// heartbeat on every fire and builds this roll-up for ?stats=1, so
// scripts/check-production.js can answer "is it healthy, and where is it not"
// in one command. Everything printed here is a non-secret fact: names, snowflake
// IDs, counts, timestamps, and error classes — never tokens, connection strings,
// auth headers, or full error text (which can embed URLs and credentials).
const path = require('node:path');
const { setupState } = require('../src/storage');

const HEARTBEAT_KEYS = {
  cron: 'cron_heartbeat',
  sweep: 'last_sweep',
  driftNotice: 'drift_notice_posted',
};
// The operator notice is rate limited per channel so a fast loop of authorized
// triggers (or a flapping condition) cannot spam the staff audit channel.
const DRIFT_NOTICE_MIN_GAP = 6 * 3600;
// A cron heartbeat older than this means the daily cron (and any authorized
// trigger) has not fired: the sweep is silent, not just empty.
const CRON_STALE_AFTER = 30 * 3600;

const TABLES_TO_COUNT = [
  ['users', 'users'], ['sessions', 'sessions'], ['discord_links', 'discordLinks'],
  ['website_verification_records', 'verificationRecords'], ['website_signin_events', 'signinEvents'],
  ['delivery_outbox', 'outbox'], ['listings', 'listings'], ['oauth_states', 'oauthStates'],
];

function deploySha(env = process.env) {
  // Vercel injects VERCEL_GIT_COMMIT_SHA; local and preview runs have none.
  const sha = String(env.VERCEL_GIT_COMMIT_SHA || '').trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 12) : null;
}

function sanitizeError(error) {
  const message = String(error?.message || error);
  // Transport errors from libSQL embed the connection URL, and any error can
  // carry unexpected detail: classify by phase and strip URLs rather than
  // forwarding raw text. Nothing here may reach an operator's terminal with a
  // credential or host string in it.
  const code = String(error?.code || '');
  const transport = /^(HTTP_|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|EPIPE|fetch|network|getaddrinfo|socket)/i
    .test(code + ' ' + message);
  const stripped = message.replace(/https?:\/\/\S+/g, '<url>').split('\n')[0].slice(0, 120);
  return {
    errorClass: transport ? 'database_unreachable' : 'discord_lookup',
    message: transport ? (code || 'transport error').slice(0, 60) : stripped,
  };
}

async function recordHeartbeat(db, key, at = Math.floor(Date.now() / 1000)) {
  await db.prepare('INSERT INTO ops_heartbeat(key, updated) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET updated=excluded.updated').run(key, at);
}

async function readHeartbeat(db, key) {
  const row = await db.prepare('SELECT updated FROM ops_heartbeat WHERE key=?').get(key);
  return row ? Number(row.updated) : null;
}

function safeSetupState(config, root = path.join(__dirname, '..')) {
  // The setup state lives wherever /setup ran (bot-side, usually local); on the
  // hosted app it is simply absent, which is reported, not treated as drift.
  try {
    return setupState(root, config.guildId) || null;
  } catch (error) {
    return { error: String(error.message).slice(0, 120) };
  }
}

function safeRoleId(config) {
  try {
    return config.roleId() || null;
  } catch (error) {
    return null;
  }
}

// The drift canary: the configured role and audit channel are compared against
// (a) the live guild, and (b) the last /setup state when it is available. Each
// warning is actionable — it names the detected change and the one command that
// fixes it. Mirrors the checks scripts/verify-guild-check.js performs offline.
function driftWarnings({ roleId, role, botHighest, channel, state, envChannelId }) {
  const warnings = [];
  if (!roleId) {
    warnings.push({ code: 'role_unconfigured', detail: 'No Verified role ID is configured or recorded for this guild.', fix: 'Run /setup, or set DISCORD_VERIFIED_ROLE_ID to the role /setup created.' });
  } else if (!role) {
    warnings.push({ code: 'role_missing', detail: `The Verified role ${roleId} no longer exists in the guild (deleted, or this is another guild's role).`, fix: 'Run /setup to recreate it, then point DISCORD_VERIFIED_ROLE_ID at the new role.' });
  } else if (role.managed) {
    warnings.push({ code: 'role_managed', detail: `The Verified role ${roleId} (${role.name}) is bot-managed and cannot be granted by this bot.`, fix: 'Run /setup to create a normal role, and re-point DISCORD_VERIFIED_ROLE_ID.' });
  } else if (botHighest !== null && role.position >= botHighest) {
    warnings.push({ code: 'bot_hierarchy_too_low', detail: `The Verified role ${roleId} (${role.name}, position ${role.position}) is at or above the bot's highest role (position ${botHighest}), so the bot cannot grant it.`, fix: 'Move the bot role above the Verified role in the guild, or rerun /setup.' });
  }
  if (!channel) {
    warnings.push({ code: 'audit_channel_invalid', detail: `DISCORD_VERIFICATION_LOG_CHANNEL_ID ${envChannelId || '(unset)'} is not a reachable text channel in this guild.`, fix: 'Run /setup to recreate the staff audit channel, then update DISCORD_VERIFICATION_LOG_CHANNEL_ID.' });
  }
  if (state && !state.error) {
    if (state.roles?.verified && roleId && state.roles.verified !== roleId) {
      warnings.push({ code: 'role_id_drift', detail: `/setup recorded role ${state.roles.verified}, but the app now resolves ${roleId}.`, fix: 'Re-run /setup, or set DISCORD_VERIFIED_ROLE_ID back to the role /setup created.' });
    }
    if (state.channels?.verify && envChannelId && state.channels.verify !== envChannelId) {
      warnings.push({ code: 'channel_id_drift', detail: `/setup recorded channel ${state.channels.verify}, but the env now uses ${envChannelId}.`, fix: 'Re-run /setup, or set DISCORD_VERIFICATION_LOG_CHANNEL_ID back to the channel /setup created.' });
    }
  }
  return warnings;
}

function driftNoticeEmbed(warnings, { guildId } = {}) {
  return {
    title: '⚠ Configuration drift detected',
    description: 'The ops sweep found configuration that no longer matches the live guild. Verification or audit delivery may already be failing.',
    color: 0xf59e0b,
    fields: warnings.slice(0, 6).map(warning => ({ name: warning.code, value: `${warning.detail}\nFix: ${warning.fix}`, inline: false })),
    footer: { text: `BananaSMP ops canary · guild ${guildId || ''}` },
    timestamp: new Date().toISOString(),
  };
}

// Posts the operator notice when drift is found, at most once per
// DRIFT_NOTICE_MIN_GAP. Returns what it did (posted | throttled | skipped),
// which the sweep reports back in its response.
async function postDriftNotice(db, warnings, { post, channelId }, now = Math.floor(Date.now() / 1000)) {
  if (!warnings.length || !post || !channelId) return 'skipped';
  const lastPosted = await readHeartbeat(db, HEARTBEAT_KEYS.driftNotice);
  if (lastPosted !== null && now - lastPosted < DRIFT_NOTICE_MIN_GAP) return 'throttled';
  try {
    await post(channelId, driftNoticeEmbed(warnings));
  } catch (error) {
    console.error('Drift notice post failed.', error.message);
    return 'failed';
  }
  await recordHeartbeat(db, HEARTBEAT_KEYS.driftNotice, now);
  return 'posted';
}

// The consolidated, sanitized roll-up. Each probe reports facts or a sanitized
// failure — never credentials — and `dbReachable` stays the single answer to
// "is the database switch real or is the table just empty".
async function opsHealth(db, config, deps = {}) {
  const rolesOf = deps.rolesOf;
  const memberOf = deps.memberOf;
  const channelOf = deps.channelOf;
  const logChannelId = deps.logChannelId !== undefined ? deps.logChannelId : config?.logChannelId;
  const state = deps.state !== undefined ? deps.state : (config ? safeSetupState(config) : null);
  const health = {
    generatedAt: Math.floor(Date.now() / 1000),
    deploySha: deploySha(deps.env),
    database: null,
    verifiedRole: null,
    auditChannel: null,
    drift: [],
  };

  try {
    if (deps.counts) {
      health.database = { reachable: true, counts: deps.counts };
    } else {
      const counts = {};
      for (const [table, key] of TABLES_TO_COUNT) {
        const row = await db.prepare(`SELECT count(*) AS total FROM ${table}`).get();
        counts[key] = Number(row.total);
      }
      // oauth_states is a persistence probe surface: rows are written by the
      // public login route and expire after 10 minutes, so a fresh row proves
      // the app write path and this read path share one database.
      health.database = { reachable: true, counts };
    }
  } catch (error) {
    health.database = { reachable: false, counts: null, ...sanitizeError(error) };
  }

  const read = async key => { try { return await readHeartbeat(db, key); } catch { return null; } };
  health.heartbeat = {
    cronHeartbeat: await read(HEARTBEAT_KEYS.cron),
    lastSweep: await read(HEARTBEAT_KEYS.sweep),
  };
  health.heartbeat.cronStaleAfter = CRON_STALE_AFTER;

  if (!config?.botToken) {
    health.discord = 'bot token not configured: role, channel, and drift probes skipped';
    return health;
  }
  if (!rolesOf || !memberOf) {
    health.discord = 'role and member probes unavailable in this build';
    return health;
  }

  let roles = null, me = null;
  try {
    [roles, me] = await Promise.all([rolesOf(config), memberOf(config, '@me')]);
  } catch (error) {
    health.verifiedRole = { checked: false, ...sanitizeError(error) };
    health.auditChannel = { checked: false, id: logChannelId || null };
    health.drift = [{ code: 'discord_lookup_failed', detail: 'The sweep could not read the guild (roles or bot member): ' + sanitizeError(error).message, fix: 'Check the bot token, guild ID, and Discord reachability, then re-run the sweep.' }];
    return health;
  }
  const botRoles = (me?.roles || []).map(id => roles.find(role => role.id === id));
  const botHighest = botRoles.length ? Math.max(...botRoles.map(role => role?.position ?? -1)) : null;
  const roleId = safeRoleId(config);
  const role = roleId ? roles.find(candidate => candidate.id === roleId) : null;
  health.bot = { id: me?.user?.id || me?.id || null, highestRolePosition: botHighest };
  health.verifiedRole = role
    ? { checked: true, id: role.id, name: role.name, position: role.position, managed: Boolean(role.managed), botCanGrant: botHighest === null ? 'unknown' : role.position < botHighest }
    : { checked: true, id: roleId, present: false };

  let channel = null;
  if (channelOf && logChannelId) {
    try { channel = await channelOf(config, logChannelId); } catch (error) { channel = null; }
  }
  health.auditChannel = channel
    ? { checked: true, validated: true, id: channel.id, name: channel.name, sameGuild: channel.guild_id === config.guildId }
    : { checked: true, validated: false, id: logChannelId || null };

  health.drift = driftWarnings({ roleId, role, botHighest, channel, state, envChannelId: logChannelId });
  health.setupState = state && state.error ? { error: state.error } : state ? { compared: true } : { compared: false, note: 'no local setup state for this guild' };
  return health;
}

module.exports = {
  HEARTBEAT_KEYS, CRON_STALE_AFTER, DRIFT_NOTICE_MIN_GAP,
  recordHeartbeat, readHeartbeat, opsHealth, driftWarnings, driftNoticeEmbed, postDriftNotice, deploySha,
};
