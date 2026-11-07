const fs = require('node:fs');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const COLOR = 0xf5d547;
function files(root, banner = false) {
  const items = [{ attachment: fs.readFileSync(path.join(root, 'assets', 'BananaSMP_Icon.png')), name: 'banana-logo.png' }];
  if (banner) items.push({ attachment: fs.readFileSync(path.join(root, 'assets', 'BananaSMP_Banner.png')), name: 'banana-banner.png' });
  return items;
}
function brandedEmbed(root, title, description, { banner = false, color = COLOR, fields = [] } = {}) {
  const format = text => text.replace(/(^|\n)#{1,6}\s+([^\n]+)/g, '$1**$2**');
  return { embeds: [{ author: { name: 'BananaSMP • Trading Hub', icon_url: 'attachment://banana-logo.png' }, title, description: format(description), color, ...(banner ? { image: { url: 'attachment://banana-banner.png' } } : {}), ...(fields.length ? { fields: fields.map(field => ({ inline: true, ...field, value: format(field.value) })) } : {}), footer: { text: 'BananaTrade • Stay safe' } }], files: files(root, banner), allowedMentions: { parse: [] } };
}
function panelLayout(key, title, description) {
  const layouts = {
    verify: { description: '**Verification happens on the website.**\nRead the rules, accept them, and sign in with Discord at the link below. The bot grants **Verified Member** automatically once you meet the requirements.', fields: [
      { name: 'Before you begin', value: 'Account **24 hours old**\nJoined **10 minutes ago**\nScreening complete • No timeout' },
      { name: 'Your member access', value: 'Trade discussions & voice\nCommunity giveaways & polls\nHelp from the team' },
      { name: 'Protect your account', value: 'We never ask for passwords, tokens, or login codes. Verification grants Discord access only; your Minecraft IGN is self-reported and ownership is not checked.', inline: false },
      { name: 'This channel', value: 'Staff-only audit log. Every website sign-in is recorded here automatically.', inline: false },
    ] },
    welcome: { description: 'Welcome to the community. Get started in three steps:', fields: [
      { name: '01 · Read', value: 'Check the server rules.' }, { name: '02 · Verify', value: 'Accept the rules and sign in on the website.' }, { name: '03 · Explore', value: 'Chat, join VCs, and get help.' },
      { name: 'Trading status', value: 'Website requests and escrow are not open yet.', inline: false },
    ] },
    faq: { description: 'Quick answers for new members.', fields: [
      { name: 'Get access', value: 'Sign in on the website: account 24h+, joined 10m+, screening complete, no timeout.' },
      { name: 'Get help', value: 'Use help-desk, bug-reports, or suggestions. Keep private evidence out of public chat.' },
      { name: 'Minecraft & trading', value: 'IGNs are self-reported. Website requests and escrow are not open yet.', inline: false },
    ] },
    guide: { description: 'Agree on the details before sending items or payments.', fields: [
      { name: 'IGN & terms', value: 'IGNs are self-reported. Record exact items, quantities, and terms.' },
      { name: 'Staff identity', value: 'Check actual server roles. Names, screenshots, and DMs can be copied.' },
      { name: 'Know the limits', value: 'Website escrow is not open. Middleman custody carries risk; Discord cannot detect duplicated items.', inline: false },
    ] },
  };
  return { title, description, fields: [], ...layouts[key] };
}
function brandedContainer(root, title, body, { banner = false, color = COLOR } = {}) {
  return { flags: MessageFlags.IsComponentsV2, components: [{ type: 17, accent_color: color, components: [
    { type: 9, components: [{ type: 10, content: `## ${title}` }], accessory: { type: 11, media: { url: 'attachment://banana-logo.png' }, description: 'BananaSMP logo' } },
    { type: 14, divider: true, spacing: 1 }, { type: 10, content: body },
    ...(banner ? [{ type: 12, items: [{ media: { url: 'attachment://banana-banner.png' }, description: 'BananaSMP banner' }] }] : []),
    { type: 14, divider: true, spacing: 1 }, { type: 10, content: '-# BananaSMP • Trading Hub' },
  ] }], files: files(root, banner), allowedMentions: { parse: [] } };
}
// Website-only verification. The rules acceptance and the Verified Member
// grant both happen on the website; the bot never grants the role itself, so
// rerunning /setup can never recreate a Discord verification button.
function verificationComponents() { return []; }
function websiteVerificationButton(websiteUrl) {
  if (!websiteUrl) return [];
  const url = websiteUrl.replace(/\/+$/, '') + '/#verify';
  return [{ type: 1, components: [{ type: 2, style: 5, label: 'Sign in with Discord', emoji: { name: '🔐' }, url }] }];
}
function welcomeComponents(websiteUrl) { return websiteVerificationButton(websiteUrl); }
function welcomeMessage(root, member, state, { template, inviterId } = {}) {
  const rules = state?.channels.rules ? `<#${state.channels.rules}>` : 'the server rules';
  const website = state?.websiteUrl || process.env.WEBSITE_URL;
  const message = template ? greeting(template, member) : `👋 Welcome <@${member.id}> to **BananaSMP | Trading Hub**!`;
  const payload = brandedEmbed(root, 'A new trader has arrived!', `${message}\n${template?.includes('{count}') ? '' : `You are member **#${member.guild.memberCount}**.\n`}Read ${rules}, then verify on the website to join the community.\n**Invited by:** ${inviterId && inviterId !== member.id ? `<@${inviterId}> (tracked)` : 'Unknown / not tracked'}`, { fields: [{ name: 'Next steps', value: `1. Read ${rules}\n2. Accept the rules and sign in with Discord on the website${website ? ` (${website.replace(/\/+$/, '')}/#verify)` : ''}\n3. Explore discussions, giveaways, polls, and VCs`, inline: false }] });
  const avatar = member.user.displayAvatarURL?.({ size: 128, extension: 'png' });
  if (avatar) payload.embeds[0].thumbnail = { url: avatar };
  payload.embeds[0].footer = { text: 'BananaSMP • Connect. Trade carefully. Stay safe.', icon_url: 'attachment://banana-logo.png' };
  payload.embeds[0].timestamp = new Date().toISOString();
  payload.components = welcomeComponents(website);
  payload.allowedMentions = { parse: [], users: [member.id] };
  return payload;
}
function greeting(template, member) {
  const replacements = { user: `<@${member.id}>`, username: member.user.username, server: member.guild.name, count: String(member.guild.memberCount) };
  return template.replace(/\{(user|username|server|count)\}/g, (_, key) => replacements[key]);
}
module.exports = { brandedEmbed, brandedContainer, verificationComponents, websiteVerificationButton, welcomeComponents, welcomeMessage, greeting, panelLayout, COLOR };
