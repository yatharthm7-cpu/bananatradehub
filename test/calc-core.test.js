// Trade calculator core: quantity math, verdicts, share links, and history.
// Every rule the spec demands lives here: stacking, totals, the Win/Fair/Lose
// tolerance band, no verdict on unpriced items or empty sides, validated share
// links, and capped/expiring history.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = import('../website/frontend/calc-core.js');

// A miniature catalog mirroring the payload shape of /api/catalog: priced
// items, one explicitly unpriced item, and one never-set item (no row).
const ITEMS = [
  { id: 'elytra', name: 'Elytra', value: 32, priced: true },
  { id: 'nether-star', name: 'Nether star', value: 8, priced: true },
  { id: 'enchanted-golden-apple', name: 'Enchanted golden apple', value: 4, priced: true },
  { id: 'dragon-egg', name: 'Dragon egg', value: 64, priced: true },
  { id: 'heavy-core', name: 'Heavy core', value: null, priced: false },
  { id: 'rare-enchanted-gear', name: 'Rare enchanted gear', value: null, priced: false },
];

test('stackEntries stacks repeats and clamps quantities', async () => {
  const { stackEntries, clampQuantity } = await core;
  let give = stackEntries([], 'elytra');
  give = stackEntries(give, 'elytra');
  give = stackEntries(give, 'elytra', 5);
  assert.equal(give.length, 1, 'the same item appears once with a stacked quantity');
  assert.equal(give[0].qty, 7);
  assert.equal(stackEntries(give, 'nether-star').length, 2, 'a different item gets its own card');
  assert.equal(clampQuantity('abc'), 1, 'a non-numeric quantity falls back to 1');
  assert.equal(clampQuantity(0), 1);
  assert.equal(clampQuantity(99999), 10000, 'quantities clamp to the maximum');
});

test('setEntryQuantity and removeEntry keep sides consistent', async () => {
  const { stackEntries, setEntryQuantity, removeEntry } = await core;
  const give = stackEntries(stackEntries([], 'elytra', 2), 'nether-star', 3);
  assert.deepEqual(setEntryQuantity(give, 'elytra', 5).map(entry => [entry.itemId, entry.qty]), [['elytra', 5], ['nether-star', 3]]);
  assert.deepEqual(removeEntry(give, 'elytra').map(entry => entry.itemId), ['nether-star']);
  assert.deepEqual(removeEntry(give, 'missing'), give, 'removing a non-entry is a no-op');
});

test('summarize totals values and quantities and names unpriced items', async () => {
  const { summarize, stackEntries } = await core;
  const give = stackEntries(stackEntries([], 'elytra', 2), 'heavy-core', 3);
  const summary = summarize(give, ITEMS);
  assert.equal(summary.value, 64, 'only priced items count toward the value');
  assert.equal(summary.quantity, 5, 'every item counts toward the quantity');
  assert.deepEqual(summary.unpricedNames, ['Heavy core']);
});

test('compareTrade labels Win, Fair, and Lose around the tolerance band', async () => {
  const { compareTrade, stackEntries } = await core;
  const side = ids => ids.reduce((acc, [id, qty]) => stackEntries(acc, id, qty), []);
  // get is 10% above give: a win at the default 5% tolerance.
  let outcome = compareTrade({ give: side([['nether-star', 10]]), get: side([['enchanted-golden-apple', 22]]), items: ITEMS });
  assert.equal(outcome.verdict, 'win');
  assert.equal(outcome.percentage, 10);
  assert.equal(outcome.incomplete, false);
  assert.equal(outcome.difference, 8);
  // Within the band is Fair.
  outcome = compareTrade({ give: side([['nether-star', 10]]), get: side([['enchanted-golden-apple', 20]]), items: ITEMS });
  assert.equal(outcome.verdict, 'fair', 'equal totals are fair by definition');
  assert.equal(outcome.difference, 0);
  // Below the band is a loss.
  outcome = compareTrade({ give: side([['nether-star', 10]]), get: side([['enchanted-golden-apple', 10]]), items: ITEMS });
  assert.equal(outcome.verdict, 'lose');
  assert.equal(outcome.percentage, -50);
  // A wider tolerance turns the same loss into a fair trade.
  outcome = compareTrade({ give: side([['nether-star', 10]]), get: side([['enchanted-golden-apple', 10]]), items: ITEMS, tolerance: 60 });
  assert.equal(outcome.verdict, 'fair');
  assert.equal(outcome.tolerance, 50, 'tolerance clamps to the configured maximum');
});

