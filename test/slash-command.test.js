const test = require('node:test');
const assert = require('node:assert/strict');
const { command, createHandler } = require('../src/slash-command');
const { register } = require('../src/register-commands');
function interaction(user = 'owner', guildId = 'guild', roles = []) {
  const calls = [];
  return { calls, user: { id: user }, guildId, commandName: 'emoji-import',
    isChatInputCommand: () => true, inGuild: () => Boolean(guildId),
    client: { guilds: { fetch: async () => ({ ownerId: 'owner', members: { fetch: async () => ({ roles: { cache: new Set(roles) } }) } }) } },
    options: { getString: key => ({ source: '<a:dance:100000000000000001>', name: 'dance' })[key] || null },
    reply: async x => calls.push(['reply', x]), deferReply: async x => calls.push(['defer', x]), editReply: async x => calls.push(['edit', x]),
  };
}
test('slash handler denies ordinary members and other servers before upload', async () => {
  let uploads = 0;
  const handler = createHandler({ guildId: 'guild', importer: async () => uploads++ });
  for (const i of [interaction('member'), interaction('owner', 'other'), interaction('owner', null)]) {
    await handler(i);
    assert.match(i.calls.at(-1)[1].content, /Only the server owner|configured BananaSMP/);
  }
  assert.equal(uploads, 0);
});
test('owner and tracked Developer can import; responses are private and server is the default', async () => {
  for (const i of [interaction(), interaction('dev', 'guild', ['developer-role'])]) {
    const handler = createHandler({ guildId: 'guild', developerRoleId: 'developer-role', importer: async opts => {
      assert.equal(opts.server, true); assert.equal(opts.guildId, 'guild');
      return { destination: 'server', mention: '<a:dance:100000000000000001>' };
    } });
    await handler(i);
    assert.equal(i.calls[0][0], 'defer');
    assert.equal(i.calls[0][1].flags, 64);
    assert.match(i.calls.at(-1)[1].content, /Imported to server/);
  }
});
test('unexpected import failures do not expose credentials', async () => {
  const handler = createHandler({ guildId: 'guild', importer: async () => { throw new Error('secret-token'); } });
  const i = interaction(); await handler(i);
  assert(!JSON.stringify(i.calls).includes('secret-token'));
});
test('registration upserts only this guild command and reads it back', async () => {
  const calls = [];
  await register({ token: 'test', guildId: '100000000000000001', api: {
    get: async route => route === '/oauth2/applications/@me' ? { id: 'app' } : { name: route.split('/').at(-1) },
    post: async (route, { body }) => { calls.push({ route, body }); return { id: body.name }; },
  } });
  assert.equal(calls.length, 10); // /verify is retired: website-only verification
  assert.equal(calls[1].body.name, 'setup');
  assert.match(calls[0].route, /\/guilds\/100000000000000001\/commands$/);
  assert.equal(calls[0].body.options[0].name, 'source');
});


