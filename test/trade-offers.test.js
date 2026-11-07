const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const sharp = require('sharp');
const { openDatabase, openHostedDatabase } = require('../website/db');
const { createServer } = require('../website/server');

async function fixture(t, driver) {
  const db = driver === 'SQLite' ? openDatabase(':memory:') : await openHostedDatabase({ client: require('@libsql/client').createClient({ url: 'file::memory:' }) });
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#9871b2' } }).png().toBuffer();
  const image = 'data:image/png;base64,' + png.toString('base64');
  const actors = {};
  for (const [index, name] of ['seller', 'buyer', 'other', 'admin'].entries()) {
    const id = (await db.prepare("INSERT INTO users(email,ign,password) VALUES(?,?,'')").run('discord:' + name, name + 'IGN')).lastInsertRowid;
    const discordId = '12345678901234567' + index;
    const token = String(index + 1).repeat(64);
    await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(id, discordId, name);
    await db.prepare("INSERT INTO sessions(token,user_id,expires,auth_method) VALUES(?,?,unixepoch()+3600,'discord')").run(createHash('sha256').update(token).digest('hex'), id);
    actors[name] = { id, discordId, cookie: 'banana_session=' + token };
  }
  const revoked = new Set();
  const unavailable = new Set();
  const hook = { afterCheck: null };
  const guildId = '987654321098765432';
  for (const { discordId } of Object.values(actors)) {
    await db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,verified_at,updated) VALUES(?,?,?,1,unixepoch(),unixepoch())')
      .run(discordId, guildId, 'verified');
  }
  const server = createServer({ db, discord: { adminIds: [actors.admin.discordId], redirectUri: 'http://localhost/api/discord/callback', guildId },
    sendTradeMessage: null, postListing: null,
    checkMember: async (_discord, id) => {
      if (unavailable.has(id)) throw new Error('Discord unavailable');
      if (hook.afterCheck) await hook.afterCheck(id);
      return !revoked.has(id);
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const item = (quantity = 2) => ({ catalogId: 'dragon-egg', category: 'Rare', quantity, rarityReason: 'Rare dragon egg acquired in-game.', enchantments: [], durability: null, screenshot: image });
  const request = async (path, actor, body, expected = 200) => {
    const response = await fetch(origin + '/api' + path, { headers: { ...(actor ? { cookie: actors[actor].cookie } : {}), ...(body === undefined ? {} : { origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (expected === null) return { status: response.status, data };
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  };
  async function listing() {
    const id = (await db.prepare("INSERT INTO listings(seller_id,item,category,quantity,wants,notes) VALUES(?,'Elytra','Rare',1,'Rare items','Original notes')").run(actors.seller.id)).lastInsertRowid;
    await db.prepare('INSERT INTO listing_proofs(listing_id,details,image) VALUES(?,?,?)').run(id, JSON.stringify({ item: 'Elytra', catalogId: 'elytra', customName: '', rarityReason: 'Rare End ship item.', durability: 95, enchantments: [{ name: 'Mending', level: 1 }] }), png);
    return id;
  }
  async function offer(listingId, actor = 'buyer', items = [item()]) { return (await request(`/listings/${listingId}/request`, actor, { items })).tradeId; }
  return { db, actors, png, item, request, listing, offer, revoked, unavailable, hook };
}

for (const driver of ['SQLite', 'Turso']) {
  test(`${driver}: structured offers require eligible item evidence and keep it private`, async t => {
    const h = await fixture(t, driver), id = await h.listing();
    await h.request(`/listings/${id}/request`, 'buyer', { offer: 'cash or common items' }, 400);
    await h.request(`/listings/${id}/request`, 'buyer', { items: [{ ...h.item(), category: 'Building' }] }, 400);
    await h.request(`/listings/${id}/request`, 'buyer', { items: [{ ...h.item(), screenshot: undefined }] }, 400);
    await h.request(`/listings/${id}/request`, 'buyer', { items: [h.item(), h.item(), h.item(), h.item()] }, 400);
    const largePng = await sharp(randomBytes(700 * 500 * 3), { raw: { width: 700, height: 500, channels: 3 } }).png().toBuffer();
    const largeItem = { ...h.item(), screenshot: 'data:image/png;base64,' + largePng.toString('base64') };
    await h.request(`/listings/${id}/request`, 'buyer', { items: [largeItem, largeItem] }, 400);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM trades').get()).total, 0);
    const tradeId = await h.offer(id);
    const room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.requiresEvidence, false);
    assert.equal(room.proposals[0].items[0].reviewStatus, 'Submitted · not staff-reviewed');
    const path = room.proposals[0].items[0].screenshot.replace('/api', '');
    assert.ok(Buffer.isBuffer(await h.request(path, 'buyer')));
    await h.request(path, 'seller'); await h.request(path, 'admin');
    await h.request(path, 'other', undefined, 404); await h.request(path, null, undefined, 404);
    await h.request('/trades/' + tradeId + '/accept', 'seller', { version: 0 }, 400);
  });

  test(`${driver}: counteroffers preserve versions and require new evidence for changed facts`, async t => {
    const h = await fixture(t, driver), tradeId = await h.offer(await h.listing());
    const reuse = { ...h.item(1), screenshot: undefined, proofRef: { version: 0, position: 0 } };
    await h.request(`/trades/${tradeId}/counter`, 'buyer', { version: 0, items: [reuse] }, 409);
    await h.request(`/trades/${tradeId}/counter`, 'seller', { version: 0, items: [{ ...reuse, quantity: 3 }] }, 400);
    await h.request(`/trades/${tradeId}/counter`, 'seller', { version: 0, items: [{ ...reuse, durability: 50 }] }, 400);
    await h.request(`/trades/${tradeId}/counter`, 'seller', { version: 0, items: [reuse] });
    await h.request(`/trades/${tradeId}/accept`, 'buyer', { version: 0, agreementReviewed: true }, 409);
    const room = await h.request('/trades/' + tradeId, 'buyer');
    assert.equal(room.proposals.length, 2);
    assert.equal(room.proposals[0].items[0].quantity, 1);
    assert.equal(room.proposals[1].items[0].quantity, 2);
    assert.equal(room.proposals[0].items[0].submittedBy, h.actors.buyer.id);
    await h.request(`/trades/${tradeId}/accept`, 'buyer', { version: 1, agreementReviewed: true });
  });

  test(`${driver}: acceptance fails closed for either player's eligibility and concurrent suspension`, async t => {
    const h = await fixture(t, driver), tradeId = await h.offer(await h.listing());
    const accept = () => h.request(`/trades/${tradeId}/accept`, 'seller', { version: 0, agreementReviewed: true }, 403);
    h.revoked.add(h.actors.buyer.discordId); await accept(); h.revoked.clear();
    h.revoked.add(h.actors.seller.discordId); await accept(); h.revoked.clear();
    h.unavailable.add(h.actors.buyer.discordId);
    await h.request(`/trades/${tradeId}/accept`, 'seller', { version: 0, agreementReviewed: true }, 503); h.unavailable.clear();
    h.hook.afterCheck = async id => { if (id === h.actors.buyer.discordId) await h.db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(h.actors.buyer.id); };
    await accept(); h.hook.afterCheck = null;
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM trade_snapshots').get()).total, 0);
    assert.equal((await h.db.prepare('SELECT status FROM trades WHERE id=?').get(tradeId)).status, 'pending');
  });

  test(`${driver}: competing acceptance reserves once and freezes both sides and screenshot bytes`, async t => {
    const h = await fixture(t, driver), listingId = await h.listing();
    const a = await h.offer(listingId), b = await h.offer(listingId, 'other');
    const responses = await Promise.all([a, b].map(id => h.request(`/trades/${id}/accept`, 'seller', { version: 0, agreementReviewed: true }, null)));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await h.db.prepare("SELECT id FROM trades WHERE status='accepted'").get();
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM trade_snapshots').get()).total, 1);
    assert.equal((await h.db.prepare('SELECT status FROM listings WHERE id=?').get(listingId)).status, 'reserved');
    const room = await h.request('/trades/' + winner.id, 'seller');
    const snapshot = room.snapshot;
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.sellerItems[0].quantity, 1);
    assert.equal(snapshot.buyerItems[0].quantity, 2);
    assert.equal(snapshot.participants.seller.ign, 'sellerIGN');
    const before = await h.request(snapshot.sellerItems[0].screenshot.replace('/api', ''), 'seller');
    assert.equal(createHash('sha256').update(before).digest('hex'), snapshot.sellerItems[0].sha256);
    await h.request(snapshot.buyerItems[0].screenshot.replace('/api', ''), 'admin');
    const outsider = winner.id === a ? 'other' : 'buyer';
    await h.request(snapshot.buyerItems[0].screenshot.replace('/api', ''), outsider, undefined, 404);
    await h.db.prepare("UPDATE users SET ign='ChangedIGN' WHERE id=?").run(h.actors.seller.id);
    await h.db.prepare("UPDATE listing_proofs SET image=?,details='{}' WHERE listing_id=?").run(Buffer.from('changed'), listingId);
    assert.deepEqual((await h.request('/trades/' + winner.id, 'seller')).snapshot, snapshot);
    assert.deepEqual(await h.request(snapshot.sellerItems[0].screenshot.replace('/api', ''), 'seller'), before);
    const winnerActor = winner.id === a ? 'buyer' : 'other';
    await h.request(`/trades/${winner.id}/confirm`, winnerActor, {});
    await h.request(`/trades/${winner.id}/moderate`, 'admin', {}, 409);
    await h.request(`/listings/${listingId}/hide`, 'admin', {}, 409);
    await h.request(`/admin/users/${h.actors[winnerActor].id}/suspend`, 'admin', {});
    assert.equal((await h.db.prepare('SELECT status FROM trades WHERE id=?').get(winner.id)).status, 'accepted');
    assert.equal((await h.db.prepare('SELECT status FROM listings WHERE id=?').get(listingId)).status, 'reserved');
  });

  test(`${driver}: legacy accepted records remain intact and pending text offers require evidence`, async t => {
    const h = await fixture(t, driver), listingId = await h.listing();
    const pending = (await h.db.prepare("INSERT INTO trades(listing_id,buyer_id,offer) VALUES(?,?,'Old offer')").run(listingId, h.actors.buyer.id)).lastInsertRowid;
    const room = await h.request('/trades/' + pending, 'seller');
    assert.equal(room.requiresEvidence, true);
    await h.request(`/trades/${pending}/accept`, 'seller', { version: 0, agreementReviewed: true }, 409);
    await h.request(`/trades/${pending}/counter`, 'seller', { version: 0, items: [h.item()] });
    assert.equal((await h.request('/trades/' + pending, 'buyer')).requiresEvidence, false);
    const accepted = (await h.db.prepare("INSERT INTO trades(listing_id,buyer_id,offer,status) VALUES(?,?,'Legacy accepted terms','accepted')").run(listingId, h.actors.other.id)).lastInsertRowid;
    const legacy = { item: 'Elytra', quantity: 1, offer: 'Legacy accepted terms', version: 0, seller: 'OriginalSeller', buyer: 'OriginalBuyer', screenshot: `/api/listings/${listingId}/screenshot` };
    await h.db.prepare('INSERT INTO trade_snapshots VALUES(?,?)').run(accepted, JSON.stringify(legacy));
    assert.deepEqual((await h.request('/trades/' + accepted, 'other')).snapshot, legacy);
    assert.equal((await h.request('/trades/' + accepted, 'other')).requiresEvidence, false);
  });
}
