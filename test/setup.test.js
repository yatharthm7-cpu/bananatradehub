const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { main } = require('../src/setup');
test('apply then rerun preserves unrelated content and does not duplicate roles, channels, or panels', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.test-setup-'));
  const guild = '100000000000000001', bot = '100000000000000002';
  const botRole = '100000000000000000';
  const roles = [{ id: guild, name: '@everyone', position: 0, permissions: '0' }, { id: botRole, name: 'Bot', position: 20, permissions: P.Administrator.toString(), managed: true }];
  const channels = [{ id: 'unrelated', name: 'existing-chat', type: 0, topic: 'Preserve me' }];
  const messages = new Map();
  let sequence = 100, posts = 0;
  const api = {
    async get(route) {
      if (route === '/users/@me') return { id: bot, username: 'TestBot', bot: true };
      if (route === '/oauth2/applications/@me') return { id: 'app' };
      if (route === '/applications/app/emojis') return { items: [{ id: '100000000000000010', name: 'wave2', animated: true }] };
      if (route === `/guilds/${guild}`) return { id: guild, name: 'Test guild', owner_id: 'owner', features: [] };
      if (route.endsWith('/roles')) return structuredClone(roles);
      if (route.endsWith('/channels')) return structuredClone(channels);
      if (route.includes('/members/')) return { roles: [botRole] };
      throw new Error(`Unexpected GET ${route}`);
    },
    async post(route, { body }) {
      posts++;
      const item = { ...structuredClone(body), id: String(200000000000000000n + BigInt(sequence++)), position: 1 };
      if (route.endsWith('/roles')) roles.push(item);
      else if (route.endsWith('/messages')) messages.set(`${route}/${item.id}`, item);
      else if (route.endsWith('/channels')) channels.push(item);
      else throw new Error(`Unexpected POST ${route}`);
      return structuredClone(item);
    },
    async patch(route, { body }) {
      if (route === `/guilds/${guild}`) return body;
      if (route === `/guilds/${guild}/roles`) {
        if (body.length === 1 && roles.every(r => r.id === guild || r.position === 1)) {
          const ordered = roles.filter(r => r.id !== guild).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
          ordered.forEach((r, i) => { r.position = ordered.length - i; });
        } else for (const r of body) Object.assign(roles.find(x => x.id === r.id), r);
        return roles;
      }
      const object = route.includes('/messages/') ? messages.get(route) : (route.includes('/roles/') ? roles : channels).find(x => route.endsWith(`/${x.id}`));
      assert(object, `Missing mock object ${route}`);
      Object.assign(object, structuredClone(body)); return object;
    },
    async put() {},
    async delete(route) {
      const id = route.split('/').at(-1);
      const index = channels.findIndex(c => c.id === id);
      assert(index >= 0);
      if (channels[index].type === 4) assert(!channels.some(c => c.parent_id === id));
      channels.splice(index, 1);
      for (const key of messages.keys()) if (key.startsWith(`/channels/${id}/`)) messages.delete(key);
    },
  };
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    for (const asset of ['BananaSMP_Icon.png', 'BananaSMP_Banner.png']) fs.copyFileSync(path.join(__dirname, '..', 'assets', asset), path.join(root, 'assets', asset));
    const options = { root, api, settings: { token: 'test', guild }, runMode: 'apply' };
    await main(options);
    const firstPosts = posts;
    assert.equal(roles.length, 16);
    assert.equal(roles.find(r => r.name === 'Trade Radar').permissions, '0');
    assert.equal(channels.length, 27); // 21 channels, 5 categories, 1 pre-existing
    assert.equal(channels.filter(c => c.type === 2).length, 4);
    assert.equal(messages.size, 8);
    assert([...messages.values()].some(m => m.embeds[0].description.startsWith('<a:wave2:100000000000000010>')));
    await main(options);
    assert.equal(posts, firstPosts);
    assert.equal(channels[0].topic, 'Preserve me');
     assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'last-result.json'))).verification, 'website-only-sign-in');
    // An untracked same-name role must stop before any mutation.
    const stateFile = path.join(root, 'data', `guild-${guild}.json`);
    const savedState = fs.readFileSync(stateFile);
    fs.unlinkSync(stateFile);
    await assert.rejects(main(options), /Existing untracked role/);
    assert.equal(posts, firstPosts);
    fs.writeFileSync(stateFile, savedState);
    // Regression: raw position ties must normalize, then sort, without falsely
    // asking the owner to move an already-highest bot role.
    for (const role of roles) if (role.id !== guild) role.position = 1;
    await main(options);
    const positionOf = name => roles.find(r => r.name === name).position;
    assert(positionOf('Bot') > positionOf('Owner'));
    assert(positionOf('Owner') > positionOf('Developer'));
    assert(positionOf('Developer') > positionOf('Moderator'));
    assert(positionOf('Moderator') > positionOf('Middleman'));
    assert(positionOf('Middleman') > positionOf('Verified Member'));
    assert.equal(posts, firstPosts);
    const oldIds = new Set(channels.filter(c => c.id !== 'unrelated').map(c => c.id));
    const savedRoleIds = roles.map(r => r.id);
    await main({ ...options, rebuild: true });
    assert.equal(channels.length, 27);
    assert(channels.every(c => !oldIds.has(c.id)));
    assert.equal(channels[0].topic, 'Preserve me');
    assert.deepEqual(roles.map(r => r.id), savedRoleIds);
    assert.equal(messages.size, 8);
  } finally {
    // Only the explicit temporary directory created by this test is removed.
    fs.rmSync(root, { recursive: true, force: true });
  }
});

