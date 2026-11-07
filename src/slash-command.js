const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { importEmoji } = require('./import-emoji');
const command = new SlashCommandBuilder()
  .setName('emoji-import')
  .setDescription('Import a static or animated custom emoji')
  .addStringOption(o => o.setName('source').setDescription('Custom emoji mention or Discord CDN emoji link').setRequired(true).setMaxLength(500))
  .addStringOption(o => o.setName('name').setDescription('Optional new name: 2–32 letters, numbers, underscores').setMinLength(2).setMaxLength(32))
  .addStringOption(o => o.setName('destination').setDescription('Default: this server').addChoices(
    { name: 'This server (members can use it)', value: 'server' },
    { name: 'Bot application (bot use only)', value: 'application' },
  ));
function safeError(error) {
  if (error.status) return `Discord rejected the import (HTTP ${error.status}). For server imports, check the bot’s Create Expressions permission and available emoji slots. If an upload may have succeeded, inspect the destination before retrying.`;
  // Only expose known user-facing validation errors; never REST/network objects.
  const message = String(error.message || '');
  if (/^(Provide a custom emoji|Only https:|Emoji name must|That destination emoji|Emoji exceeds|Emoji image unavailable|The downloaded file|Emoji was uploaded)/.test(message)) return message;
  return 'Import could not be completed. Check bot access and connectivity. Inspect the destination before retrying.';
}
function createHandler({ guildId, developerUserId, developerRoleId, importer = importEmoji, token }) {
  let busy = false;
  return async function handle(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== command.name) return;
    const privateReply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.inGuild() || interaction.guildId !== guildId) return privateReply('This command is available only in the configured BananaSMP server.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      // Fetch current membership rather than trusting a cached role name.
      const guild = await interaction.client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      const roleId = typeof developerRoleId === 'function' ? developerRoleId() : developerRoleId;
      const authorized = interaction.user.id === guild.ownerId || interaction.user.id === developerUserId || (roleId && member.roles.cache.has(roleId));
      if (!authorized) return await respond('Only the server owner or configured Developer can import emoji.');
      if (busy) return await respond('Another emoji import is running. Try again when it finishes.');
      busy = true;
      try {
        const result = await importer({
          source: interaction.options.getString('source', true),
          name: interaction.options.getString('name') || undefined,
          server: interaction.options.getString('destination') !== 'application',
          guildId, token,
        });
        return await respond(`Imported to ${result.destination}: ${result.mention}`);
      } finally { busy = false; }
    } catch (error) { return await respond(safeError(error)); }
  };
}
module.exports = { command, createHandler };
