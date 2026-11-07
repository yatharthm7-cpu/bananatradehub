// Client-side boundary helpers: the request-body shape guard that stops a
// React event or DOM node from being serialized as JSON request data, plus the
// Phase 2 action classifiers. The module is an ES module (bundled by esbuild),
// so each test resolves it through a dynamic import.
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../website/frontend/route-helpers.js');

test('plainObject accepts only JSON-safe object literals', async () => {
  const { plainObject } = await helpers;
  assert.equal(plainObject({}), true);
  assert.equal(plainObject({ accepted: true, rulesVersion: 1 }), true);
  assert.equal(plainObject({ nested: { a: [1, 'two', null] } }), true);
});

test('plainObject rejects the values that caused circular serialization', async () => {
  const { plainObject } = await helpers;
  assert.equal(plainObject(null), false);
  assert.equal(plainObject(undefined), false);
  assert.equal(plainObject('accepted'), false);
  assert.equal(plainObject(42), false);
  assert.equal(plainObject([]), false);
  assert.equal(plainObject(new Map([['accepted', 'true']])), false);
  // A React SyntheticEvent stand-in: a non-literal prototype and a DOM target.
  class SyntheticEvent { constructor(target) { this.type = 'click'; this.target = target; } }
  class HTMLSpanElement { constructor() { this.__reactFiber = { stateNode: null }; } }
  const span = new HTMLSpanElement();
  span.__reactFiber.stateNode = span; // closes the circle, exactly like the bug
  assert.equal(plainObject(new SyntheticEvent(span)), false);
  assert.equal(plainObject(span), false);
});

test('plainObject still accepts objects built from entries', async () => {
  const { plainObject } = await helpers;
  assert.equal(plainObject(Object.fromEntries([['accepted', true]])), true);
});

test('action classifiers extract the intended ids and decisions', async () => {
  const { matchReceipt, matchArrangement, matchArrangementAck, matchCancellation } = await helpers;
  assert.equal(matchReceipt('receipt:7'), '7');
  assert.equal(matchReceipt('receipt'), null);
  assert.equal(matchArrangement('arrangement:3'), '3');
  assert.equal(matchArrangementAck('arrangement-ack:3'), '3');
  assert.deepEqual(matchCancellation('cancel-request:9'), ['9', undefined]);
  assert.deepEqual(matchCancellation('cancel-request:9:agree'), ['9', 'agree']);
  assert.equal(matchCancellation('other:9'), null);
});
