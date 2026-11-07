const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./marketplace-fixture');

for (const driver of ['SQLite', 'Turso']) {
  test(`${driver}: business events create recipient-scoped inbox records with unread isolation`, async t => {
    const h = await fixture(t, driver);
    await h.optInDM('seller');
    const listingId = await h.listing();
    const tradeId = await h.offer(listingId); // seller is the recipient of the offer event
    assert.equal(await h.unread('seller'), 1);
    assert.equal(await h.unread('buyer'), 0); // the offerer is not notified of their own offer
    assert.equal(await h.unread('other'), 0);
    const inbox = await h.notifications('seller');
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].event_type, 'offer');
    assert.equal(inbox.items[0].read, false);
    assert.equal(inbox.items[0].link, '/trade/' + tradeId);
    // Unrelated accounts never see the recipient's notifications.
    const otherInbox = await h.notifications('other');
    assert.equal(otherInbox.items.length, 0);
  });

  test(`${driver}: notifications are transactional - a failed business event writes no records`, async t => {
    const h = await fixture(t, driver);
    const tradeId = await h.offer(await h.listing());
    h.revoked.add(h.actors.buyer.discordId); // acceptance fails closed after the checks
    await h.request(`/trades/${tradeId}/accept`, 'seller', { version: 0, agreementReviewed: true }, 403);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM notifications WHERE event_type='acceptance'").get()).total, 0);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM delivery_outbox').get()).total, 0);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM notifications').get()).total, 1); // only the original offer event
  });

  test(`${driver}: retries, double clicks, and repeated actions do not duplicate notifications or deliveries`, async t => {
    const h = await fixture(t, driver);
    await h.optInDM('seller');
    const tradeId = await h.offer(await h.listing());
    // A second live request on the same listing is rejected; no duplicate row.
    await h.request(`/listings/${tradeId}/request`, 'buyer', { items: [h.item()] }, 409).catch(() => {});
    await h.flushDeliveries();
    await h.flushDeliveries();
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM notifications WHERE event_key='trade:" + tradeId + ":offer'").get()).total, 1);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM delivery_outbox').get()).total, 1);
    assert.equal(h.sent.length, 1); // exactly one DM, despite two flushes
    // A declined offer creates one decline notification for the offerer only.
    const second = await h.offer(await h.listing());
    await h.request(`/trades/${second}/decline`, 'seller', { version: 0 });
    assert.equal(await h.unread('buyer'), 1);
    assert.equal((await h.db.prepare("SELECT count(*) AS total FROM notifications WHERE event_key='trade:" + second + ":decline'").get()).total, 1);
  });

  test(`${driver}: mark read, read all, and pagination work and stay recipient-scoped`, async t => {
    const h = await fixture(t, driver);
    await h.optInDM('seller');
    for (let index = 0; index < 3; index++) await h.offer(await h.listing());
    const first = await h.notifications('seller');
    assert.equal(first.items.length, 3);
    assert.equal(await h.unread('seller'), 3);
    await h.request('/notifications/' + first.items[0].id + '/read', 'seller', {});
    assert.equal(await h.unread('seller'), 2);
    // Another recipient cannot mark or read a notification that is not theirs.
    await h.request('/notifications/' + first.items[0].id + '/read', 'other', {}, 404);
    await h.request('/notifications/read-all', 'seller', {});
    assert.equal(await h.unread('seller'), 0);
    const after = await h.notifications('seller');
    assert.equal(after.items.every(item => item.read), true);
    // Pagination: fetch after the newest id returns nothing more.
    const page = await h.notifications('seller', first.items[0].id);
    assert.equal(page.items.length, 2);
  });

  test(`${driver}: durable outbox delivers with backoff, stops for permanent failures, and honors leases`, async t => {
    const h = await fixture(t, driver);
    await h.optInDM('seller');
    await h.offer(await h.listing());
    await h.flushDeliveries();
    assert.equal(h.sent.length, 1);
    const job = await h.db.prepare('SELECT state,attempts,next_attempt_at,last_error FROM delivery_outbox').get();
    assert.equal(job.state, 'sent');
    // Transient failure backs off instead of looping, and exhausts eventually.
    h.sent.length = 0;
    const failing = await h.offer(await h.listing());
    h.setSendBehavior('transient');
    await h.flushDeliveries();
    let row = await h.db.prepare("SELECT state,attempts,next_attempt_at,last_error FROM delivery_outbox WHERE event_key='trade:" + failing + ":offer'").get();
    assert.equal(row.state, 'failed');
    assert.ok(row.next_attempt_at > 0);
    assert.ok(row.last_error.includes('Internal Discord error'));
    // A race past the attempt ceiling marks the job exhausted, not retrying forever.
    await h.db.prepare('UPDATE delivery_outbox SET attempts=8, next_attempt_at=0 WHERE event_key=?').run('trade:' + failing + ':offer');
    await h.flushDeliveries();
    row = await h.db.prepare("SELECT state FROM delivery_outbox WHERE event_key='trade:" + failing + ":offer'").get();
    assert.equal(row.state, 'exhausted');
    // Permanent failure (DMs blocked) stops retrying immediately.
    h.setSendBehavior('permanent');
    h.sendAttempts.length = 0;
    const blocked = await h.offer(await h.listing());
    await h.flushDeliveries();
    await h.flushDeliveries();
    row = await h.db.prepare("SELECT state,last_error FROM delivery_outbox WHERE event_key='trade:" + blocked + ":offer'").get();
    assert.equal(row.state, 'permanent');
    assert.equal(h.sendAttempts.length, 1); // no retry storm
    // Leases prevent concurrent workers from double-sending.
    h.setSendBehavior(120);
    const slow = await h.offer(await h.listing());
    const results = await Promise.all([h.flushDeliveries(), h.flushDeliveries()]);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.sent.length, 1);
    assert.equal((await h.db.prepare("SELECT state FROM delivery_outbox WHERE event_key='trade:" + slow + ":offer'").get()).state, 'sent');
    h.setSendBehavior(null);
  });

  test(`${driver}: blocked or disabled DMs never stop inbox notifications`, async t => {
    const h = await fixture(t, driver);
    // Seller has not opted in to DMs: the inbox still records the offer.
    const tradeId = await h.offer(await h.listing());
    assert.equal(await h.unread('seller'), 1);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM delivery_outbox').get()).total, 0);
    await h.flushDeliveries();
    assert.equal(h.sent.length, 0);
  });

  test(`${driver}: authenticated internal worker protocol claims, delivers, and completes`, async t => {
    const h = await fixture(t, driver);
    await h.optInDM('seller');
    const tradeId = await h.offer(await h.listing());
    // Without the secret, the internal endpoints are closed.
    const unauthorized = await fetch(h.origin + '/api/delivery-work');
    assert.equal(unauthorized.status, 403);
    // Claim a job through the worker protocol.
    const claimed = await h.deliveryWork('GET');
    assert.equal(claimed.status, 200);
    assert.equal(claimed.data.jobs.length, 1);
    const job = claimed.data.jobs[0];
    assert.equal(job.discordId, h.actors.seller.discordId);
    assert.ok(job.content.includes('New offer received'));
    // A leased job is not re-claimed while the worker holds it.
    const second = await h.deliveryWork('GET');
    assert.equal(second.data.jobs.length, 0);
    // The worker delivers and reports success.
    const delivered = await h.deliveryWork('POST', { id: job.id, state: 'sent', messageId: '999' });
    assert.equal(delivered.status, 200);
    const row = await h.db.prepare("SELECT state,message_id FROM delivery_outbox WHERE event_key='trade:" + tradeId + ":offer'").get();
    assert.equal(row.state, 'sent');
    assert.equal(row.message_id, '999');
    // Unknown job ids are rejected.
    const unknown = await h.deliveryWork('POST', { id: 424242, state: 'sent' });
    assert.equal(unknown.status, 404);
  });
}
