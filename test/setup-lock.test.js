// The guild setup lock: two concurrent setups (the sign of a duplicate bot
// process on the same host) must not both mutate the same guild, and a
// completed run must release the lock so reruns stay possible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { main } = require('../src/setup');

const guild = '600000000000000001';
const bot = '600000000000000002';
const botRole = '600000000000000000';

function fakeApi({ gate }) {
  const roles = [{ id: guild, name: '@everyone', position: 0, permissions: '0' }, { id: botRole, name: 'Bot', position: 20, permissions: P.Administrator.toString(), managed: true }];
  const channels = [];
  let sequence = 610000000000000000n;
  return {
    async get(route) {
      if (route === '/users/@me') return { id: bot, username: 'Bot', bot: true };
      if (route === '/oauth2/applications/@me') return { id: 'app' };
      if (route === '/applications/app/emojis') return { items: [] };
      if (route === `/guilds/${guild}`) return { id: guild, name: 'Lock guild', owner_id: 'owner', features: [] };
      if (route.endsWith('/roles')) return structuredClone(roles);
      if (route.endsWith('/channels')) return structuredClone(channels);
      if (route.includes('/members/')) return { roles: [botRole] };
      throw new Error(`Unexpected GET ${route}`);
    },
    async post(route, { body }) {
      const item = { ...structuredClone(body), id: String(sequence++) };
      if (route.endsWith('/roles')) roles.push(item);
      else if (route.endsWith('/channels')) channels.push(item);
      return item;
    },
    async patch(route, { body }) {
      // The guild branding patch runs deep inside the mutation phase, which is
      // past the lock; stalling it here keeps the first run holding the lock.
      if (gate && route === `/guilds/${guild}`) await gate;
      if (route === `/guilds/${guild}`) return body;
      if (route === `/guilds/${guild}/roles`) return roles;
      return body;
    },
    async put() {},
    async delete() {},
  };
}

test('overlapping setups on the same guild are refused and the lock releases', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.test-lock-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (const name of ['BananaSMP_Icon.png', 'BananaSMP_Banner.png']) {
    fs.copyFileSync(path.join(__dirname, '..', 'assets', name), path.join(root, 'assets', name));
  }
  let gateRelease;
  const gate = new Promise(resolve => { gateRelease = resolve; });
  const settings = { token: 'fixture-token-not-a-credential', guild, developer: null };
  const first = main({ root, settings, runMode: 'apply', api: fakeApi({ gate }) }).catch(error => { gateRelease(); throw error; });
  // Let the first run reach and hold the lock (its validation phase is fast)
  // before the second process starts; otherwise both race past an empty lock.
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(() => main({ root, settings, runMode: 'apply', api: fakeApi({}) }),
    /Setup is already running for this server/);
  gateRelease();
  await first;
  const lockFile = path.join(root, 'data', `setup-lock-${guild}.json`);
  assert.ok(!fs.existsSync(lockFile), 'a completed run releases the lock so reruns work');
  fs.rmSync(root, { recursive: true, force: true });
});
