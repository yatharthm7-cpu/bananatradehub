require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes, PermissionFlagsBits: P } = require('discord.js');
const { roles, categories, panels, overwrites } = require('./blueprint');
const { configureApplicationEmojis, emoji } = require('./emojis');
const { brandedEmbed, welcomeComponents, panelLayout, websiteVerificationButton } = require('./presentation');
// Replaces {WEBSITE_URL} placeholders in panel/channel text. Empty when the
// owner has not published the site URL, which leaves the copy generic.
const fill = (text = '') => text.replace(/\{WEBSITE_URL\}/g, () => (process.env.WEBSITE_URL || '').trim().replace(/\/+$/, '') || 'the website');
const panelEmoji = { welcome: 'wave', rules: 'list', verify: 'lock', announcements: 'announce', guide: 'transcript', middlemen: 'shield', safety: 'warning', faq: 'question' };
const defaultRoot = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'plan';
const config = { token: process.env.DISCORD_TOKEN, guild: process.env.GUILD_ID, developer: process.env.DEVELOPER_USER_ID };
const validId = id => /^\d{17,20}$/.test(id || '');
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
async function main({ root = defaultRoot, api: suppliedApi, settings = config, runMode = mode, rebuild = false, onProgress = async () => {} } = {}) {
  const config = settings, mode = runMode;
  const website = (process.env.WEBSITE_URL || '').trim().replace(/\/+$/, '');
  if (!['plan', 'check', 'apply'].includes(mode)) throw new Error('Use plan, check, or apply.');
  if (mode === 'plan') {
    console.log(JSON.stringify({ roles: roles.map(r => r.name), categories, websiteUrl: website || null, missing: ['DISCORD_TOKEN', 'GUILD_ID', ...(website ? [] : ['WEBSITE_URL'])].filter(k => !process.env[k] || !website), verification: 'Website-only: accept rules on the website, bot grants Verified Member; IGN self-reported', emojiFilePresent: fs.existsSync(path.join(__dirname, 'emojis.js')) }, null, 2));
    return;
  }
  if (!config.token || !validId(config.guild)) throw new Error('Set DISCORD_TOKEN and an explicit GUILD_ID in .env. No server is inferred.');
  if (config.developer && !validId(config.developer)) throw new Error('Invalid DEVELOPER_USER_ID.');
  if (website && !/^https?:\/\/[\w.-]/.test(website)) throw new Error('WEBSITE_URL must be a full http(s) URL.');
  const api = suppliedApi || new REST({ version: '10', retries: 3, timeout: 15000 }).setToken(config.token);
  const g = `/guilds/${config.guild}`;
  const [bot, guild, currentRoles, channels, app] = await Promise.all([
    api.get(Routes.user()), api.get(g), api.get(`${g}/roles`), api.get(`${g}/channels`), api.get('/oauth2/applications/@me'),
  ]);
  if (!bot.bot) throw new Error('A supported bot token is required.');
  const member = await api.get(`${g}/members/${bot.id}`);
  const ownRoles = currentRoles.filter(r => member.roles.includes(r.id) || r.id === config.guild);
  const permissions = ownRoles.reduce((a, r) => a | BigInt(r.permissions), 0n);
  const required = [P.ManageGuild, P.ManageChannels, P.ManageRoles, P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers, P.ViewAuditLog, P.Connect, P.Speak, P.Stream, P.UseVAD, P.UseApplicationCommands, P.SendPolls];
  const missing = required.filter(p => !(permissions & p)).map(p => Object.keys(P).find(key => P[key] === p));
  if (!(permissions & P.Administrator) && missing.length) throw new Error(`Bot lacks required setup permissions: ${missing.join(', ')}.`);
  const highest = Math.max(...ownRoles.map(r => r.position));
  const highestRole = ownRoles.filter(r => r.position === highest).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)[0];
  if (highest < 1) throw new Error('Move the managed bot role above the roles it will configure.');
  if (config.developer) await api.get(`${g}/members/${config.developer}`);
  const file = path.join(root, 'data', `guild-${config.guild}.json`);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { guildId: config.guild, botId: bot.id, roles: {}, channels: {}, messages: {} };
  state.websiteUrl = website || null;
  if (state.guildId !== config.guild || state.botId !== bot.id) throw new Error('Saved state belongs to another guild or bot.');
  for (const r of roles) {
    const existing = currentRoles.find(x => x.id === state.roles[r.key]);
    if (existing && (existing.managed || existing.position > highest || (existing.position === highest && BigInt(existing.id) <= BigInt(highestRole.id)))) throw new Error(`Cannot manage role: ${r.name}. Move the bot role higher.`);
    if (!existing && currentRoles.some(x => x.name === r.name)) throw new Error(`Existing untracked role: ${r.name}. Review manually; it will not be adopted or overwritten.`);
  }
  for (const c of categories.flatMap(c => [{ key: c.key, name: c.name }, ...c.channels.map(([key, name]) => ({ key, name }))])) {
    if (!channels.some(x => x.id === state.channels[c.key]) && channels.some(x => x.name === c.name)) throw new Error(`Existing untracked channel/category: ${c.name}. Review manually.`);
  }
  const applicationEmoji = await api.get(`/applications/${app.id}/emojis`);
  const emojiSummary = configureApplicationEmojis(applicationEmoji.items || []);
  console.log(JSON.stringify({ guild: { id: guild.id, name: guild.name }, bot: bot.username, applicationEmojiCount: applicationEmoji.items?.length || 0, emojiMappings: emojiSummary.mapped, bannerSupported: guild.features.includes('BANNER'), administratorRoles: currentRoles.filter(r => BigInt(r.permissions) & P.Administrator).map(r => r.name), mode }, null, 2));
  if (mode === 'check') return;
  await onProgress('Access checked. Creating or updating roles and channels…');
  save(path.join(root, 'data', `backup-${Date.now()}.json`), { guild, roles: currentRoles, channels });
  const write = async (route, body, method = 'patch', files) => api[method](route, { body, ...(files ? { files } : {}), reason: 'BananaSMP trading hub setup' });
  const persist = () => save(file, state);
  if (rebuild) {
    await onProgress('Deleting bot-created channels and their messages before recreating them…');
    const tracked = new Set(Object.values(state.channels));
    for (const category of channels.filter(c => tracked.has(c.id) && c.type === 4)) {
      if (channels.some(c => c.parent_id === category.id && !tracked.has(c.id))) throw new Error('Existing untracked channels inside a setup category prevent rebuilding. Move them elsewhere first.');
    }
    const targets = channels.filter(c => tracked.has(c.id)).sort((a, b) => Number(a.type === 4) - Number(b.type === 4));
    for (const target of targets) {
      try { await api.delete(`/channels/${target.id}`, { reason: 'Owner requested channel rebuild' }); }
      catch (error) { if (error.status !== 404) throw error; }
      for (const [key, id] of Object.entries(state.channels)) if (id === target.id) { delete state.channels[key]; delete state.messages[key]; }
      persist();
    }
    state.channels = {}; state.messages = {}; persist();
    for (let i = channels.length - 1; i >= 0; i--) if (tracked.has(channels[i].id)) channels.splice(i, 1);
  }
  for (const r of [...roles].reverse()) {
    let id = state.roles[r.key];
    const body = { name: r.name, color: r.color, permissions: r.permissions, hoist: r.hoist ?? true, mentionable: false };
    if (!currentRoles.some(x => x.id === id)) {
      id = (await write(`${g}/roles`, body, 'post')).id;
      state.roles[r.key] = id; persist();
    } else await write(`${g}/roles/${id}`, body);
  }
  // Keep all five human roles below the bot, with the requested visible hierarchy.
  let updatedRoles = await api.get(`${g}/roles`);
  // Discord can return several roles at raw position 1 even when the client
  // orders them correctly by ID. A no-op move normalizes those raw positions
  // server-side before assigning distinct positions; do not move the bot itself.
  const positionsBefore = updatedRoles.filter(r => r.id !== config.guild).map(r => r.position);
  if (new Set(positionsBefore).size !== positionsBefore.length) {
    const anchor = updatedRoles.find(r => r.id === state.roles.verified);
    await write(`${g}/roles`, [{ id: anchor.id, position: anchor.position }]);
    updatedRoles = await api.get(`${g}/roles`);
  }
  const botPosition = Math.max(...updatedRoles.filter(r => member.roles.includes(r.id)).map(r => r.position));
  if (botPosition <= roles.length) throw new Error('Cannot manage role: move BananaTrade above the configured roles, then rerun /setup.');
  await write(`${g}/roles`, [...roles].reverse().map((r, i) => ({ id: state.roles[r.key], position: i + 1 })));
  for (const c of categories) {
    await onProgress(`Configuring ${c.name.toLowerCase()}…`);
    const categoryBody = { name: c.name, type: 4, permission_overwrites: overwrites(config.guild, state.roles, bot.id, c.access) };
    let parent = state.channels[c.key];
    if (!channels.some(x => x.id === parent)) {
      parent = (await write(`${g}/channels`, categoryBody, 'post')).id;
      state.channels[c.key] = parent; persist();
    } else await write(`/channels/${parent}`, categoryBody);
    for (const [key, name, topic, writable, type = 0] of c.channels) {
      // The verification channel is the staff-only audit log for website
      // sign-ins. Members never see a grant button here again.
      const isVerify = key === 'verify';
      const access = isVerify ? 'staff' : c.access;
      const body = { name, type, parent_id: parent, ...(type === 2 ? { bitrate: 64000, user_limit: key === 'trade_voice' ? 8 : 0 } : { topic: fill(topic), rate_limit_per_user: writable ? (c.access === 'support' ? 30 : 15) : 0 }), permission_overwrites: overwrites(config.guild, state.roles, bot.id, access, writable, type === 2) };
      let id = state.channels[key];
      if (!channels.some(x => x.id === id)) {
        id = (await write(`${g}/channels`, body, 'post')).id;
        state.channels[key] = id; persist();
      } else await write(`/channels/${id}`, body);
      if (panels[key]) {
        const [title, description] = panels[key];
        const layout = panelLayout(key, title, fill(description));
        const display = brandedEmbed(root, title, `${emoji(panelEmoji[key])} ${layout.description}`, { fields: layout.fields.map(field => ({ ...field, value: fill(field.value) })), banner: isVerify });
        const files = display.files.map(f => ({ name: f.name, data: f.attachment }));
        const urlComponents = isVerify ? websiteVerificationButton(website) : [];
        const payload = { embeds: display.embeds, attachments: files.map((file, id) => ({ id, filename: file.name })), components: urlComponents, allowed_mentions: { parse: [] } };
        const messageId = state.messages[key];
        if (messageId) {
          try { await write(`/channels/${id}/messages/${messageId}`, payload, 'patch', files); }
          catch (error) { if (error.status !== 404) throw error; delete state.messages[key]; }
        }
        if (!state.messages[key]) { state.messages[key] = (await write(`/channels/${id}/messages`, payload, 'post', files)).id; persist(); }
      }
    }
  }
  // On a fresh setup, verification is created after welcome. Patch the website
  // link in last; it stays correct after a rebuild too.
  await write(`/channels/${state.channels.welcome}/messages/${state.messages.welcome}`, { components: welcomeComponents(website) });
  const icon = fs.readFileSync(path.join(root, 'assets', 'BananaSMP_Icon.png')).toString('base64');
  const branding = { icon: `data:image/png;base64,${icon}`, verification_level: 3, explicit_content_filter: 2, default_message_notifications: 1 };
  let bannerApplied = false;
  if (process.env.APPLY_BANNER === 'true' && guild.features.includes('BANNER')) {
    const banner = fs.readFileSync(path.join(root, 'assets', 'BananaSMP_Banner.png'));
    const width = banner.readUInt32BE(16), height = banner.readUInt32BE(20);
    if (width < 960 || height < 540 || Math.abs(width / height - 16 / 9) > 0.02) throw new Error('Provide a 16:9 banner of at least 960x540 before enabling APPLY_BANNER.');
    branding.banner = `data:image/png;base64,${banner.toString('base64')}`;
    bannerApplied = true;
  }
  await write(g, branding);
  await api.put(`${g}/members/${guild.owner_id}/roles/${state.roles.owner}`, { reason: 'Guild owner display role' });
  if (config.developer && config.developer !== bot.id) await api.put(`${g}/members/${config.developer}/roles/${state.roles.developer}`, { reason: 'Configured developer display role' });
  const [afterRoles, afterChannels] = await Promise.all([api.get(`${g}/roles`), api.get(`${g}/channels`)]);
  for (const r of roles) {
    const live = afterRoles.find(x => x.id === state.roles[r.key]);
    if (!live || live.permissions !== r.permissions) throw new Error(`Verification failed for ${r.name}`);
  }
  const positions = roles.map(r => afterRoles.find(x => x.id === state.roles[r.key]).position);
  if (positions.some((p, i) => i && positions[i - 1] <= p)) throw new Error('Role hierarchy verification failed. Move the bot above the configured roles and retry.');
  for (const c of categories) {
    for (const [key, , , writable, type = 0] of c.channels) {
      const live = afterChannels.find(x => x.id === state.channels[key]);
      const access = key === 'verify' ? 'staff' : c.access;
      if (!live || live.type !== type || live.parent_id !== state.channels[c.key]) throw new Error(`Channel verification failed: ${key}`);
      if (!['public', 'support'].includes(access) && !live.permission_overwrites.some(o => o.id === config.guild && (BigInt(o.deny) & P.ViewChannel))) throw new Error(`Access verification failed: ${key}`);
      const expected = overwrites(config.guild, state.roles, bot.id, access, writable, type === 2);
      if (live.permission_overwrites.length !== expected.length || expected.some(o => !live.permission_overwrites.some(a => a.id === o.id && String(a.allow) === o.allow && String(a.deny) === o.deny))) throw new Error(`Permission readback failed: ${key}`);
    }
  }
  const result = { at: new Date().toISOString(), guildId: guild.id, websiteUrl: website || null, roles: roles.length, categories: categories.length, channels: categories.flatMap(c => c.channels).length, voiceChannels: categories.flatMap(c => c.channels).filter(c => c[4] === 2).length, verification: 'website-only-sign-in', bannerApplied };
  save(path.join(root, 'data', 'last-result.json'), result);
  console.log(`Applied and read back ${result.roles} human roles and ${result.channels} channels. Website-only verification is configured${website ? ` at ${website}/#verify` : ' (set WEBSITE_URL to publish the link)'}.`);
  return result;
}
if (require.main === module) main().catch(error => {
  // Never serialize REST error objects: these may contain request credentials.
  const message = error.status ? `Discord API request failed (HTTP ${error.status}, code ${error.code || 'unknown'}).` : error.message;
  console.error(message.replaceAll(config.token || '\0', '[REDACTED]'));
  process.exitCode = 1;
});
module.exports = { main };
