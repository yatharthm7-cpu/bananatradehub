// One-shot authorized end-to-end check of the audit embed delivery chain using
// the local .env: configuredDiscord → channelBelongsToGuild → outbox queue →
// flush → verificationLogMessenger → the live staff-only audit channel.
// Posts exactly ONE clearly labelled test embed; prints only non-secret facts.
// Usage: node scripts/audit-delivery-check.js
require('dotenv').config({ quiet: true });
const { openDatabase } = require('../website/db');
const outbox = require('../website/outbox');
const { configuredDiscord, channelBelongsToGuild, verificationLogMessenger } = require('../website/discord');
const verification = require('../website/verification');

(async () => {
  const discord = configuredDiscord();
  if (!discord) { console.log(JSON.stringify({ ok: false, error: 'Discord env incomplete: see DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, GUILD_ID' })); return process.exit(1); }
  const channelId = process.env.DISCORD_VERIFICATION_LOG_CHANNEL_ID;
  // 1. The gate that previously rejected staff-only channels.
  const channel = await channelBelongsToGuild(discord, channelId);
  if (!channel) { console.log(JSON.stringify({ ok: false, error: 'guild gate rejected the audit channel', channelId })); return process.exit(1); }
  // 2. Queue + flush through the real durable path with a labelled test embed.
  const db = openDatabase(':memory:');
  // The outbox references an account row; this local scratch user exists only
  // for this one-shot check and is never committed to any deployed database.
  db.prepare("INSERT INTO users(id,email,ign,password) VALUES(0,'audit-delivery-check','','')").run();
  const testDiscordId = '000000000000000000';
  const embed = {
    title: 'Audit delivery test · website verification channel',
    color: 0xba77f5,
    description: 'One-time staff check that the sign-in audit delivery chain reaches this channel. No member data is included.',
    fields: [
      { name: 'Channel', value: `#${channel.name} · ${channel.id}`, inline: true },
      { name: 'Guild', value: channel.guild_id, inline: true },
      { name: 'Purpose', value: 'Sign-in audit embeds from the BananaSMP Trading Hub website', inline: false },
    ],
    footer: { text: 'BananaSMP • Trading Hub · audit delivery check' },
    timestamp: new Date().toISOString(),
  };
  await outbox.queue(db, [{ eventKey: 'audit-delivery-check:' + Date.now(), userId: 0, discordId: testDiscordId,
    content: 'Audit delivery test', link: '/', channelId, embedJson: JSON.stringify(embed) }]);
  const post = verificationLogMessenger(discord);
  // The outbox hands a whole job to send(); the server's deliver() adapts it.
  // Mirror that unpacking here so the production path is exercised exactly.
  const deliver = async job => post(job.channel_id, JSON.parse(job.embed_json));
  const summary = await outbox.flush(db, deliver);
  const job = await db.prepare('SELECT state,last_error FROM delivery_outbox WHERE discord_id=?').get(testDiscordId);
  console.log(JSON.stringify({ ok: summary.sent === 1, channel: { id: channel.id, name: channel.name, guildId: channel.guild_id },
    summary, job: job ? { state: job.state, last_error: job.last_error } : null }, null, 2));
  db.close();
})();
