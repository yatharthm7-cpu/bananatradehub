const { PermissionFlagsBits: P } = require('discord.js');
const bits = (...values) => values.reduce((a, b) => a | b, 0n).toString();
const read = [P.ViewChannel, P.ReadMessageHistory];
const write = [...read, P.SendMessages, P.AddReactions, P.EmbedLinks, P.AttachFiles];
const preferenceRoles = [
  { key: 'java', name: 'Java' }, { key: 'bedrock', name: 'Bedrock' },
  { key: 'cracked', name: 'Cracked' }, { key: 'premium', name: 'Premium' },
  { key: 'updates', name: 'Updates' }, { key: 'giveaways_alert', name: 'Giveaways' },
  { key: 'poll_alert', name: 'Poll' }, { key: 'announcement_alert', name: 'Announcement' },
  { key: 'trade_radar', name: 'Trade Radar' },
];
const roles = [
  { key: 'owner', name: 'Owner', color: 0xf1c40f, permissions: bits(...write, P.ManageGuild, P.ManageChannels, P.ManageRoles, P.ViewAuditLog, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers) },
  { key: 'developer', name: 'Developer', color: 0x9b59b6, permissions: bits(...write, P.ViewAuditLog) },
  { key: 'moderator', name: 'Moderator', color: 0xe67e22, permissions: bits(...write, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers, P.ViewAuditLog) },
  { key: 'middleman', name: 'Middleman', color: 0x2ecc71, permissions: bits(...write) },
  { key: 'verified', name: 'Verified Member', color: 0xf5d547, permissions: bits(...write) },
  ...preferenceRoles.map(role => ({ ...role, color: 0, permissions: '0', hoist: false })),
];
const categories = [
  { key: 'start', name: 'START HERE', access: 'public', channels: [
    ['welcome', '🍌│welcome', 'Official BananaSMP trading hub. Start with the rules and verification status.'],
    ['rules', '📜│rules', 'Trading rules, custody risks, and impersonation precautions.'],
    ['verify', '🔐│verification', 'Staff-only audit log for website sign-ins. Members verify at {WEBSITE_URL}/#verify.'],
  ] },
  { key: 'hub', name: 'TRADING HUB', access: 'verified', channels: [
    ['announcements', '📣│announcements', 'Official trading service updates.'],
    ['trade_feed', '📡│trade-radar', 'New approved website listings. Use /roles to opt into Trade Radar alerts.'],
    ['guide', '📖│trading-guide', 'How trading and middleman custody will work.'],
    ['middlemen', '🛡️│official-middlemen', 'Check the actual Middleman role; names and avatars can be copied.'],
    ['discussion', '💬│trade-discussion', 'General trade discussion only. Requests and escrow will use the future website.', true],
    ['safety', '⚠️│safety-notices', 'Staff-published scam and safety alerts. No public accusations or personal information.'],
    ['giveaways', '🎉│giveaways', 'Verified-member giveaways. Prizes and conditions are stated on each giveaway.'],
    ['polls', '📊│polls', 'Official community polls. Cast your vote below a poll.'],
  ] },
  { key: 'support_area', name: 'SUPPORT', access: 'support', channels: [
    ['faq', '❓│faq', 'Answers to common trading, verification, and bot questions.'],
    ['help', '🆘│help-desk', 'Shared support, including verification access problems. Never post secrets or private evidence.', true],
    ['bugs', '🐛│bug-reports', 'Describe issues and steps to reproduce. Report security exploits privately to the owner.', true],
    ['suggestions', '💡│suggestions', 'Suggestions for improving the trading community.', true],
  ] },
  { key: 'voice_area', name: 'VOICE LOUNGES', access: 'verified', channels: [
    ['lounge', '🔊│lounge', '', true, 2],
    ['trade_voice', '🤝│trade-lounge', '', true, 2],
    ['support_voice', '🎙️│support-lounge', '', true, 2],
  ] },
  { key: 'staff_area', name: 'STAFF', access: 'staff', channels: [
    ['staff', '🔧│staff-room', 'Private moderation coordination.', true],
    ['logs', '📋│setup-log', 'Private setup records.'],
    ['staff_voice', '🔒│staff-voice', '', true, 2],
  ] },
];
const panels = {
  faq: ['Your questions, answered', '### How do I get access?\nRead the rules, accept them, and **Sign in with Discord** on the website at {WEBSITE_URL}/#verify. Your Discord account must be **24 hours old** and you must have joined **10 minutes ago**. Complete any Discord membership screening first.\n\n### Is my Minecraft account verified?\nNo. You will provide your **IGN during a trade**, and it is **self-reported**. Never treat an IGN as proof of ownership.\n\n### Where can I get help?\nUse **help-desk** for questions, **bug-reports** for issues, and **suggestions** for ideas. Share private evidence only with a real Moderator.\n\n### Can I trade now?\nWebsite requests and escrow are still under development. Discussion, giveaways, polls, and voice rooms are available after verification.'],
  welcome: ['Welcome to BananaSMP Trading Hub', '### Your place to connect and trade carefully\nJoin the community, find help, take part in giveaways, and discuss trades.\n\n**01 · Read the rules**\nUnderstand the conduct and account-safety rules.\n\n**02 · Verify your Discord access**\nRead and accept the rules on the website, then **Sign in with Discord** at {WEBSITE_URL}/#verify.\n\n**03 · Explore the community**\nCheck announcements, meet members, and use the help desk when you need support.\n\n> Website trading requests and escrow are not open yet. Staff will announce the launch here.'],
  rules: ['Trading rules', '• No duped items, exploits, scams, impersonation, spam, or unsolicited advertising.\n• Never share passwords, login codes, recovery codes, or tokens.\n• No public doxxing or accusations; contact a real Moderator through their profile.\n• Requests and escrow will use the website, not Discord tickets or per-trade channels.\n• A middleman holds assets and can still lose or misuse them. This service is not a guarantee against loss.\n• Discord verification cannot detect or prevent duplicated Minecraft items.'],
  verify: ['Website-only verification', '### Read. Accept. Sign in.\nVerification happens on the website: read the rules, accept them, and **Sign in with Discord** at {WEBSITE_URL}/#verify. The bot grants **Verified Member** automatically once you meet the requirements.\n\n**Requirements**\n• Discord account at least **24 hours old**\n• Member of this server for at least **10 minutes**\n• Discord membership screening completed, if enabled\n• No active timeout\n\n**You will receive**\nVerified Member access to the trading discussion, giveaways, polls, and voice rooms.\n\n> **Discord access only.** This does not verify your email, phone, identity, or Minecraft account. Your IGN during a trade is self-reported. Do not send passwords or login codes.\n\nThis channel is the staff-only audit log: every website sign-in is recorded here automatically.'],
  announcements: ['Service status', 'Discord preparation is underway. Website trading requests and middleman escrow are not available yet. Staff will announce the launch here.'],
  guide: ['Before you trade', '### Agree on the details first\n**IGN** · Each trader supplies their Minecraft IGN. It is self-reported; Discord verification does not prove ownership.\n**Terms** · Record exact items, quantities, and the agreed exchange.\n**Staff** · Check actual server roles instead of trusting a name, screenshot, or DM.\n\n### Current service status\nThe future website will handle requests and intermediary workflow. Until it launches, Discord discussion and private messages are **not approved escrow requests**.\n\n> Middleman custody still carries loss and abuse risk. Discord cannot detect duplicated Minecraft items.'],
  middlemen: ['Check staff identity', 'Only members carrying this server’s actual Middleman role are designated middlemen. A copied username, avatar, screenshot, or DM is not proof. Designation does not guarantee custody safety. No middleman accounts are assigned by this setup.'],
  safety: ['Protect your account and items', 'Check staff roles inside this server. Do not use links or payment instructions from unexpected DMs. Keep original evidence and contact a Moderator privately if something is wrong. Never post private account or payment details here.'],
};
function overwrites(guildId, ids, botId, access, writable = false, voice = false) {
  const publicAccess = ['public', 'support'].includes(access);
  const publicPosting = access === 'support' && writable;
  const voiceBits = voice ? [P.Connect, P.Speak, P.Stream, P.UseVAD] : [];
  const denied = bits(P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads, P.MentionEveryone);
  const result = [{ id: guildId, type: 0, allow: publicAccess ? bits(...read, P.UseApplicationCommands, ...(publicPosting ? [P.SendMessages, P.AddReactions] : [])) : '0', deny: bits(...(publicAccess ? [] : [P.ViewChannel]), ...(publicPosting ? [P.AttachFiles, P.EmbedLinks] : [P.SendMessages]), ...voiceBits, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads, P.MentionEveryone) }];
  for (const key of ['owner', 'developer', 'moderator', ...(access === 'staff' ? [] : ['middleman', 'verified'])]) {
    const canWrite = writable || ['owner', 'developer', 'moderator'].includes(key);
    result.push({ id: ids[key], type: 0, allow: bits(...(canWrite ? write : read), P.UseApplicationCommands, ...voiceBits), deny: canWrite ? bits(P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads, P.MentionEveryone) : denied });
  }
  result.push({ id: botId, type: 1, allow: bits(...write, P.ManageMessages, ...voiceBits), deny: '0' });
  return result;
}
module.exports = { roles, preferenceRoles, categories, panels, overwrites, bits };
