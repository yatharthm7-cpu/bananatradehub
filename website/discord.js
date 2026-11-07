const { setupState } = require('../src/storage');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

function configuredDiscord(env = process.env) {
  const { DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret, DISCORD_REDIRECT_URI: redirectUri, GUILD_ID: guildId } = env;
  const id = value => /^\d{17,20}$/.test(value || '');
  if (!id(clientId) || !clientSecret || !redirectUri || !id(guildId)) return null;
  const url = new URL(redirectUri);
  if (url.pathname !== '/api/discord/callback' || url.search || url.hash || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('Set DISCORD_REDIRECT_URI to the website callback URL.');
  }
  const adminIds = (env.DISCORD_ADMIN_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (adminIds.some(value => !id(value))) throw new Error('DISCORD_ADMIN_USER_IDS must contain Discord user IDs.');
  const feedChannelId = env.DISCORD_TRADE_FEED_CHANNEL_ID;
  const tradeRadarRoleId = env.DISCORD_TRADE_RADAR_ROLE_ID;
  const logChannelId = env.DISCORD_VERIFICATION_LOG_CHANNEL_ID;
  if ([feedChannelId, tradeRadarRoleId, logChannelId].some(value => value && !id(value))) throw new Error('Set numeric Trade Radar and verification log IDs.');
  return { clientId, clientSecret, redirectUri, guildId, adminIds, feedChannelId, tradeRadarRoleId, logChannelId, botToken: env.DISCORD_TOKEN, roleId: () => {
    const role = env.DISCORD_VERIFIED_ROLE_ID || setupState(path.join(__dirname, '..'), guildId)?.roles?.verified;
    if (!id(role)) throw new Error('Configure the Discord Verified Member role ID.');
    return role;
  } };
}

function authorize(config, state) {
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: 'identify guilds.members.read', state,
  });
}

async function discordIdentity(config, code, request = fetch) {
  const tokenResponse = await request('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: 'authorization_code', code, redirect_uri: config.redirectUri,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenResponse.ok) throw new Error('Discord authorization exchange failed.');
  const { access_token: accessToken } = await tokenResponse.json();
  if (!accessToken) throw new Error('Discord authorization exchange failed.');
  const get = route => request('https://discord.com/api/v10' + route, {
    headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(8000),
  });
  const [profile, membership] = await Promise.all([get('/users/@me'), get('/users/@me/guilds/' + config.guildId + '/member')]);
  if (!profile.ok || (!membership.ok && membership.status !== 404)) throw new Error('Discord membership lookup failed.');
  const user = await profile.json();
  const member = membership.ok ? await membership.json() : null;
  if (!/^\d{17,20}$/.test(user.id) || typeof user.username !== 'string' || user.bot) throw new Error('Discord returned an invalid identity.');
  return {
    id: user.id, username: user.username,
    verified: Boolean(member && !member.pending && member.roles?.includes(config.roleId())),
  };
}
async function verifiedMember(config, userId) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await fetch('https://discord.com/api/v10/guilds/' + config.guildId + '/members/' + userId, {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Discord membership lookup failed.');
  const member = await response.json();
  return Boolean(!member.pending && !(Date.parse(member.communication_disabled_until) > Date.now()) && member.roles?.includes(config.roleId()));
}
function tradeMessenger(config) {
  if (!config?.botToken) return null;
  const api = new REST({ version: '10', timeout: 8000 }).setToken(config.botToken);
  return async (recipient, tradeId, message) => {
    const channel = await api.post(Routes.userChannels(), { body: { recipient_id: recipient } });
    const url = new URL('/trade/' + tradeId, config.redirectUri);
    await api.post(Routes.channelMessages(channel.id), { body: {
      content: `**BananaSMP Trading Hub** · Trade #${tradeId}\n${message}\n<${url}>`,
      allowed_mentions: { parse: [] },
    } });
  };
}
function listingMessenger(config) {
  if (!config?.botToken) return null;
  const api = new REST({ version: '10', timeout: 8000 }).setToken(config.botToken);
  return async listing => {
    const state = config.feedChannelId && config.tradeRadarRoleId ? null : setupState(path.join(__dirname, '..'), config.guildId);
    const channel = config.feedChannelId || state?.channels.trade_feed;
    const role = config.tradeRadarRoleId || state?.roles.trade_radar;
    if (!channel || !role) throw new Error('Trade Radar is not configured.');
    const url = new URL('/#market?listing=' + listing.id, config.redirectUri);
    await api.post(Routes.channelMessages(channel), { body: {
      content: `<@&${role}>`,
      embeds: [{ title: listing.item, url: url.href, color: 0xba77f5,
        description: 'New approved marketplace listing',
        fields: [
          { name: 'Category', value: listing.category, inline: true },
          { name: 'Quantity', value: String(listing.quantity), inline: true },
          { name: 'Seller IGN', value: listing.seller, inline: true },
          { name: 'Looking for', value: listing.wants },
        ] }],
      allowed_mentions: { parse: [], roles: [role] },
      nonce: `listing-${listing.id}`, enforce_nonce: true,
    } });
  };
}
// --- Website-only verification support -------------------------------------
// All verification data comes from authoritative Discord sources through the
// bot token on the server. Browser-supplied IDs or flags are never trusted.

async function guildMember(config, userId, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/guilds/' + config.guildId + '/members/' + userId, {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Discord membership lookup failed.');
  return response.json();
}

async function publicUser(config, userId, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/users/' + userId, {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Discord user lookup failed.');
  return response.json();
}

