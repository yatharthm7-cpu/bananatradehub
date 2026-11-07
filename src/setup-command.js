const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { main } = require('./setup');
const command = new SlashCommandBuilder().setName('setup').setDescription('Owner only: set up channels, voice rooms, roles, and permissions')
  .addBooleanOption(o => o.setName('rebuild').setDescription('Delete bot-created channels and their messages, then recreate them'));
function setupError(error) {
  if (error.status) return `Discord setup failed (HTTP ${error.status}, code ${error.code || 'unknown'}). Check the bot’s permissions and move its role above the roles it manages. Some changes may already exist; rerun /setup after fixing access.`;
  const message = String(error.message || '');
  if (/^(Bot lacks required|Move the (?:managed bot role|BananaTrade bot role)|Cannot manage role:|Existing untracked|Saved state belongs|Invalid DEVELOPER_USER_ID|Provide a 16:9 banner|Role hierarchy verification failed|Channel verification failed|Access verification failed|Permission readback failed|Verification failed for)/.test(message)) return message;
  return 'Setup could not finish. Check bot access, local assets, and connectivity. Changes already created are saved; fix the issue and rerun /setup.';
}
function createSetupHandler({ guildId, token, developerUserId, runner = main }) {
  let running = false;
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== command.name) return;
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.inGuild() || interaction.guildId !== guildId) return reply('Use /setup in the configured BananaSMP server.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      const guild = await interaction.client.guilds.fetch(guildId);
      if (interaction.user.id !== guild.ownerId) return await respond('Only the actual server owner can run /setup.');
      if (running) return await respond('Setup is already running. Wait for it to finish.');
      running = true;
      try {
        const rebuild = interaction.options?.getBoolean('rebuild') === true;
        const result = await runner({ settings: { token, guild: guildId, developer: developerUserId }, runMode: 'apply', rebuild, onProgress: async text => {
          // A deleted response must not interrupt a partially completed setup.
          await respond(text).catch(() => {});
        } });
        return await respond(`Setup complete: ${result.roles} roles, ${result.categories} categories, ${result.channels - result.voiceChannels} text channels, and ${result.voiceChannels} voice rooms. Existing unrelated content was preserved. Discord rules verification is configured. Minecraft IGN ownership is not checked.`);
      } finally { running = false; }
    } catch (error) { return await respond(setupError(error)); }
  };
}
module.exports = { command, createSetupHandler };
