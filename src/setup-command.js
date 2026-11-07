const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { main } = require('./setup');
const { acknowledge, finish, correlationId: newCorrelationId, logCommand } = require('./interaction-lifecycle');
const command = new SlashCommandBuilder().setName('setup').setDescription('Owner only: set up channels, voice rooms, roles, and permissions')
  .addBooleanOption(o => o.setName('rebuild').setDescription('Delete bot-created channels and their messages, then recreate them'));
function setupError(error) {
  if (error.status) return `Discord setup failed (HTTP ${error.status}, code ${error.code || 'unknown'}). Check the bot’s permissions and move its role above the roles it manages. Some changes may already exist; rerun /setup after fixing access.`;
  const message = String(error.message || '');
  if (/^(Bot lacks required|Move the (?:managed bot role|BananaTrade bot role)|Cannot manage role:|Existing untracked|Saved state belongs|Invalid DEVELOPER_USER_ID|Provide a 16:9 banner|Role hierarchy verification failed|Channel verification failed|Access verification failed|Permission readback failed|Verification failed for|Setup is already running)/.test(message)) return message;
  return 'Setup could not finish. Check bot access, local assets, and connectivity. Changes already created are saved; fix the issue and rerun /setup.';
}
function createSetupHandler({ guildId, token, developerUserId, runner = main }) {
  let running = false;
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== command.name) return;
    const correlationId = newCorrelationId();
    if (!interaction.inGuild() || interaction.guildId !== guildId) {
      return interaction.reply({ content: 'Use /setup in the configured BananaSMP server.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    // Acknowledge exactly once before any lengthy REST work: setup creates 14
    // roles and 21 channels. A dead response here (duplicate process answered
    // first, expired interaction) is reported, never retried.
    try {
      await acknowledge(interaction, { command: command.name, correlationId });
    } catch (error) {
      if (error?.reported) return;
      logCommand({ command: command.name, stage: 'acknowledge', status: 'acknowledge-failed', error, correlationId });
      throw error;
    }
    let setupSucceeded = false;
    try {
      const guild = await interaction.client.guilds.fetch(guildId);
      if (interaction.user.id !== guild.ownerId) {
        return await finish(interaction, 'Only the actual server owner can run /setup.', { command: command.name, stage: 'authorize', correlationId, succeeded: false });
      }
      if (running) {
        return await finish(interaction, 'Setup is already running. Wait for it to finish.', { command: command.name, stage: 'overlap', correlationId, succeeded: false });
      }
      running = true;
      const rebuild = interaction.options?.getBoolean('rebuild') === true;
      const result = await runner({
        settings: { token, guild: guildId, developer: developerUserId }, runMode: 'apply', rebuild,
        onProgress: async text => {
          // A deleted or expired response must not interrupt a partially
          // completed setup: progress is best-effort, the work is not.
          await finish(interaction, text, { command: command.name, stage: 'progress', correlationId, succeeded: true });
        },
      });
      setupSucceeded = true;
      await finish(interaction,
        `Setup complete: ${result.roles} roles, ${result.categories} categories, ${result.channels - result.voiceChannels} text channels, and ${result.voiceChannels} voice rooms. Existing unrelated content was preserved. Discord rules verification is configured. Minecraft IGN ownership is not checked.`,
        { command: command.name, stage: 'complete', correlationId, succeeded: true });
      logCommand({ command: command.name, stage: 'complete', status: 'replied', correlationId });
    } catch (error) {
      // The setup itself failed: report the real cause on any remaining
      // response path. A dead response never hides the original error — it is
      // logged with sanitized Discord codes and the correlation ID.
      logCommand({ command: command.name, stage: 'setup', status: 'setup-failed', error, correlationId });
      await finish(interaction, setupError(error), { command: command.name, stage: 'setup-error', correlationId, succeeded: false });
    } finally {
      running = false;
      // A successful setup whose reply could not be delivered stays successful:
      // no rollback, no channel recreation, recorded separately from the reply.
      if (setupSucceeded) logCommand({ command: command.name, stage: 'outcome', status: 'setup-ok', correlationId });
    }
  };
}
module.exports = { command, createSetupHandler };
