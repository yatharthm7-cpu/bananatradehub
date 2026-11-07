// Shared test fixture for the Phase 2 suites. Test-only: never required by the app,
// the build, the preview, or the bot. Fixtures live in-memory or in temp stores.
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { openDatabase, openHostedDatabase } = require('../website/db');
const { createServer } = require('../website/server');

async function fixture(t, driver = 'SQLite', options = {}) {
  const db = driver === 'SQLite' ? openDatabase(':memory:') : await openHostedDatabase({ client: require('@libsql/client').createClient({ url: 'file::memory:' }) });
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#9871b2' } }).png().toBuffer();
  const image = 'data:image/png;base64,' + png.toString('base64');
  const actors = {};
  for (const [index, name] of ['seller', 'buyer', 'other', 'admin'].entries()) {
    const id = (await db.prepare("INSERT INTO users(email,ign,password) VALUES(?,?,'')").run('discord:' + name, name + 'IGN')).lastInsertRowid;
    const discordId = '10987654321098765' + index;
    const token = String(index + 1).repeat(64);
    await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,1)').run(id, discordId, name);
    await db.prepare("INSERT INTO sessions(token,user_id,expires,auth_method) VALUES(?,?,unixepoch()+3600,'discord')").run(createHash('sha256').update(token).digest('hex'), id);
    actors[name] = { id, discordId, cookie: 'banana_session=' + token };
  }
  const guildId = '987654321098765432';
  // Stand in for completed website verification so protected actions depend on
  // the checked seam (checkMember) rather than a Discord REST call.
  for (const { discordId } of Object.values(actors)) {
    await db.prepare('INSERT INTO website_verification_records(discord_id,guild_id,state,rules_version,verified_at,updated) VALUES(?,?,?,1,unixepoch(),unixepoch())')
      .run(discordId, guildId, 'verified');
  }
  const revoked = new Set();
  const sent = [];
  const sendAttempts = [];
  let sendBehavior = null; // null = success, 'permanent' | 'transient' | 'rateLimited' | <ms delay>
  const server = createServer({
    db,
    discord: { adminIds: [actors.admin.discordId], redirectUri: 'http://localhost/api/discord/callback', guildId },
    cronSecret: 'phase2-cron-secret',
    // Tests defer immediate background delivery attempts: every delivery flows
    // through an explicit cron flush or the worker protocol instead.
    background: options.background === undefined ? null : options.background,
    checkMember: async (_discord, id) => !revoked.has(id),
    sendTradeMessage: async (recipient, tradeId, message) => {
      try {
        if (typeof sendBehavior === 'number') await new Promise(resolve => setTimeout(resolve, sendBehavior));
        if (sendBehavior === 'permanent') throw Object.assign(new Error('Cannot send messages to this user.'), { code: 50007 });
        if (sendBehavior === 'transient') throw new Error('Internal Discord error.');
        if (sendBehavior === 'rateLimited') throw Object.assign(new Error('You are being rate limited.'), { code: 429, retryAfter: 2 });
        sent.push({ recipient, tradeId, message });
      } catch (error) {
        sendAttempts.push({ recipient, error });
        throw error;
      }
    },
    postListing: null,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const item = (quantity = 2) => ({ catalogId: 'dragon-egg', category: 'Rare', quantity, rarityReason: 'Rare dragon egg acquired in-game.', enchantments: [], durability: null, screenshot: image });
  const request = async (path, actor, body, expected = 200) => {
    const response = await fetch(origin + '/api' + path, { headers: { ...(actor ? { cookie: actors[actor].cookie } : {}), ...(body === undefined ? {} : { origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (expected === null) return { status: response.status, data };
    assertStatus(response.status, expected, path, data);
    return data;
  };
  async function listing(actor = 'seller') {
    const id = (await db.prepare("INSERT INTO listings(seller_id,item,category,quantity,wants,notes) VALUES(?,'Elytra','Rare',1,'Rare items','Original notes')").run(actors[actor].id)).lastInsertRowid;
    await db.prepare('INSERT INTO listing_proofs(listing_id,details,image) VALUES(?,?,?)').run(id, JSON.stringify({ item: 'Elytra', catalogId: 'elytra', customName: '', rarityReason: 'Rare End ship item.', durability: 95, enchantments: [{ name: 'Mending', level: 1 }] }), png);
    return id;
  }
  async function approvedListing(actor = 'seller') {
    const id = await listing(actor);
    await db.prepare("UPDATE listings SET status='open' WHERE id=?").run(id);
    return id;
  }
  async function offer(listingId, actor = 'buyer', items = [item()]) { return (await request(`/listings/${listingId}/request`, actor, { items })).tradeId; }
  async function accept(tradeId, actor = 'seller', version = 0) {
    return request(`/trades/${tradeId}/accept`, actor, { version, agreementReviewed: true });
  }
  async function approve(listingId) {
    return request(`/listings/${listingId}/approve`, 'admin', { proofReviewed: true });
  }
  async function optInDM(actor) {
    await db.prepare('INSERT OR IGNORE INTO trade_notification_preferences VALUES(?)').run(actors[actor].id);
  }
  async function flushDeliveries() {
    const response = await fetch(origin + '/api/delivery-retry', { headers: { Authorization: 'Bearer phase2-cron-secret' } });
    const data = await response.json();
    assertStatus(response.status, 200, '/api/delivery-retry', data);
    return data;
  }
  async function deliveryWork(method, body) {
    const init = { method, headers: { Authorization: 'Bearer phase2-cron-secret' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetch(origin + '/api/delivery-work', init);
    return { status: response.status, data: response.status === 200 ? await response.json() : await response.text() };
  }
  async function notifications(actor, after = 0) {
    const query = after ? '?after=' + after : '';
    return request('/notifications' + query, actor);
  }
  async function unread(actor) {
    return (await request('/notifications/count', actor)).unread;
  }
  return { db, actors, png, image, item, request, listing, approvedListing, offer, accept, approve, optInDM, flushDeliveries, deliveryWork, notifications, unread, revoked, sent, sendAttempts, setSendBehavior: behavior => { sendBehavior = behavior; }, origin };
}

function assertStatus(actual, expected, path, data) {
  if (actual !== expected) throw new Error(`${path}: expected ${expected}, got ${actual}: ${JSON.stringify(data)}`);
}

module.exports = { fixture };
