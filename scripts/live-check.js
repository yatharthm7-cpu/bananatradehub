// Briefly connects the bot, checks existing panels, and creates/deletes test
// messages ONLY inside the setup-owned private setup-log channel.
const path = require('node:path');
const { Events, Routes } = require('discord.js');
const { start } = require('../src/bot');
const { brandedEmbed, brandedContainer } = require('../src/presentation');
async function main() {
  const client = await start({ registerCommands: false });
  const created = [];
  try {
    if (!client.isReady()) await new Promise(resolve => client.once(Events.ClientReady, resolve));
    if (!await client.communityReady) throw new Error('Community initialization failed.');
    const state = client.community.state();
    const channel = await client.channels.fetch(state.channels.logs);
    if (!channel || channel.guildId !== process.env.GUILD_ID) throw new Error('Private setup log unavailable.');
    const verification = await client.rest.get(Routes.channelMessage(state.channels.verify, state.messages.verify));
    if (verification.components?.[0]?.components?.[0]?.custom_id !== 'verify:rules:v1') throw new Error('Live verification button missing.');
    if (!verification.embeds[0]?.author?.icon_url || verification.embeds[0]?.thumbnail || !verification.embeds[0]?.image?.width || !verification.embeds[0]?.fields?.[0]?.inline) throw new Error('Live branded verification layout missing.');
    const welcome = await client.rest.get(Routes.channelMessage(state.channels.welcome, state.messages.welcome));
    if (welcome.components?.[0]?.components?.[0]?.url !== `https://discord.com/channels/${process.env.GUILD_ID}/${state.channels.verify}`) throw new Error('Welcome verification link missing.');
    const root = path.join(__dirname, '..');
    const embed = await channel.send(brandedEmbed(root, 'Feature validation', 'Temporary branded embed check.', { banner: true }));
    created.push(embed.id);
    if (!embed.embeds[0]?.author?.iconURL || !embed.embeds[0]?.image?.url) throw new Error('Embed images missing.');
    const container = await channel.send(brandedContainer(root, 'Feature validation', 'Temporary Components V2 check.', { banner: true }));
    created.push(container.id);
    const saved = await client.rest.get(Routes.channelMessage(channel.id, container.id));
    if (!(saved.flags & 32768) || saved.components[0]?.type !== 17) throw new Error('Components V2 readback failed.');
    const poll = await client.rest.post(Routes.channelMessages(channel.id), { body: { poll: { question: { text: 'Temporary feature validation' }, answers: [{ poll_media: { text: 'One' } }, { poll_media: { text: 'Two' } }], duration: 1, layout_type: 1 }, allowed_mentions: { parse: [] } } });
    created.push(poll.id);
    if (poll.poll?.answers?.length !== 2) throw new Error('Native poll readback failed.');
    console.log(JSON.stringify({ gateway: 'ready', verificationButton: 'present', logoAndBanner: 'verified', embeds: 'accepted', componentsV2: 'accepted', nativePoll: 'accepted', serverMembersIntent: client.community.membersEnabled, inviteCountersAvailable: client.community.invitesHealthy }, null, 2));
  } finally {
    const state = client.community.state();
    for (const id of created) {
      try { await client.rest.delete(Routes.channelMessage(state.channels.logs, id)); }
      catch { console.error(`Temporary test message could not be removed: ${id}`); process.exitCode = 1; }
    }
    client.destroy();
  }
}
main().catch(error => { console.error(error.status ? `Live check failed: Discord HTTP ${error.status}, code ${error.code || 'unknown'}.` : `Live check failed: ${String(error.message).replaceAll(process.env.DISCORD_TOKEN || '\0', '[REDACTED]').slice(0, 300)}`); process.exitCode = 1; });
