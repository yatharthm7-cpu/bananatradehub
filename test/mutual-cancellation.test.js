const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./marketplace-fixture');

for (const driver of ['SQLite', 'Turso']) {
  test(`${driver}: mutual cancellation request, agreement, decline, and withdrawal`, async t => {
    const h = await fixture(t, driver);
    const listingId = await h.listing();
    const tradeId = await h.offer(listingId);
    await h.accept(tradeId);
    // Sanity: only accepted trades with no receipt and no dispute can request.
    await h.request(`/trades/${tradeId}/cancel-request`, 'other', { reason: 'Not my trade.' }, 404);
    await h.request(`/trades/${tradeId}/cancel-request`, 'seller', { reason: 'Changed my mind about selling.' });
    const room = await h.request('/trades/' + tradeId, 'buyer');
    assert.equal(room.cancellation.status, 'pending');
    assert.equal(room.cancellation.requested_by, h.actors.seller.id);
    assert.equal(room.cancellation.reason, 'Changed my mind about selling.');
    assert.equal(await h.unread('buyer'), 2); // acceptance + cancellation request
    // The other participant agrees: the trade closes once and the listing is withdrawn.
    await h.request(`/trades/${tradeId}/cancel-request/agree`, 'buyer', {});
    const closed = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(closed.trade.status, 'cancelled');
    assert.equal(closed.cancellation.status, 'agreed');
    assert.equal(closed.cancellation.decided_by, h.actors.buyer.id);
    assert.equal((await h.db.prepare('SELECT status FROM listings WHERE id=?').get(listingId)).status, 'withdrawn');
    // A repeated agree is refused; the closure happens exactly once.
    await h.request(`/trades/${tradeId}/cancel-request/agree`, 'buyer', {}, 409);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM trades WHERE id=? AND status='cancelled'").get(tradeId)).total, 1);
    // Both sides are notified of the outcome.
    assert.equal(await h.unread('seller'), 2); // the original offer + the agreed cancellation
    assert.equal(await h.unread('buyer'), 3); // acceptance + the request + the agreed cancellation
    // The slot is released (withdrawn listings do not occupy slots).
    assert.equal((await h.db.prepare(`SELECT count(*) AS used FROM listings l LEFT JOIN listing_proofs p ON p.listing_id=l.id
      WHERE l.seller_id=? AND (l.status='reserved' OR (l.status IN ('review','open') AND p.listing_id IS NOT NULL))`).get(h.actors.seller.id)).used, 0);
  });

  test(`${driver}: decline and withdrawal let the trade continue`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.accept(tradeId);
    await h.request(`/trades/${tradeId}/cancel-request`, 'buyer', { reason: 'I cannot trade this week.' });
    await h.request(`/trades/${tradeId}/cancel-request/decline`, 'seller', {});
    let room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.trade.status, 'accepted');
    assert.equal(room.cancellation.status, 'declined');
    assert.equal(await h.unread('buyer'), 2); // requester learns the decision (after the earlier acceptance)
    // After a decline a new request can be made and then withdrawn.
    await h.request(`/trades/${tradeId}/cancel-request`, 'buyer', { reason: 'Actually I prefer to cancel.' });
    await h.request(`/trades/${tradeId}/cancel-request/withdraw`, 'buyer', {});
    room = await h.request('/trades/' + tradeId, 'seller');
    assert.equal(room.cancellation.status, 'withdrawn');
    assert.equal(room.trade.status, 'accepted');
    // Only the requester can withdraw; the other player cannot cancel unilaterally.
    await h.request(`/trades/${tradeId}/cancel-request`, 'buyer', { reason: 'One more try.' });
    await h.request(`/trades/${tradeId}/cancel-request/withdraw`, 'seller', {}, 403);
    await h.request(`/trades/${tradeId}/cancel-request/agree`, 'buyer', {}, 403); // the requester cannot answer their own request
    assert.equal((await h.request('/trades/' + tradeId, 'buyer')).cancellation.status, 'pending');
  });

  test(`${driver}: confirmed receipts force dispute review instead of cancellation`, async t => {
    const h = await fixture(t, driver);
    const listingId = await h.listing();
    const tradeId = await h.offer(listingId);
    await h.accept(tradeId);
    await h.request(`/trades/${tradeId}/confirm`, 'buyer', {});
    // With one receipt confirmed, a mutual cancellation request is blocked.
    await h.request(`/trades/${tradeId}/cancel-request`, 'seller', { reason: 'Cannot deliver.' }, 409);
    // And the trade cannot be cancelled through any ordinary route.
    await h.request(`/trades/${tradeId}/cancel`, 'seller', {}, 409);
    await h.request(`/trades/${tradeId}/moderate`, 'admin', {}, 409);
    const trade = await h.db.prepare('SELECT status FROM trades WHERE id=?').get(tradeId);
    assert.equal(trade.status, 'accepted');
  });

  test(`${driver}: receipt confirmation is paused while a cancellation request is open`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.accept(tradeId);
    await h.request(`/trades/${tradeId}/cancel-request`, 'seller', { reason: 'Cannot deliver.' });
    await h.request(`/trades/${tradeId}/confirm`, 'buyer', {}, 409);
    await h.request(`/disputes/${tradeId}/open`, 'buyer', { reason: 'Seller will not deliver.' }, 409);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM disputes').get()).total, 0);
  });

  test(`${driver}: agreeing twice, racing agreements, and duplicate actions produce one outcome`, async t => {
    const h = await fixture(t, driver);
    const listingId = await h.listing();
    const tradeId = await h.offer(listingId);
    await h.accept(tradeId);
    await h.request(`/trades/${tradeId}/cancel-request`, 'seller', { reason: 'Duplicate safety check.' });
    // Two concurrent agree attempts: exactly one wins.
    const results = await Promise.all([
      h.request(`/trades/${tradeId}/cancel-request/agree`, 'buyer', {}, null),
      h.request(`/trades/${tradeId}/cancel-request/agree`, 'buyer', {}, null),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM cancellation_requests WHERE trade_id=? AND status='agreed'").get(tradeId)).total, 1);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM listings WHERE id=? AND status='withdrawn'").get(listingId)).total, 1);
    // Agreed cancellation preserves the accepted agreement and evidence for review.
    const evidence = await h.request(`/trades/${tradeId}/agreement/buyer/0/screenshot`, 'admin', undefined);
    assert.ok(Buffer.isBuffer(evidence));
    await h.request(`/trades/${tradeId}/agreement/buyer/0/screenshot`, 'other', undefined, 404);
  });

  test(`${driver}: pending proposals keep the baseline participant cancel route with notifications`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.request(`/trades/${tradeId}/cancel`, 'buyer', {});
    assert.equal((await h.db.prepare('SELECT status FROM trades WHERE id=?').get(tradeId)).status, 'cancelled');
    assert.equal(await h.unread('seller'), 2); // offer + cancellation
    assert.equal(await h.unread('buyer'), 0);
  });

  test(`${driver}: accepted disputes cannot be bypassed through an ordinary cancellation`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    await h.accept(tradeId);
    await h.request(`/disputes/${tradeId}/open`, 'buyer', { reason: 'The offer terms were misrepresented.' });
    // Dispute open blocks the cancellation request path and ordinary cancellation.
    await h.request(`/trades/${tradeId}/cancel-request`, 'buyer', { reason: 'Try to bypass.' }, 409);
    await h.request(`/trades/${tradeId}/cancel`, 'buyer', {}, 409);
    // Staff review remains the route: cancel through the dispute review path.
    await h.request(`/disputes/${tradeId}/resolve`, 'admin', { decision: 'cancel', resolution: 'Cancelled through staff review.' });
    assert.equal((await h.db.prepare('SELECT status FROM trades WHERE id=?').get(tradeId)).status, 'cancelled');
    assert.equal((await h.db.prepare('SELECT status FROM listings WHERE id=(SELECT listing_id FROM trades WHERE id=?)').get(tradeId)).status, 'withdrawn');
    // No mutual-cancellation record was needed or created.
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM cancellation_requests WHERE trade_id=?').get(tradeId)).total, 0);
  });
}
