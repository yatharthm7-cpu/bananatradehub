const { randomInt } = require('node:crypto');
const { MessageFlags, Routes } = require('discord.js');
const { Store, setupState } = require('./storage');
const { brandedEmbed, brandedContainer, greeting, welcomeMessage } = require('./presentation');
const { commands } = require('./community-commands');
const { preferenceRoles } = require('./blueprint');
const names = new Set(commands.map(c => c.name));
const MIN_ACCOUNT_MS = 24 * 60 * 60 * 1000;
const MIN_JOIN_MS = 10 * 60 * 1000;
function verificationProblem(member, now = Date.now()) {
  if (member.user.bot) return 'Bots cannot verify.';
  if (member.pending) return 'Complete Discord’s membership screening first, then try again.';
  if (member.communicationDisabledUntilTimestamp > now) return 'You cannot verify while timed out.';
  if (!member.user.createdTimestamp || now - member.user.createdTimestamp < MIN_ACCOUNT_MS) return 'Your Discord account must be at least 24 hours old.';
  if (!member.joinedTimestamp || now - member.joinedTimestamp < MIN_JOIN_MS) return 'Wait until you have been in this server for 10 minutes, then try again.';
  return null;
}
function pollAnswers(text) {
  const answers = text.split('|').map(a => a.trim());
  if (answers.length < 2 || answers.length > 10 || answers.some(a => !a || a.length > 55) || new Set(answers.map(a => a.toLowerCase())).size !== answers.length) throw new Error('Use 2–10 different answers, each 1–55 characters, separated by |.');
  return answers.map(text => ({ poll_media: { text } }));
}
function inviteAttribution(previous, current) {
  if (!previous) return null;
  const changed = Object.entries(current).filter(([code, item]) => item.uses > (previous[code]?.uses || 0));
  if (changed.length !== 1) return null;
  const [code, item] = changed[0];
  // A newly observed invite may already have uses from a period we missed.
  return previous[code] && item.uses - previous[code].uses === 1 ? item.inviterId || null : null;
}
function pickWinners(candidates, count, choose = randomInt) {
  const pool = [...new Set(candidates)];
  const winners = [];
  while (pool.length && winners.length < count) winners.push(pool.splice(choose(pool.length), 1)[0]);
  return winners;
}
class Community {
  constructor({ client, root, guildId, developerUserId, store = new Store(root, guildId), membersEnabled = false }) {
    Object.assign(this, { client, root, guildId, developerUserId, store, membersEnabled });
    this.locks = new Set(); this.joinQueue = Promise.resolve(); this.invitesHealthy = false;
  }
  state() { return setupState(this.root, this.guildId, this.client.user?.id); }
  async guild() { return this.client.guilds.fetch(this.guildId); }
  isStaff(member, state, ownerId) {
    return member.id === ownerId || member.id === this.developerUserId || ['developer', 'moderator'].some(k => state?.roles[k] && member.roles.cache.has(state.roles[k]));
  }
  async invitesSnapshot(guild) {
    const invites = await guild.invites.fetch();
    return Object.fromEntries([...invites.values()].map(invite => [invite.code, { uses: invite.uses || 0, inviterId: invite.inviter?.id || null }]));
  }
  async initialize() {
    const guild = await this.guild();
    try { this.store.data.inviteSnapshot = await this.invitesSnapshot(guild); this.invitesHealthy = true; }
    catch { this.store.data.inviteSnapshot = null; this.invitesHealthy = false; console.error('Invite tracking unavailable: check Manage Server permission.'); }
    this.store.save();
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(() => console.error('Giveaway recovery check failed.')), 15000);
    this.timer.unref();
    if (!this.membersEnabled) console.error('Greetings and invite join/leave tracking need Server Members Intent enabled in the Developer Portal. Other commands are available.');
  }
  stop() { clearInterval(this.timer); }
  onJoin(member) {
    if (member.guild.id !== this.guildId) return Promise.resolve();
    this.joinQueue = this.joinQueue.catch(() => {}).then(() => this.processJoin(member));
    return this.joinQueue;
  }
  async processJoin(member) {
    const state = this.state();
    const previous = this.store.data.inviteMembers[member.id];
    if (previous?.joinedAt === member.joinedTimestamp) return;
    let inviterId = null;
    try {
      const current = await this.invitesSnapshot(member.guild);
      inviterId = inviteAttribution(this.store.data.inviteSnapshot, current);
      this.store.data.inviteSnapshot = current; this.invitesHealthy = true;
    } catch { this.store.data.inviteSnapshot = null; this.invitesHealthy = false; }
    // Rejoins never generate another referral credit for the same account.
    const rejoin = Boolean(previous);
    this.store.data.inviteMembers[member.id] = { inviterId: rejoin ? previous.inviterId : (member.user.bot || inviterId === member.id ? null : inviterId), joinedAt: member.joinedTimestamp, active: true, rejoined: rejoin };
    this.store.save();
    const config = this.store.data.greet;
    if (!config.enabled || member.user.bot) return;
    const channelId = config.channelId || state?.channels.welcome;
    if (!channelId) return;
    try {
      const channel = await member.guild.channels.fetch(channelId);
      const payload = welcomeMessage(this.root, member, state, { template: config.template, inviterId });
      await channel.send(payload);
    } catch { console.error('Greeting could not be sent. Check the configured welcome channel and permissions.'); }
  }
  onLeave(member) {
    if (member.guild.id !== this.guildId) return Promise.resolve();
    this.joinQueue = this.joinQueue.catch(() => {}).then(() => {
      const item = this.store.data.inviteMembers[member.id];
      if (item) { item.active = false; this.store.save(); }
    });
    return this.joinQueue;
  }
  async verify(interaction, state, member) {
    if (!state?.roles.verified) throw new Error('The owner must run /setup before verification can open.');
    if (interaction.isButton() && interaction.message.id !== state.messages.verify) throw new Error('This verification panel is outdated. Verification is website-only now; use the link in welcome.');
    // Website-only verification: the bot never grants the Verified Member
    // role. Legacy button presses and cached /verify invocations are answered
    // with a redirect, so no old handler can grant anything.
    const website = state?.websiteUrl || process.env.WEBSITE_URL;
    if (!website) throw new Error('Website verification is not configured. Ask the owner to set WEBSITE_URL and rerun /setup.');
    const link = website.replace(/\/+$/, '') + '/#verify';
    const problem = verificationProblem(member);
    if (problem) return `${problem}\nSign in at ${link} once the requirement is met.`;
    return `Verification is handled on the website. Read the rules, accept them, and **Sign in with Discord** at ${link} to receive **Verified Member**. The role is granted automatically.`;
  }
  async target(interaction, state, fallback) {
    const selected = interaction.options.getChannel('channel');
    const channel = selected || await interaction.guild.channels.fetch(state?.channels[fallback] || interaction.channelId);
    if (!channel || channel.guildId !== this.guildId || ![0, 5].includes(channel.type) || !channel.send) throw new Error('Choose a text channel in this server.');
    return channel;
  }
  giveawayPayload(giveaway, ended = false) {
    const result = brandedEmbed(this.root, ended ? 'Giveaway results' : 'BananaSMP Giveaway', `### ${giveaway.prize}\n\n${ended ? (giveaway.winners.length ? `**Winners**\n${giveaway.winners.map(id => `<@${id}>`).join(', ')}` : '**No eligible entrants were available.**') : `**Ends** <t:${Math.floor(giveaway.endsAt / 1000)}:R>\n**Winners** ${giveaway.count}\n\nPress **Enter giveaway** below. One entry per verified member; bots and the host cannot enter.`}`, { fields: [{ name: 'Hosted by', value: `<@${giveaway.hostId}>`, inline: true }, { name: 'Entries', value: ended ? String(giveaway.entrants.length) : 'Saved per member; total shown at the end', inline: true }] });
    result.components = [{ type: 1, components: [{ type: 2, style: ended ? 2 : 3, label: ended ? 'Giveaway ended' : 'Enter giveaway', custom_id: 'giveaway:enter', disabled: ended, emoji: { name: '🎉' } }] }];
    result.allowedMentions = { parse: [], users: ended ? giveaway.winners : [] };
    return result;
  }
  async enter(interaction, state, member) {
    const item = this.store.data.giveaways[interaction.message.id];
    if (!item || item.status !== 'running' || item.endsAt <= Date.now()) return 'This giveaway has ended or is unavailable.';
    if (member.user.bot || member.id === item.hostId || !state?.roles.verified || !member.roles.cache.has(state.roles.verified) || member.pending || member.communicationDisabledUntilTimestamp > Date.now()) return 'You need Verified Member access to enter. Bots, timed-out members, and the host cannot enter.';
    if (item.entrants.includes(member.id)) return 'You are already entered. One entry per member.';
    item.entrants.push(member.id); this.store.save();
    return '🎉 You are entered! Your entry is saved even if the bot restarts.';
  }
  async draw(id, reroll = false) {
    if (this.locks.has(id)) throw new Error('This giveaway is already being processed.');
    this.locks.add(id);
    try {
      const item = this.store.data.giveaways[id];
      if (!item) throw new Error('That giveaway is not tracked by this bot.');
      if (reroll && (item.status !== 'ended' || item.deliveryPending)) throw new Error('Finish and publish this giveaway before rerolling.');
      if (item.status === 'running' || reroll) {
        const guild = await this.guild(); const state = this.state(); const eligible = [];
        const excluded = new Set(reroll ? item.previousWinners || [] : []);
        for (const userId of item.entrants) {
          let member;
          try { member = await guild.members.fetch({ user: userId, force: true }); }
          catch (error) { if (error.code === 10007) continue; throw error; }
          if (!excluded.has(userId) && !member.user.bot && !member.pending && !(member.communicationDisabledUntilTimestamp > Date.now()) && state?.roles.verified && member.roles.cache.has(state.roles.verified)) eligible.push(userId);
        }
        item.winners = pickWinners(eligible, item.count);
        item.previousWinners = [...new Set([...(item.previousWinners || []), ...item.winners])];
        item.status = 'ended'; item.deliveryPending = true; item.endedAt = Date.now();
        this.store.save(); // Persist the draw before delivery; retries never redraw.
      }
      if (item.deliveryPending) {
        const channel = await this.client.channels.fetch(item.channelId);
        const message = await channel.messages.fetch(id);
        await message.edit({ ...this.giveawayPayload(item, true), attachments: [] });
        item.deliveryPending = false; this.store.save();
      }
      return item;
    } finally { this.locks.delete(id); }
  }
  async tick() {
    for (const [id, item] of Object.entries(this.store.data.giveaways)) {
      if (this.locks.has(id)) continue;
      if ((item.status === 'running' && item.endsAt <= Date.now()) || item.deliveryPending) {
        try { await this.draw(id); }
        catch (error) {
          // A deleted channel/message is terminal, not an endless retry loop.
          if ([10003, 10008].includes(error.code)) { item.deliveryPending = false; item.status = 'unavailable'; this.store.save(); }
          console.error('Giveaway result pending or unavailable; inspect /bot-status and the giveaway channel.');
        }
      }
    }
  }
  async handle(interaction) {
    const verifyButton = interaction.isButton() && interaction.customId === 'verify:rules:v1';
    const verifyCommand = interaction.isChatInputCommand() && interaction.commandName === 'verify';
    const entryButton = interaction.isButton() && interaction.customId === 'giveaway:enter';
    if (!verifyButton && !verifyCommand && !entryButton && !(interaction.isChatInputCommand() && names.has(interaction.commandName))) return;
    if (!interaction.inGuild() || interaction.guildId !== this.guildId) return interaction.reply({ content: 'Use this command in the configured BananaSMP server.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      const guild = await this.guild();
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      const state = this.state();
      if (verifyButton || verifyCommand) return await respond(await this.verify(interaction, state, member));
      if (entryButton) return await respond(await this.enter(interaction, state, member));
      if (interaction.commandName === 'roles') {
        const choice = preferenceRoles.find(role => role.key === interaction.options.getString('role'));
        const id = choice && state?.roles[choice.key];
        if (!id) return await respond('This role is unavailable. Ask the owner to run /setup.');
        const enabled = interaction.options.getBoolean('enabled', true);
        if (enabled && choice.key === 'trade_radar' && !member.roles.cache.has(state.roles.verified)) {
          return await respond('Complete website verification before subscribing to Trade Radar.');
        }
        const role = await guild.roles.fetch(id, { force: true });
        if (!role || role.managed || role.permissions.bitfield !== 0n) return await respond('This role is unavailable for self-assignment.');
        if (enabled) await member.roles.add(role, 'Member selected an optional role');
        else await member.roles.remove(role, 'Member removed an optional role');
        return await respond(`${enabled ? 'Added' : 'Removed'} **${choice.name}**.`);
      }
      const staff = this.isStaff(member, state, guild.ownerId);
      if (interaction.commandName === 'invites') {
        const user = interaction.options.getUser('user') || interaction.user;
        const records = Object.values(this.store.data.inviteMembers).filter(r => r.inviterId === user.id);
        return await respond(`**Tracked invites for ${user.username}**\nUnique accounts: **${records.length}** • Tracked present: **${records.filter(r => r.active).length}** • Tracked left: **${records.filter(r => !r.active).length}**\nTracking starts while this bot is online. Rejoins do not add credit. Vanity links, missing data, and ambiguous joins receive no credit. Presence totals can lag after downtime.\nTracking: ${this.membersEnabled && this.invitesHealthy ? 'active' : 'unavailable — ask the owner to check /bot-status'}.`);
      }
      if (!staff) return await respond('Only Owner, Developer, or Moderator can use this command.');
      const options = interaction.options;
      switch (interaction.commandName) {
        case 'greet': {
          if (options.getSubcommand() === 'preview') return await interaction.editReply(welcomeMessage(this.root, member, state, { template: this.store.data.greet.template }));
          const channel = await this.target(interaction, state, 'welcome');
          this.store.data.greet = { enabled: options.getBoolean('enabled') !== false, channelId: channel.id, template: options.getString('text', true) };
          this.store.save();
          return await respond(`Greeting saved for <#${channel.id}>. ${this.membersEnabled ? '' : 'Enable Server Members Intent and restart the bot for join greetings.'}`);
        }
        case 'bot-status': {
          const active = Object.values(this.store.data.giveaways).filter(g => g.status === 'running').length;
          const pending = Object.values(this.store.data.giveaways).filter(g => g.deliveryPending).length;
          return await respond(`**BananaTrade status**\nDiscord verification: ${state?.roles.verified ? 'configured — website-only (bot never grants the role)' : 'run /setup'}\nMinecraft linking: not used; IGN is self-reported\nMember events: ${this.membersEnabled ? 'enabled' : 'disabled — enable Server Members Intent and restart'}\nInvite counters: ${this.invitesHealthy ? 'available' : 'unavailable'}\nGreetings: ${this.store.data.greet.enabled ? 'enabled' : 'disabled'}\nGiveaways: ${active} active • ${pending} pending delivery\nKeep the bot running. Invite attribution is best-effort.`);
        }
        case 'embed': case 'container': {
          const channel = await this.target(interaction, state, 'announcements');
          const hex = (options.getString('color') || 'F5D547').replace(/^#/, '');
          if (!/^[a-fA-F0-9]{6}$/.test(hex)) throw new Error('Use a six-digit hex color, such as F5D547.');
          const build = interaction.commandName === 'embed' ? brandedEmbed : brandedContainer;
          const payload = build(this.root, options.getString('title', true), options.getString('body', true).replaceAll('\\n', '\n'), { color: parseInt(hex, 16), banner: options.getBoolean('banner') === true });
          const message = await channel.send(payload);
          return await respond(`Published: ${message.url}`);
        }
        case 'poll': {
          const channel = await this.target(interaction, state, 'polls');
          const body = { poll: { question: { text: options.getString('question', true) }, answers: pollAnswers(options.getString('answers', true)), duration: options.getInteger('hours') || 24, allow_multiselect: options.getBoolean('multiple') === true, layout_type: 1 }, allowed_mentions: { parse: [] } };
          const message = await this.client.rest.post(Routes.channelMessages(channel.id), { body });
          return await respond(`Poll published: https://discord.com/channels/${this.guildId}/${channel.id}/${message.id}`);
        }
        case 'giveaway': {
          const action = options.getSubcommand();
          if (action !== 'start') {
            const item = await this.draw(options.getString('message-id', true), action === 'reroll');
            return await respond(`Giveaway ${action === 'reroll' ? 'rerolled' : 'ended'}. ${item.winners.length} winner(s).`);
          }
          if (!state?.roles.verified) throw new Error('Run /setup before starting a giveaway.');
          if (Object.values(this.store.data.giveaways).filter(g => g.status === 'running').length >= 20) throw new Error('There are already 20 active giveaways. End one first.');
          const channel = await this.target(interaction, state, 'giveaways');
          const item = { guildId: this.guildId, channelId: channel.id, hostId: member.id, prize: options.getString('prize', true), count: options.getInteger('winners') || 1, endsAt: Date.now() + options.getInteger('minutes', true) * 60000, entrants: [], winners: [], previousWinners: [], status: 'running', deliveryPending: false };
          const message = await channel.send(this.giveawayPayload(item));
          this.store.data.giveaways[message.id] = item; this.store.save();
          return await respond(`Giveaway started: ${message.url}\nEntries and the ending time are saved across restarts.`);
        }
      }
    } catch (error) {
      if (error.status || error.code) return await respond(`Discord could not complete the action (code ${error.code || error.status}). Check bot permissions and channel/role availability. No account linking is performed.`);
      const message = String(error.message || '');
      const safe = /^(Your |Wait |Complete |Bots |The owner |This verification|Verification is |Website verification |Verified Member |The bot needs|Choose a text|Use |That giveaway|Finish and publish|This giveaway|Run \/setup|There are already|Setup state)/.test(message);
      return await respond(safe ? message : 'The action could not finish. Check /bot-status and the bot console; no secrets are included here.');
    }
  }
}
module.exports = { Community, verificationProblem, pollAnswers, inviteAttribution, pickWinners };
