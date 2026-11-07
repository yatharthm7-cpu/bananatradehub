const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const sharp = require('sharp');
const { openDatabase, openHostedDatabase } = require('../website/db');
const { createServer } = require('../website/server');

async function exerciseMarketplace(t, driver) {
  const secure = driver === 'Turso client';
  const db = driver === 'local SQLite' ? openDatabase(':memory:') :
    await openHostedDatabase({ client: require('@libsql/client').createClient({ url: 'file::memory:' }) });
  const ids = { seller: '123456789012345671', buyer: '123456789012345672', admin: '123456789012345673', outsider: '123456789012345674' };
  const discord = { clientId: '123456789012345678', adminIds: [ids.admin], redirectUri: 'http://127.0.0.1/api/discord/callback', guildId: '987654321098765432' };
  const legacy = (await db.prepare("INSERT INTO users(email,ign,password) VALUES('legacy@example.test','SellerIGN','legacy')").run());
  await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,?)').run(legacy.lastInsertRowid, ids.seller, 'oldname', 1);
  // Website-only verification: every protected action needs a verified record.
  // These pre-seeded rows stand in for a completed website sign-in; the OAuth
  // test below still drives the real consent-bound login + callback flow.
  for (const discordId of Object.values(ids)) {
    await db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,verified_at,updated) VALUES(?,?,?,1,unixepoch(),unixepoch())')
      .run(discordId, discord.guildId, 'verified');
  }
  const revoked = new Set();
  const messages = [];
  const feed = [];
  const server = createServer({ db, discord, secure, identify: async (_config, code) => ({ id: ids[code], username: code, verified: true }),
    checkMember: async (_config, id) => !revoked.has(id),
    sendTradeMessage: async (...message) => { messages.push(message); },
    postListing: async listing => { feed.push(listing.id); }, cronSecret: 'test-cron-secret' });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const publicOrigin = secure ? 'https://marketplace.example.test' : origin;
  discord.redirectUri = publicOrigin + '/api/discord/callback';
  async function request(route, { body, cookie, expected = 200, from = publicOrigin } = {}) {
    const response = await fetch(origin + '/api' + route, body === undefined
      ? { headers: cookie ? { cookie } : {} }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', origin: from, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.status, expected, route + ': ' + JSON.stringify(payload));
    return { payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const landing = await fetch(origin);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Trading Hub/);
  assert.equal((await fetch(origin + '/logo.png')).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(origin + '/admin')).status, 200);
  assert.equal((await fetch(origin + '/api/feed-retry')).status, 403);
  assert.equal((await fetch(origin + '/api/feed-retry', { headers: { Authorization: 'Bearer test-cron-secret' } })).status, 200);
  await request('/login', { body: {}, expected: 401 });
  async function signIn(name, ign) {
    const start = await request('/discord/login', { body: { accepted: true, rulesVersion: 1 } });
    const state = new URL(start.payload.url).searchParams.get('state');
    const callback = origin + '/api/discord/callback?code=' + name + '&state=' + state;
    const finish = cookie => fetch(callback, { headers: { cookie }, redirect: 'manual' });
    assert.equal((await finish('banana_oauth=' + '0'.repeat(64))).status, 403);
    const response = await finish(start.cookie);
    assert.equal(/; Secure(?:;|$)/.test(response.headers.get('set-cookie')), secure);
    assert.equal(response.headers.get('location'), name === 'admin' ? '/admin#discord=linked' : '/#desk?discord=linked');
    assert.equal((await finish(start.cookie)).status, 403);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { user, discord: profile } = (await request('/session', { cookie })).payload;
    assert.equal(profile.verified, 1);
    if (!user.ign) await request('/profile', { cookie, body: { ign } });
    else assert.equal(user.id, Number(legacy.lastInsertRowid));
    return cookie;
  }
  const seller = await signIn('seller', 'SellerIGN');
  const buyer = await signIn('buyer', 'BuyerIGN');
  const admin = await signIn('admin', 'AdminUser');
  const outsider = await signIn('outsider', 'OtherIGN');
  const fixture = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#222222' } }).png().toBuffer();
  const listing = { catalogId: 'elytra', category: 'Rare', quantity: 1, wants: 'Dragon egg', rarityReason: 'Found aboard an End ship.',
    enchantments: [{ name: 'Mending', level: 1 }], durability: 98, screenshot: 'data:image/png;base64,' + fixture.toString('base64') };
  const offered = quantity => ({ items: [{ ...listing, catalogId: 'dragon-egg', quantity, enchantments: [], durability: null }] });
  revoked.add(ids.seller);
  await request('/listings', { cookie: seller, body: listing, expected: 403 });
  revoked.delete(ids.seller);
  await request('/listings', { cookie: seller, body: listing, from: 'https://elsewhere.example', expected: 403 });
  await request('/listings', { cookie: seller, body: { ...listing, category: 'Resources' }, expected: 400 });
  await request('/listings', { cookie: seller, body: { ...listing, screenshot: '' }, expected: 400 });
  await request('/listings', { cookie: seller, body: { ...listing, screenshot: 'data:image/png;base64,YWJjZA==' }, expected: 400 });
  const { payload: { id } } = await request('/listings', { cookie: seller, body: listing, expected: 201 });
  assert.equal(feed.length, 0);
  assert.deepEqual((await request('/me', { cookie: seller })).payload.slots, { used: 1, limit: 9 });
  assert.deepEqual((await request('/listings')).payload, []);
  assert.equal((await fetch(origin + `/api/listings/${id}/screenshot`)).status, 404);
  const staffProof = await fetch(origin + `/api/listings/${id}/screenshot`, { headers: { cookie: admin } });
  assert.equal(staffProof.headers.get('content-type'), 'image/webp');
  await request(`/listings/${id}/approve`, { cookie: seller, body: { proofReviewed: true }, expected: 403 });
  await request(`/listings/${id}/approve`, { cookie: admin, body: {}, expected: 400 });
  await request(`/listings/${id}/approve`, { cookie: admin, body: { proofReviewed: true } });
  assert.deepEqual(feed, [id]);
  assert.equal((await request('/listings')).payload[0].item, 'Elytra');
  await request('/preferences/trade-notifications', { cookie: seller, body: { enabled: true } });
  await request('/admin', { cookie: buyer, expected: 403 });
  await request(`/listings/${id}/hide`, { cookie: buyer, body: {}, expected: 403 });
  revoked.add(ids.buyer);
  await request(`/listings/${id}/request`, { cookie: buyer, body: offered(2), expected: 403 });
  revoked.delete(ids.buyer);
  await request(`/listings/${id}/request`, { cookie: buyer, body: offered(2) });
  assert.deepEqual(messages.map(entry => entry[0]), [ids.seller]);
  await request(`/listings/${id}/request`, { cookie: buyer, body: offered(2), expected: 409 });
  const { payload: { trades: [trade] } } = await request('/me', { cookie: seller });
  assert.equal((await fetch(origin + '/trade/' + trade.id)).status, 200);
  await request(`/trades/${trade.id}`, { cookie: outsider, expected: 404 });
  await request(`/trades/${trade.id}/accept`, { cookie: buyer, body: { version: 0 }, expected: 409 });
  await request(`/trades/${trade.id}/counter`, { cookie: seller, body: { version: 0, ...offered(3) } });
  assert.equal(messages.length, 1);
  const room = (await request(`/trades/${trade.id}`, { cookie: buyer })).payload;
  assert.equal(room.trade.current_offer, '3 × Dragon egg');
  assert.equal(room.proposals.length, 2);
  assert.equal(room.events[0].label, 'Counteroffer v1');
  await request(`/trades/${trade.id}/accept`, { cookie: buyer, body: { version: 0 }, expected: 409 });
  await request(`/trades/${trade.id}/accept`, { cookie: buyer, body: { version: 1, agreementReviewed: true } });
  const { snapshot } = (await request(`/trades/${trade.id}`, { cookie: buyer })).payload;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.offer, '3 × Dragon egg');
  assert.equal(snapshot.durability, 98);
  assert.deepEqual(snapshot.enchantments, listing.enchantments);
  assert.equal((await fetch(origin + snapshot.screenshot, { headers: { cookie: outsider } })).status, 404);
  assert.equal((await fetch(origin + snapshot.screenshot, { headers: { cookie: buyer } })).status, 200);
  assert.deepEqual((await request('/listings')).payload, []);
  await request(`/disputes/${trade.id}/open`, { cookie: buyer, body: { reason: 'Trade terms are in dispute.' } });
  await request(`/disputes/${trade.id}`, { cookie: outsider, expected: 404 });
  await request(`/trades/${trade.id}/confirm`, { cookie: seller, body: {}, expected: 409 });
  await request(`/disputes/${trade.id}/evidence`, { cookie: seller, body: { note: 'Screenshot of the agreement.', url: 'https://example.test/evidence' } });
  assert.equal((await request(`/disputes/${trade.id}`, { cookie: admin })).payload.evidence.length, 1);
  const decision = { decision: 'resume', resolution: 'Both members agreed to the original terms.' };
  await request(`/disputes/${trade.id}/resolve`, { cookie: seller, body: decision, expected: 403 });
  await request(`/disputes/${trade.id}/resolve`, { cookie: admin, body: decision });
  await request(`/trades/${trade.id}/confirm`, { cookie: buyer, body: {} });
  assert.equal((await request('/me', { cookie: buyer })).payload.trades[0].status, 'accepted');
  await request(`/trades/${trade.id}/confirm`, { cookie: seller, body: {} });
  assert.equal((await request('/me', { cookie: seller })).payload.trades[0].status, 'completed');
  const { payload: { id: second } } = await request('/listings', { cookie: seller, body: listing, expected: 201 });
  await request(`/listings/${second}/approve`, { cookie: admin, body: { proofReviewed: true } });
  await request(`/listings/${second}/hide`, { cookie: admin, body: {} });
  assert.deepEqual((await request('/listings')).payload, []);
  await request(`/listings/${second}/restore`, { cookie: admin, body: {} });
  assert.equal((await request('/listings')).payload.length, 1);
  assert.deepEqual(feed, [id, second]);
  let pending;
  for (let i = 0; i < 8; i++) {
    pending = (await request('/listings', { cookie: seller, body: listing, expected: 201 })).payload.id;
  }
  assert.deepEqual((await request('/me', { cookie: seller })).payload.slots, { used: 9, limit: 9 });
  await request('/listings', { cookie: seller, body: listing, expected: 409 });
  await request(`/listings/${pending}/withdraw`, { cookie: seller, body: {} });
  await request('/listings', { cookie: seller, body: listing, expected: 201 });
  const sellerId = (await request('/session', { cookie: seller })).payload.user.id;
  await request(`/admin/users/${sellerId}/suspend`, { cookie: admin, body: {} });
  assert.equal((await request('/session', { cookie: seller })).payload.user, null);
  assert.deepEqual((await request('/listings')).payload, []);
  assert.deepEqual((await request('/admin', { cookie: admin })).payload.audit.map(entry => entry.action),
    ['Member suspended', 'Listing restored', 'Listing hidden', 'Listing approved', 'Dispute resolved: resume', 'Listing approved']);
}
for (const driver of ['local SQLite', 'Turso client']) {
  test(`marketplace enforces trade ownership, reserves stock, and audits admin moderation with ${driver}`, t => exerciseMarketplace(t, driver));
}
