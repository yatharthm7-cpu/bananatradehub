const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSource, download, importEmoji } = require('../src/import-emoji');
const id = '100000000000000010';
const gif = () => new Response(Buffer.from('GIF89a-test-image'));
test('custom animated mentions preserve GIF and untrusted URLs are rejected', () => {
  assert.match(parseSource(`<a:dance:${id}>`).url, /\.gif\?/);
  assert.equal(parseSource(`<:dance:${id}>`, 'new_name').name, 'new_name');
  for (const url of ['https://example.com/file.gif', `https://cdn.discordapp.com.evil.test/emojis/${id}.gif`, 'file:///test.png']) assert.throws(() => parseSource(url));
});
test('download validates file data and enforces streaming size limits', async () => {
  assert.match(await download('test', async () => gif()), /^data:image\/gif;base64,/);
  await assert.rejects(download('test', async () => new Response('not an image')), /not a supported/);
  await assert.rejects(download('test', async () => new Response(Buffer.alloc(256 * 1024 + 1))), /256 KiB/);
});
test('uploads animated emoji to selected destination, reads back, and refuses collisions', async () => {
  for (const server of [false, true]) {
    const base = server ? `/guilds/${id}/emojis` : '/applications/app/emojis';
    let posts = 0, collision = false;
    const api = {
      async get(route) {
        if (route === '/oauth2/applications/@me') return { id: 'app' };
        if (route === base) { const items = collision ? [{ name: 'dance' }] : []; return server ? items : { items }; }
        assert.equal(route, `${base}/${id}`); return { id, name: 'dance', animated: true };
      },
      async post(route, { body }) { assert.equal(route, base); assert.match(body.image, /^data:image\/gif/); posts++; return { id }; },
    };
    const options = { source: `<a:dance:${id}>`, server, guildId: id, api, fetcher: async () => gif() };
    assert.equal((await importEmoji(options)).mention, `<a:dance:${id}>`);
    collision = true;
    await assert.rejects(importEmoji(options), /already exists/);
    assert.equal(posts, 1);
  }
});
