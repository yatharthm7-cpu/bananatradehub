require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Events, REST } = require('discord.js');
const { createHandler } = require('./slash-command');
const { createSetupHandler } = require('./setup-command');
const { register } = require('./register-commands');
const { Community } = require('./community');
const { startDeliveryWorker } = require('./delivery-worker');
async function start({ registerCommands = true } = {}) {
  const token = process.env.DISCORD_TOKEN, guildId = process.env.GUILD_ID;
  if (!token || !/^\d{17,20}$/.test(guildId || '')) throw new Error('Set DISCORD_TOKEN and GUILD_ID locally in .env first.');
  const file = path.join(__dirname, '..', 'data', `guild-${guildId}.json`);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (state && state.guildId !== guildId) throw new Error('Saved setup state belongs to another server.');
  const api = new REST({ version: '10' }).setToken(token);
  const app = await api.get('/oauth2/applications/@me');
  const membersEnabled = Boolean(app.flags & ((1 << 14) | (1 << 15)));
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildInvites, ...(membersEnabled ? [GatewayIntentBits.GuildMembers] : [])] });
  const community = new Community({ client, root: path.join(__dirname, '..'), guildId, developerUserId: process.env.DEVELOPER_USER_ID, membersEnabled });
  client.community = community;
  const handler = createHandler({ guildId, token, developerUserId: process.env.DEVELOPER_USER_ID, developerRoleId: () => {
    if (!fs.existsSync(file)) return undefined;
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return latest.guildId === guildId && latest.botId === client.user?.id ? latest.roles?.developer : undefined;
  } });
  const setupHandler = createSetupHandler({ guildId, token, developerUserId: process.env.DEVELOPER_USER_ID });
  client.once(Events.ClientReady, ready => {
    if (state && state.botId !== ready.user.id) { console.error('Saved setup state belongs to another bot.'); client.destroy(); process.exitCode = 1; return; }
    console.log(`Trading bot online as ${ready.user.username}. Server: ${guildId}`);
    client.communityReady = community.initialize().then(() => true).catch(() => { console.error('Community startup failed. Check data files and bot permissions.'); return false; });
    // Phase 2: drive durable website DM deliveries from this persistent process.
    client.deliveryWorker = startDeliveryWorker({ token });
  });
  client.on(Events.InteractionCreate, interaction => {
    const selected = interaction.commandName === 'setup' ? setupHandler : interaction.commandName === 'emoji-import' ? handler : i => community.handle(i);
    selected(interaction).catch(() => console.error('Could not respond to a Discord command.'));
  });
  client.on(Events.Error, () => console.error('Discord connection error.'));
  client.on(Events.GuildMemberAdd, member => community.onJoin(member).catch(() => console.error('Member join processing failed.')));
  client.on(Events.GuildMemberRemove, member => community.onLeave(member).catch(() => console.error('Member leave processing failed.')));
  client.on(Events.InviteCreate, invite => {
    if (invite.guild?.id !== guildId || !community.store.data.inviteSnapshot) return;
    community.store.data.inviteSnapshot[invite.code] = { uses: invite.uses || 0, inviterId: invite.inviter?.id || null };
    try { community.store.save(); } catch { console.error('Could not save the invite tracking snapshot.'); }
  });
  client.on(Events.InviteDelete, invite => {
    if (invite.guild?.id !== guildId || !community.store.data.inviteSnapshot) return;
    delete community.store.data.inviteSnapshot[invite.code];
    try { community.store.save(); } catch { console.error('Could not save the invite tracking snapshot.'); }
  });
  const destroy = client.destroy.bind(client);
  client.destroy = () => { community.stop(); client.deliveryWorker?.stop(); return destroy(); };
  process.once('SIGINT', () => client.destroy());
  process.once('SIGTERM', () => client.destroy());
  // Upsert both guild commands on startup, so a separate registration is optional.
  if (registerCommands) await register({ token, guildId });
  await client.login(token);
  return client;
}
if (require.main === module) start().catch(() => { console.error('Bot startup failed. Check local credentials, target server, and connectivity.'); process.exitCode = 1; });
module.exports = { start };
