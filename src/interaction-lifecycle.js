// Shared interaction response lifecycle for slash commands. One clear path:
// acknowledge once (defer) → run the work → finish by editing the deferred
// response → if the response channel is dead (expired token, unknown
// interaction, or another process already acknowledged), record the outcome
// in the runtime log instead of misreporting the work as failed.
//
// All logging is sanitized: command name, stage, Discord error status/code,
// and a correlation ID. Bot tokens, interaction tokens, and authorization
// headers are never logged.

const { MessageFlags, RESTJSONErrorCodes } = require('discord.js');

// Discord error codes that mean "you can no longer respond to this
// interaction" (as opposed to "the work itself failed").
const DEAD_RESPONSE_CODES = new Set([
  RESTJSONErrorCodes.UnknownInteraction,                        // 10062
  RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,     // 40060
  50027, // Invalid interaction token (the 15-minute window expired).
]);

// 401: invalid interaction token. 404: unknown interaction. 403 is NOT dead —
// it is a permission failure the operator should see, not a transport failure.
const DEAD_RESPONSE_STATUS = new Set([401, 404]);

function responseDead(error) {
  if (!error) return false;
  if (DEAD_RESPONSE_CODES.has(Number(error.code))) return true;
  if (DEAD_RESPONSE_STATUS.has(Number(error.status))) return true;
  const text = String(error.message || '');
  return /interaction has already been acknowledged|unknown interaction|invalid token/i.test(text) || /after \d+ minutes/i.test(text);
}

function correlationId() {
  return Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 8);
}

function logCommand({ command, stage, status = 'ok', error = null, correlationId }) {
  const line = {
    msg: 'slash-command', command, stage, status, correlationId,
    ...(error ? { discordStatus: error.status ?? null, discordCode: error.code ?? null } : {}),
  };
  // Never attach error bodies: REST failures may embed request credentials.
  console.log(JSON.stringify(line));
}

// Defer (acknowledge) exactly once. Idempotent across retries inside one
// handler run. Throws only when the interaction can never be answered.
async function acknowledge(interaction, { command, correlationId }) {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (responseDead(error)) {
      // The signature of a duplicate bot process: the same interaction
      // reached two shards and the other one answered it first.
      logCommand({ command, stage: 'acknowledge', status: Number(error.code) === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged ? 'duplicate-process' : 'response-unavailable', error, correlationId });
      throw Object.assign(new Error('The interaction can no longer be answered.'), { responseDead: true, reported: true });
    }
    throw error;
  }
}

// Deliver the final message on the original response. Falls back to followUp,
// then to a sanitized runtime log. Never throws: the command's own outcome is
// recorded separately from whether the reply could be delivered.
async function finish(interaction, content, { command, stage, correlationId, succeeded }) {
  const attempts = [
    ['editReply', interaction.deferred || interaction.replied ? () => interaction.editReply({ content, allowedMentions: { parse: [] } }) : null],
    ['reply', !interaction.replied ? () => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }) : null],
    ['followUp', interaction.deferred || interaction.replied ? () => interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }) : null],
  ];
  for (const [name, attempt] of attempts) {
    if (!attempt) continue;
    try {
      await attempt();
      return name === 'editReply' ? null : name;
    } catch (error) {
      if (!responseDead(error)) continue;
      // The response channel is gone; record both facts, separately.
      logCommand({ command, stage, status: succeeded ? 'work-ok-reply-failed' : 'work-failed-reply-failed', error, correlationId });
      return name;
    }
  }
  logCommand({ command, stage, status: 'reply-transport-failed', correlationId });
  return 'log-only';
}

module.exports = { acknowledge, finish, responseDead, correlationId, logCommand };
