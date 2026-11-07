const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const sharp = require('sharp');
const { createMinecraftSkins } = require('../website/minecraft-skins');
const { createServer } = require('../website/server');
const { openDatabase } = require('../website/db');

const uuid = '069a79f444e94726a5befca90e38aaf5';
const profile = () => new Response(JSON.stringify({ id: uuid, name: 'Notch' }));
async function fixture() {
  return sharp({ create: { width: 64, height: 64, channels: 4, background: '#ab65c9' } }).png().toBuffer();
}

test('skins use a resolved Java UUID, deduplicate lookups and cache normalized images', async () => {
  const png = await fixture();
  const calls = [];
  const skins = createMinecraftSkins({ request: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    return url.includes('minecraftservices.com') ? profile() : new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } });
  const [a, b] = await Promise.all([skins.image('Notch', 'body'), skins.image('notch', 'body')]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
  assert.match(calls[1], new RegExp('/renders/body/' + uuid + '\\?overlay&scale=4$'));
  assert.equal((await sharp(a).metadata()).format, 'png');
  await skins.image('NOTCH', 'avatar');
  assert.equal(calls.length, 3);
  assert.match(calls[2], /\/avatars\//);
});

test('invalid names, absent profiles and upstream failures never produce a claimed premium skin', async () => {
  let calls = 0;
  const skins = createMinecraftSkins({ request: async () => { calls++; return new Response(null, { status: 404 }); } });
  await assert.rejects(skins.image('../secret', 'body'), { status: 400 });
  assert.equal(calls, 0);
  await assert.rejects(skins.image('notch', 'body'), { status: 404 });
  await assert.rejects(skins.image('notch', 'body'), { status: 404 });
  assert.equal(calls, 1);
  const mismatch = createMinecraftSkins({ request: async () => new Response(JSON.stringify({ id: uuid, name: 'DifferentName' })) });
  await assert.rejects(mismatch.image('notch', 'body'), { status: 503 });
  const offline = createMinecraftSkins({ request: async () => { throw new Error('network unavailable'); } });
  await assert.rejects(offline.image('notch', 'body'), { status: 503 });
});

test('skin proxy rejects non-images and retries a failed provider after its short cache expires', async () => {
  let now = 0;
  let broken = true;
  const png = await fixture();
  const skins = createMinecraftSkins({ now: () => now, request: async url => url.includes('minecraftservices.com') ? profile() :
    new Response(broken ? '<html>error</html>' : png, { headers: { 'Content-Type': broken ? 'text/html' : 'image/png' } }) });
  await assert.rejects(skins.image('notch', 'avatar'), { status: 503 });
  broken = false;
  now = 61000;
  assert.equal((await sharp(await skins.image('notch', 'avatar')).metadata()).format, 'png');
});

test('public same-origin skin routes return PNG with bounded caching without creating a sign-in path', async t => {
  const png = await fixture();
  const db = openDatabase(':memory:');
  const seen = [];
  const server = createServer({ db, minecraftSkins: { image: async (...args) => { seen.push(args); return png; } } });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(origin + '/api/minecraft/Notch/body');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=1200');
  assert.deepEqual(seen, [['Notch', 'body']]);
  assert.equal((await fetch(origin + '/api/minecraft/Notch/other')).status, 404);
  const session = await (await fetch(origin + '/api/session')).json();
  assert.equal(session.user, null);
  assert.equal(await db.prepare('SELECT count(*) AS total FROM sessions').get().then(row => row.total), 0);
});
