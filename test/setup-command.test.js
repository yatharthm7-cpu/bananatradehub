const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupHandler } = require('../src/setup-command');
function interaction(user = 'owner', guildId = 'guild') {
  const calls = [];
  return { calls, commandName: 'setup', guildId, user: { id: user }, isChatInputCommand: () => true, inGuild: () => !!guildId,
    client: { guilds: { fetch: async () => ({ ownerId: 'owner' }) } },
    reply: async data => calls.push(data), deferReply: async data => calls.push(data), editReply: async data => calls.push(data),
  };
}
test('setup requires the real guild owner and the configured server', async () => {
  let runs = 0;
  const handler = createSetupHandler({ guildId: 'guild', runner: async () => runs++ });
  for (const i of [interaction('member'), interaction('owner', 'other'), interaction('owner', null)]) await handler(i);
  assert.equal(runs, 0);
});
test('setup acknowledges privately, supplies target, streams progress, and reports readback result', async () => {
  const i = interaction();
  const handler = createSetupHandler({ guildId: 'guild', token: 'secret', runner: async options => {
    assert.equal(options.settings.guild, 'guild');
    assert.equal(options.runMode, 'apply');
    await options.onProgress('Working…');
    return { roles: 5, categories: 5, channels: 18, voiceChannels: 4 };
  } });
  await handler(i);
  assert.equal(i.calls[0].flags, 64);
  assert.match(i.calls.at(-1).content, /14 text channels, and 4 voice rooms/);
});
test('setup returns actionable permission failures and releases lock after failure', async () => {
  let runs = 0;
  const handler = createSetupHandler({ guildId: 'guild', runner: async () => { runs++; throw new Error('Bot lacks required setup permissions: ManageRoles.'); } });
  const i = interaction(); await handler(i); await handler(interaction());
  assert.equal(runs, 2);
  assert.match(i.calls.at(-1).content, /ManageRoles/);
});
test('overlapping setup requests do not create duplicate channels', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const handler = createSetupHandler({ guildId: 'guild', runner: async () => { started(); await new Promise(resolve => { release = resolve; }); return { roles: 5, categories: 5, channels: 18, voiceChannels: 4 }; } });
  const first = handler(interaction()); await ready;
  const second = interaction(); await handler(second);
  assert.match(second.calls.at(-1).content, /already running/);
  release(); await first;
});
