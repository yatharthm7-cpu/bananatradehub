// Trade calculator: the ask-math helper converts between a per-unit rate and a
// lot total, computed strictly from the seller's own wording. The barter
// economy has no currency, so the module must stay quiet (return null) whenever
// the wording means nothing computable — never invent a price.
const test = require('node:test');
const assert = require('node:assert/strict');
const askMath = import('../website/frontend/ask-math.js');

test('parseAsk recognizes per-unit wording and keeps the seller noun phrase', async () => {
  const { parseAsk } = await askMath;
  assert.deepEqual(parseAsk('2 netherite ingots each'), { kind: 'each', amount: 2, unit: 'netherite ingots' });
  assert.deepEqual(parseAsk('1.5 diamond blocks per item'), { kind: 'each', amount: 1.5, unit: 'diamond blocks' });
  assert.deepEqual(parseAsk('10 ea'), { kind: 'each', amount: 10, unit: '' });
  assert.deepEqual(parseAsk('200/ea'), { kind: 'each', amount: 200, unit: '' });
});

test('parseAsk recognizes whole-lot wording', async () => {
  const { parseAsk } = await askMath;
  assert.deepEqual(parseAsk('64 coal for the lot'), { kind: 'lot', amount: 64, unit: 'coal' });
  assert.deepEqual(parseAsk('20 diamonds total'), { kind: 'lot', amount: 20, unit: 'diamonds' });
  assert.deepEqual(parseAsk('100 db for all 5'), { kind: 'lot', amount: 100, unit: 'db' });
});

test('parseAsk stays silent on plain barter and unusable input', async () => {
  const { parseAsk } = await askMath;
  assert.equal(parseAsk('a netherite pickaxe'), null, 'no number means nothing to compute');
  assert.equal(parseAsk('2 netherite ingots'), null, 'a bare number without a rate marker is ambiguous');
  assert.equal(parseAsk('0 diamonds each'), null, 'a zero rate is not a trade');
  assert.equal(parseAsk('free, take it'), null);
  assert.equal(parseAsk(''), null);
  assert.equal(parseAsk(null), null);
  assert.equal(parseAsk(undefined), null);
});

test('parseAsk reads grouped thousands as one number', async () => {
  const { parseAsk } = await askMath;
  assert.deepEqual(parseAsk('1,000 coal for the lot'), { kind: 'lot', amount: 1000, unit: 'coal' });
});

test('summarize turns a per-unit rate into the total for the quantity', async () => {
  const { summarize } = await askMath;
  const calc = summarize('2 netherite ingots each', 5);
  assert.equal(calc.total, 10);
  assert.equal(calc.text, '2 netherite ingots each → 10 total');
  assert.equal(summarize('2 netherite ingots each', '5').total, 10, 'form values arrive as strings');
  assert.equal(summarize('1.5 diamond blocks per item', 4).total, 6);
  assert.equal(summarize('2 netherite ingots each', 2500).text, '2 netherite ingots each → 5,000 total');
});

test('summarize turns a lot total into a per-unit rate, exact or flagged', async () => {
  const { summarize } = await askMath;
  const exact = summarize('64 coal for the lot', 4);
  assert.equal(exact.each, 16);
  assert.equal(exact.exact, true);
  assert.equal(exact.text, '64 coal total → 16 each');
  const uneven = summarize('20 diamonds total', 3);
  assert.equal(uneven.exact, false, '6.67 is a rounded display, not an exact rate');
  assert.equal(uneven.text, '20 diamonds total → ≈ 6.67 each');
  const exactDecimal = summarize('10 diamonds for the lot', 8);
  assert.equal(exactDecimal.text, '10 diamonds total → 1.25 each', 'a rate that displays exactly is not marked approximate');
});

test('summarize refuses quantities that cannot support a calculation', async () => {
  const { summarize } = await askMath;
  for (const quantity of [0, -1, 'abc', NaN, 100001, Infinity]) {
    assert.equal(summarize('2 diamonds each', quantity), null, 'quantity ' + quantity + ' must be refused');
  }
});

test('summarize says nothing when the quantity adds no information', async () => {
  const { summarize } = await askMath;
  assert.equal(summarize('2 diamonds each', 1), null, 'a single item total restates the rate');
  assert.equal(summarize('20 diamonds for the lot', 1), null);
  assert.equal(summarize('a netherite pickaxe', 5), null, 'plain barter has nothing to compute');
});
