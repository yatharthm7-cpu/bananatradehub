const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { preferenceRoles } = require('./blueprint');
const channel = o => o.setName('channel').setDescription('Destination channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
const commands = [
  new SlashCommandBuilder().setName('roles').setDescription('Choose your platform labels and notification roles')
    .addStringOption(o => o.setName('role').setDescription('Role to update').setRequired(true)
      .addChoices(...preferenceRoles.map(({ name, key }) => ({ name, value: key }))))
    .addBooleanOption(o => o.setName('enabled').setDescription('True to add the role, false to remove it').setRequired(true)),
  new SlashCommandBuilder().setName('greet').setDescription('Staff: configure or preview member greetings')
    .addSubcommand(s => s.setName('set').setDescription('Set greeting channel and text').addChannelOption(o => channel(o).setRequired(true)).addStringOption(o => o.setName('text').setDescription('Use {user}, {username}, {server}, {count}').setRequired(true).setMaxLength(1800)).addBooleanOption(o => o.setName('enabled').setDescription('Enable greetings (default true)')))
    .addSubcommand(s => s.setName('preview').setDescription('Preview the saved greeting privately')),
  new SlashCommandBuilder().setName('invites').setDescription('Show tracked invitations (tracking begins when the bot is online)').addUserOption(o => o.setName('user').setDescription('Member to view')),
  new SlashCommandBuilder().setName('giveaway').setDescription('Staff giveaway management')
    .addSubcommand(s => s.setName('start').setDescription('Create a verified-member giveaway').addStringOption(o => o.setName('prize').setDescription('Prize and any conditions').setRequired(true).setMaxLength(500)).addIntegerOption(o => o.setName('minutes').setDescription('Duration: 1 minute to 30 days').setRequired(true).setMinValue(1).setMaxValue(43200)).addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20)).addChannelOption(channel))
    .addSubcommand(s => s.setName('end').setDescription('End a giveaway now').addStringOption(o => o.setName('message-id').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand(s => s.setName('reroll').setDescription('Draw new winners, excluding previous winners').addStringOption(o => o.setName('message-id').setDescription('Giveaway message ID').setRequired(true))),
  new SlashCommandBuilder().setName('poll').setDescription('Staff: create a native Discord poll').addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true).setMaxLength(300)).addStringOption(o => o.setName('answers').setDescription('2–10 choices separated by |').setRequired(true).setMaxLength(1500)).addIntegerOption(o => o.setName('hours').setDescription('Duration: 1–768 hours').setMinValue(1).setMaxValue(768)).addBooleanOption(o => o.setName('multiple').setDescription('Allow multiple choices')).addChannelOption(channel),
  ...['embed', 'container'].map(name => new SlashCommandBuilder().setName(name).setDescription(`Staff: publish a custom ${name === 'container' ? 'Components V2 container' : 'branded embed'}`).addStringOption(o => o.setName('title').setDescription('Heading').setRequired(true).setMaxLength(200)).addStringOption(o => o.setName('body').setDescription('Message text; use \\n for a new line').setRequired(true).setMaxLength(3500)).addChannelOption(channel).addStringOption(o => o.setName('color').setDescription('Optional hex color, for example F5D547').setMaxLength(7)).addBooleanOption(o => o.setName('banner').setDescription('Include the banner from assets'))),
  new SlashCommandBuilder().setName('bot-status').setDescription('Staff: verification, invite tracking, greetings, and giveaway status'),
];
module.exports = { commands };
