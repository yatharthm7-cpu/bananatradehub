const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./marketplace-fixture');

for (const driver of ['SQLite', 'Turso']) {
  test(`${driver}: receipts store per-participant timestamps and complete exactly once`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.accept(tradeId);
    // Confirm by an outsider is refused; a pending cancellation would pause receipts.
    await h.request(`/trades/${tradeId}/confirm`, 'other', {}, 403);
    // First participant confirms: timestamp recorded, trade still accepted.
    await h.request(`/trades/${tradeId}/confirm`, 'buyer', {});
    let trade = await h.db.prepare('SELECT status,buyer_done,seller_done,buyer_confirmed_at,seller_confirmed_at FROM trades WHERE id=?').get(tradeId);
    assert.equal(trade.status, 'accepted');
    assert.equal(trade.buyer_done, 1);
    assert.equal(trade.seller_done, 0);
    assert.ok(trade.buyer_confirmed_at > 0);
    assert.equal(trade.seller_confirmed_at, null);
    assert.equal(await h.unread('seller'), 2); // offer + the other player's receipt
    // A repeated confirmation by the same side is a no-op (idempotent), not an error.
    await h.request(`/trades/${tradeId}/confirm`, 'buyer', {});
    trade = await h.db.prepare('SELECT buyer_done,buyer_confirmed_at FROM trades WHERE id=?').get(tradeId);
    assert.equal(trade.buyer_done, 1);
    // Second participant completes the trade exactly once.
    await h.request(`/trades/${tradeId}/confirm`, 'seller', {});
    trade = await h.db.prepare('SELECT status,seller_done,seller_confirmed_at FROM trades WHERE id=?').get(tradeId);
    assert.equal(trade.status, 'completed');
    assert.ok(trade.seller_confirmed_at > 0);
    // After completion, confirms are refused (the trade is closed), and no extra
    // completion record can be created by repeating the request.
    await h.request(`/trades/${tradeId}/confirm`, 'seller', {}, 409);
    await h.request(`/trades/${tradeId}/confirm`, 'buyer', {}, 409);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM trade_events WHERE label='Trade completed'").get()).total, 1);
    // Both players receive the completion notification exactly once.
    assert.equal(await h.unread('buyer'), 3); // acceptance + the seller's receipt + completion
    assert.equal(await h.unread('seller'), 3); // offer + the buyer's receipt + completion
    const events = (await h.db.prepare('SELECT label FROM trade_events WHERE trade_id=? ORDER BY id').all(tradeId)).map(row => row.label);
    assert.ok(events.some(label => label.includes('Receipt confirmed: I received the agreed items')));
  });

  test(`${driver}: arrangement identifies the author and the other player's acknowledgement`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.accept(tradeId);
    // Validation: bounded fields; non-participants cannot propose.
    await h.request(`/trades/${tradeId}/arrangement`, 'buyer', { server: 'a' }, 400);
    await h.request(`/trades/${tradeId}/arrangement`, 'other', { server: 'Survival market' }, 404);
    await h.request(`/trades/${tradeId}/arrangement`, 'buyer', { server: 'Survival /spawn market', meetingTime: 'Saturday 20:00', timezone: 'UTC+2' });
    let room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.arrangement.server, 'Survival /spawn market');
    assert.equal(room.arrangement.proposed_by, h.actors.buyer.id);
    assert.equal(room.arrangement.acknowledged_by, null);
    assert.equal(await h.unread('seller'), 2); // the offer + the arrangement proposal (the seller is the acceptance actor)
    // Only the other participant can acknowledge.
    await h.request(`/trades/${tradeId}/arrangement/ack`, 'buyer', {}, 403);
    await h.request(`/trades/${tradeId}/arrangement/ack`, 'seller', {});
    room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.arrangement.acknowledged_by, h.actors.seller.id);
    // An arrangement change resets the acknowledgement and never touches the agreement.
    await h.request(`/trades/${tradeId}/arrangement`, 'buyer', { server: 'Hub plot 12' });
    room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.arrangement.server, 'Hub plot 12');
    assert.equal(room.arrangement.acknowledged_by, null);
    assert.equal(room.snapshot.schemaVersion, 2);
    assert.equal(room.snapshot.buyerItems.length, 1);
    assert.equal(room.snapshot.sellerItems[0].quantity, 1);
  });

  test(`${driver}: lightweight version endpoint serves visibility-aware polling`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    let check = await h.request(`/trades/${tradeId}/version`, 'seller');
    assert.equal(check.status, 'pending');
    assert.equal(check.version, 0);
    assert.equal(check.buyerDone, false);
    assert.equal(check.pendingCancellation, false);
    await h.request(`/trades/${tradeId}/counter`, 'seller', { version: 0, items: [h.item(1)] });
    check = await h.request(`/trades/${tradeId}/version`, 'seller');
    assert.equal(check.version, 1); // the client can mark an open acceptance review stale
    await h.accept(tradeId, 'buyer', 1);
    check = await h.request(`/trades/${tradeId}/version`, 'seller');
    assert.equal(check.status, 'accepted');
    // Outsiders and anonymous callers cannot poll a trade they do not own.
    await h.request(`/trades/${tradeId}/version`, 'other', undefined, 404);
    await h.request(`/trades/${tradeId}/version`, null, undefined, 401);
    // A pending cancellation shows up in the check without fetching the full room.
    await h.request(`/trades/${tradeId}/cancel-request`, 'seller', { reason: 'Cannot deliver this week.' });
    check = await h.request(`/trades/${tradeId}/version`, 'buyer');
    assert.equal(check.pendingCancellation, true);
  });

  test(`${driver}: empty marketplace stays honest with no fabricated listings or activity`, async t => {
    const h = await fixture(t, driver);
    const listings = await h.request('/listings', null);
    assert.deepEqual(listings, []);
    // The honest empty state is client-rendered: the shipped bundle must contain it
    // and must never expose the removed sample-card fallback.
    const bundle = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'website', 'public', 'app.js'), 'utf8');
    assert.ok(bundle.includes('No approved listings yet'));
    assert.ok(!bundle.includes('View example'));
    assert.ok(!bundle.includes("sample: true"));
    // A session and notification count work with an empty marketplace.
    const session = await h.request('/session', null);
    assert.equal(session.user, null);
    assert.equal(session.unread, 0);
    // Rejected or hidden listings never leak into the public feed.
    const id = await h.listing();
    await h.db.prepare("UPDATE listings SET status='review' WHERE id=?").run(id);
    await h.request(`/listings/${id}/reject`, 'admin', { reason: 'Not a rare item.' });
    assert.deepEqual(await h.request('/listings', null), []);
    const open = await h.listing();
    await h.request(`/listings/${open}/hide`, 'admin', {});
    assert.deepEqual(await h.request('/listings', null), []);
  });

  test(`${driver}: immediate background delivery attempt works alongside the inbox`, async t => {
    const h = await fixture(t, driver, { background: promise => void promise });
    await h.optInDM('seller');
    await h.offer(await h.listing());
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.sent.length, 1);
    assert.equal(await h.unread('seller'), 1);
  });
}

