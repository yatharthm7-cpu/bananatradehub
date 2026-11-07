// One-shot authorized diagnostic for the automatic verification flow. Reads
// only (no role PUT): checks the exact REST steps grantVerifiedRole performs
// for the affected member, so the failing step is visible without side effects.
// Usage: node scripts/check-member-verification.js
require('dotenv').config({ quiet: true });
const { configuredDiscord, eligibility, grantVerifiedRole } = require('../website/discord');
const verification = require('../website/verification');

const TARGET = process.argv[2] || process.env.CHECK_MEMBER_ID;

(async () => {
  const discord = configuredDiscord();
  if (!discord) { console.log(JSON.stringify({ ok: false, error: 'Discord env incomplete' })); return process.exit(1); }
  const token = discord.botToken, guild = discord.guildId;
  const get = async path => {
    const response = await fetch('https://discord.com/api/v10' + path, { headers: { Authorization: 'Bot ' + token } });
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  };
  const out = { guild, target: TARGET };
  // The single-role route used by grantVerifiedRole's roleOf.
  const roleId = discord.roleId();
  const singleRole = await get(`/guilds/${guild}/roles/${roleId}`);
  out.singleRoleRoute = { status: singleRole.status, name: singleRole.body?.name, error: singleRole.body?.message };
  const rolesList = await get(`/guilds/${guild}/roles`);
  out.rolesList = { status: rolesList.status, count: rolesList.body?.length };
  const botMember = await get(`/guilds/${guild}/members/@me`);
  out.botMember = { status: botMember.status, roles: botMember.body?.roles };
  const targetMember = await get(`/guilds/${guild}/members/${TARGET}`);
  out.targetMember = { status: targetMember.status, roles: targetMember.body?.roles, joinedAt: targetMember.body?.joined_at, pending: targetMember.body?.pending, timeout: targetMember.body?.communication_disabled_until };
  const targetUser = await get(`/users/${TARGET}`);
  out.targetUser = { status: targetUser.status, bot: targetUser.body?.bot, id: targetUser.body?.id };
  // Run the real eligibility with the real token.
  const check = await verification.eligibility(discord, TARGET);
  out.eligibility = { eligible: check.eligible, reason: check.reason, eligibleAt: check.eligibleAt };
  console.log(JSON.stringify(out, null, 2));
})();