async function fetchRole(config, roleId, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/guilds/' + config.guildId + '/roles/' + roleId, {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Discord role lookup failed.');
  return response.json();
}

async function guildRoles(config, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/guilds/' + config.guildId + '/roles', {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Discord role lookup failed.');
  return response.json();
}

// Idempotent by Discord's contract: adding a role the member already holds
// succeeds without changing anything. Never call this before safety checks.
async function assignRole(config, userId, roleId, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/guilds/' + config.guildId + '/members/' + userId + '/roles/' + roleId, {
    method: 'PUT', headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (!response.ok && response.status !== 204) throw Object.assign(new Error('Discord role assignment failed.'), { status: response.status });
}

async function removeRole(config, userId, roleId, request = fetch) {
  if (!config?.botToken) throw new Error('Bot token missing.');
  const response = await request('https://discord.com/api/v10/guilds/' + config.guildId + '/members/' + userId + '/roles/' + roleId, {
    method: 'DELETE', headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (!response.ok && response.status !== 204) throw Object.assign(new Error('Discord role removal failed.'), { status: response.status });
}

// Validates the configured audit channel: same guild, a supported text type,
// and visible to the bot (an invisible channel fails this very GET). The
// staff-only design from the setup blueprint denies @everyone's View Channel,
// which is expected and accepted — the audit log is never public, and the
// bot's own Send/Embed access is proven by delivery, not guessed here: a
// failed post becomes a durable, retryable job with a recorded last_error
// instead of silently disabling the audit log.
async function channelBelongsToGuild(config, channelId, request = fetch) {
  if (!config?.botToken || !/^\d{17,20}$/.test(channelId || '')) return null;
  const response = await request('https://discord.com/api/v10/channels/' + channelId, {
    headers: { Authorization: 'Bot ' + config.botToken }, signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (!response.ok) return null;
  const channel = await response.json();
  if (channel.guild_id !== config.guildId || ![0, 5].includes(channel.type)) return null;
  return channel;
}

// Posts a prepared embed object to the verification log channel. The embed is
// built server-side from authoritative data and never contains credentials.
function verificationLogMessenger(config) {
  if (!config?.botToken) return null;
  const api = new REST({ version: '10', timeout: 8000 }).setToken(config.botToken);
  return async (channelId, embed) => {
    const message = await api.post(Routes.channelMessages(channelId), { body: {
      embeds: [embed], allowed_mentions: { parse: [] },
    } });
    return message.id;
  };
}

module.exports = { configuredDiscord, authorize, discordIdentity, verifiedMember, tradeMessenger, listingMessenger, guildMember, publicUser, fetchRole, guildRoles, assignRole, removeRole, channelBelongsToGuild, verificationLogMessenger };