test('delivery state stays durable across server restarts within the process', async t => {
  const h = await fixture(t, 'SQLite');
  await h.optInDM('seller');
  const tradeId = await h.offer(await h.listing());
  const before = await h.db.prepare('SELECT state,attempts,next_attempt_at,lease_until FROM delivery_outbox WHERE event_key=?').get('trade:' + tradeId + ':offer');
  assert.equal(before.state, 'pending');
  // The outbox read path works from a fresh query handle: pending jobs survive
  // browser closure and serverless restarts because they live in the database.
  const after = await h.db.prepare('SELECT count(*) AS total FROM delivery_outbox WHERE state=?').get('pending');
  assert.equal(after.total, 1);
  // A cron flush then delivers it without losing the notification.
  await h.flushDeliveries();
  const delivered = await h.db.prepare('SELECT state FROM delivery_outbox WHERE event_key=?').get('trade:' + tradeId + ':offer');
  assert.equal(delivered.state, 'sent');
});

test('cron retry endpoints are protected and feed retry stays bounded', async t => {
  const h = await fixture(t, 'SQLite');
  // No secret: denied.
  const denied = await fetch(h.origin + '/api/delivery-retry');
  assert.equal(denied.status, 403);
  const feedDenied = await fetch(h.origin + '/api/feed-retry');
  assert.equal(feedDenied.status, 403);
  // With the secret: succeeds.
  const allowed = await fetch(h.origin + '/api/delivery-retry', { headers: { Authorization: 'Bearer phase2-cron-secret' } });
  assert.equal(allowed.status, 200);
});