test('compareTrade withholds verdicts instead of misleading', async () => {
  const { compareTrade, stackEntries } = await core;
  const side = ids => ids.reduce((acc, [id, qty]) => stackEntries(acc, id, qty), []);
  let outcome = compareTrade({ give: [], get: side([['elytra', 1]]), items: ITEMS });
  assert.equal(outcome.verdict, null, 'an empty side yields no verdict');
  assert.match(outcome.reason, /both sides/);
  outcome = compareTrade({ give: side([['nether-star', 2]]), get: side([['enchanted-golden-apple', 4]]), items: ITEMS, tolerance: 'junk' });
  assert.equal(outcome.verdict, 'fair', 'a non-numeric tolerance falls back to the default; equal totals stay fair');
  // Unpriced items on either side withhold the verdict with the names shown.
  outcome = compareTrade({ give: side([['elytra', 1]]), get: side([['heavy-core', 1]]), items: ITEMS });
  assert.equal(outcome.verdict, null);
  assert.match(outcome.reason, /Heavy core/);
  assert.match(outcome.reason, /withheld/);
  // No division by zero when the give side total is somehow zero.
  outcome = compareTrade({ give: side([['heavy-core', 2]]), get: side([['nether-star', 1]]), items: [] });
  assert.equal(outcome.verdict, null, 'an empty catalog cannot price anything');
  assert.equal(outcome.incomplete, true);
});

test('formatValue renders singular and plural units', async () => {
  const { formatValue } = await core;
  assert.equal(formatValue(1, 'diamonds'), '1 diamond');
  assert.equal(formatValue(8, 'diamonds'), '8 diamonds');
  assert.equal(formatValue(2.5, 'diamonds'), '2.5 diamonds');
  assert.equal(formatValue(0, 'diamonds'), '0 diamonds');
});

test('share links round-trip and reject invalid input', async () => {
  const { buildShareQuery, parseShareQuery, stackEntries } = await core;
  const side = ids => ids.reduce((acc, [id, qty]) => stackEntries(acc, id, qty), []);
  const give = side([['elytra', 2], ['nether-star', 3]]);
  const get = side([['dragon-egg', 1]]);
  const query = buildShareQuery(give, get);
  assert.equal(query, 'give=elytra:2,nether-star:3&get=dragon-egg:1');
  const restored = parseShareQuery(query, ITEMS);
  assert.deepEqual(restored.give, give);
  assert.deepEqual(restored.get, get);
  assert.equal(restored.dropped.give, 0);
  // Unknown item and bad quantities are dropped, not crashed on.
  const dodgy = parseShareQuery('give=does-not-exist:2,elytra:0&get=elytra:abc,nether-star:-5', ITEMS);
  assert.deepEqual(dodgy.give, []);
  assert.deepEqual(dodgy.get, [], 'a non-numeric quantity and a negative quantity are rejected, not clamped into the trade');
  assert.equal(dodgy.dropped.give, 2, 'the unknown item and zero quantity are counted as invalid');
  assert.equal(dodgy.dropped.get, 2);
  // A valid link with a huge quantity clamps instead of overflowing the trade.
  assert.equal(parseShareQuery('give=elytra:99999', ITEMS).give[0].qty, 10000);
  // A link that repeats an item stacks onto a single entry.
  assert.deepEqual(parseShareQuery('give=elytra:2,elytra:3', ITEMS).give, [['elytra', 5]].map(([itemId, qty]) => ({ itemId, qty })));
});

test('history is capped at 30 entries and expires after 30 days', async () => {
  const { pruneHistory, makeHistoryEntry, HISTORY_LIMIT, HISTORY_TTL_MS } = await core;
  const now = Date.now();
  const entries = [];
  for (let index = 0; index < 40; index += 1) {
    entries.push({ ...makeHistoryEntry({ give: [], get: [], outcome: { difference: 0, percentage: 0, verdict: null }, unit: 'diamonds' }), at: now - index * 1000 });
  }
  const pruned = pruneHistory(entries, now);
  assert.equal(pruned.length, HISTORY_LIMIT, 'only the newest entries survive the cap');
  const expired = pruneHistory(entries, now + HISTORY_TTL_MS + 1);
  assert.equal(expired.length, 0, 'entries older than 30 days expire');
  const malformed = pruneHistory([{ at: 'when' }, null, { at: now }]);
  assert.equal(malformed.length, 1, 'malformed entries are dropped, not fatal');
  const empty = pruneHistory(undefined, now);
  assert.equal(empty.length, 0);
});
