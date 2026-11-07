// Ops script: one-shot connectivity check for the website verification channel.
// Requires a local .env with DISCORD_TOKEN, GUILD_ID, and
// DISCORD_VERIFICATION_LOG_CHANNEL_ID. Sends exactly ONE clearly labelled test
// embed and prints only non-secret facts (channel name/id, guild id, message
// id). Never prints the bot token or any credential.
require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID, DISCORD_VERIFICATION_LOG_CHANNEL_ID } = process.env;
const CHANNEL = DISCORD_VERIFICATION_LOG_CHANNEL_ID;

async function main() {
  if (!DISCORD_TOKEN || !GUILD_ID || !CHANNEL) {
    fail('Missing DISCORD_TOKEN, GUILD_ID, or DISCORD_VERIFICATION_LOG_CHANNEL_ID in .env.');
  }
  if (!/^\d{17,20}$/.test(GUILD_ID) || !/^\d{17,20}$/.test(CHANNEL)) {
    fail('GUILD_ID and DISCORD_VERIFICATION_LOG_CHANNEL_ID must be 17–20 digit snowflakes.');
  }
  const api = new REST({ version: '10', timeout: 10000 }).setToken(DISCORD_TOKEN);
  // 1. Validate the channel: same guild, a text channel, and visible to the bot.
  let channel;
  try {
    channel = await api.get(Routes.channel(CHANNEL));
  } catch (error) {
    return fail(`The channel could not be read by the bot (HTTP ${error.status ?? 'unknown'}, code ${error.code ?? 'n/a'}). Check the channel ID, the bot token, and bot access.`);
  }
  const problems = [];
  if (channel.guild_id !== GUILD_ID) problems.push(`channel belongs to guild ${channel.guild_id}, not the configured GUILD_ID`);
  if (![0, 5].includes(channel.type)) problems.push(`channel type ${channel.type} is not a text or announcement channel`);
  if (problems.length) return fail(`Channel check failed: ${problems.join('; ')}.`);
  // 2. Send one labelled connectivity-test embed.
  const embed = {
    title: 'Connectivity test · website verification channel',
    color: 0xba77f5,
    description: `This is a one-time staff connectivity check for **#${channel.name}**. The website-only verification flow will post sign-in audit embeds here.`,
    fields: [
      { name: 'Channel', value: `#${channel.name} · ${channel.id}`, inline: true },
      { name: 'Guild', value: channel.guild_id, inline: true },
      { name: 'Purpose', value: 'Auditing sign-in events from the BananaTrade website', inline: false },
      { name: 'Note', value: 'If this message arrived, the bot can view the channel, send messages, and attach embeds. No member data is included in this test.', inline: false },
    ],
    footer: { text: 'BananaSMP • Trading Hub · connectivity check', icon_url: 'https://bananatradehub.vercel.app/logo.png' },
    timestamp: new Date().toISOString(),
  };
  let message;
  try {
    message = await api.post(Routes.channelMessages(CHANNEL), { body: { embeds: [embed], allowed_mentions: { parse: [] } } });
  } catch (error) {
    return fail(`The test embed could not be sent (HTTP ${error.status ?? 'unknown'}, code ${error.code ?? 'n/a'}). Check the bot's Send Messages and Embed Links permissions and channel overwrites.`);
  }
  console.log(JSON.stringify({
    ok: true,
    channel: { id: channel.id, name: channel.name, guildId: channel.guild_id, type: channel.type },
    messageId: message.id,
    sentAt: new Date().toISOString(),
  }, null, 2));
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
  throw new Error('channel-check-failed');
}

main().catch(error => {
  const safe = error.status || error.code ? `Discord API failure (HTTP ${error.status ?? 'unknown'}, code ${error.code ?? 'n/a'}).` : String(error.message || error).slice(0, 200);
  fail(safe);
});
