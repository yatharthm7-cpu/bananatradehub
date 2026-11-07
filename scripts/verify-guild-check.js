// Ops script: one-shot authorized diagnostic for the verification role and
// audit channel. Requires a local .env with DISCORD_TOKEN, GUILD_ID,
// DISCORD_VERIFIED_ROLE_ID, and DISCORD_VERIFICATION_LOG_CHANNEL_ID.
// Prints only non-secret facts (names, snowflake IDs, permission bits).
// Usage: node scripts/verify-guild-check.js
require('dotenv').config({ quiet: true });
const { REST, Routes, PermissionFlagsBits: P } = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID, DISCORD_VERIFIED_ROLE_ID, DISCORD_VERIFICATION_LOG_CHANNEL_ID } = process.env;

async function main() {
  if (!DISCORD_TOKEN || !GUILD_ID || !DISCORD_VERIFIED_ROLE_ID || !DISCORD_VERIFICATION_LOG_CHANNEL_ID) {
    throw new Error('Missing DISCORD_TOKEN, GUILD_ID, DISCORD_VERIFIED_ROLE_ID, or DISCORD_VERIFICATION_LOG_CHANNEL_ID in .env.');
  }
  const rest = new REST({ version: '10', timeout: 10000 }).setToken(DISCORD_TOKEN);
  const out = {};
  const step = async (name, call) => {
    try { return await call(); } catch (error) { error.steps = [...(error.steps || []), name]; throw error; }
  };
  const guild = await step('guild', () => rest.get(Routes.guild(GUILD_ID)));
  out.guild = { id: guild.id, name: guild.name };
  const roles = await step('roles', () => rest.get(Routes.guildRoles(GUILD_ID)));
  const bot = await step('bot', () => rest.get(Routes.user()));
  const me = await step('member', () => rest.get(Routes.guildMember(GUILD_ID, bot.id)));
  const botHighest = Math.max(...me.roles.map(id => roles.find(r => r.id === id)?.position ?? -1));
  out.bot = { id: bot.id, username: bot.username, highestRolePosition: botHighest };
  out.roles = roles.filter(r => r.name !== '@everyone' && !r.managed).map(r => `${r.position}:${r.name}`).sort();
  const verified = roles.find(r => r.id === DISCORD_VERIFIED_ROLE_ID);
  out.verifiedRole = verified
    ? { id: verified.id, name: verified.name, position: verified.position, managed: verified.managed, grants: verified.position < botHighest ? 'bot-can-grant' : 'BOT-ROLE-TOO-LOW' }
    : 'NOT FOUND IN THIS GUILD';
  let channel = null;
  try { channel = await rest.get(Routes.channel(DISCORD_VERIFICATION_LOG_CHANNEL_ID)); }
  catch (error) { out.logChannelError = `HTTP ${error.status ?? 'unknown'}, code ${error.code ?? 'n/a'}`; }
  if (channel) {
    out.logChannel = { id: channel.id, name: channel.name, guildId: channel.guild_id, type: channel.type, matchesGuild: channel.guild_id === GUILD_ID };
    const overwrites = channel.permission_overwrites || [];
    const botOverwrite = overwrites.find(o => o.id === bot.id);
    const everyoneOverwrite = overwrites.find(o => o.id === GUILD_ID);
    const allow = BigInt(botOverwrite?.allow || 0);
    const deny = BigInt(botOverwrite?.deny || 0);
    const everyoneDeny = BigInt(everyoneOverwrite?.deny || 0);
    out.logChannelAccess = {
      botView: allow & P.ViewChannel ? 'allow' : deny & P.ViewChannel ? 'deny' : 'inherit',
      botSend: allow & P.SendMessages ? 'allow' : deny & P.SendMessages ? 'deny' : 'inherit',
      botEmbed: allow & P.EmbedLinks ? 'allow' : deny & P.EmbedLinks ? 'deny' : 'inherit',
      everyoneViewDenied: Boolean(everyoneDeny & P.ViewChannel),
    };
  }
  // Compare against the latest setup state on this machine, when present.
  const statePath = require('node:path').join(__dirname, '..', 'data', `guild-${GUILD_ID}.json`);
  const stateFile = require('node:fs').existsSync(statePath) ? JSON.parse(require('node:fs').readFileSync(statePath, 'utf8')) : null;
  if (stateFile) {
    out.setupState = { botId: stateFile.botId, verifyChannel: stateFile.channels?.verify, matchesEnvChannel: stateFile.channels?.verify === DISCORD_VERIFICATION_LOG_CHANNEL_ID,
      verifiedRole: stateFile.roles?.verified, matchesEnvRole: stateFile.roles?.verified === DISCORD_VERIFIED_ROLE_ID };
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch(error => {
  console.log(JSON.stringify({ ok: false, steps: error.steps || [], message: String(error.message || error).slice(0, 300), status: error.status || null, code: error.code || null }));
  process.exitCode = 1;
});
