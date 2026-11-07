const test = require('node:test');
const assert = require('node:assert/strict');
const { configureApplicationEmojis, emoji, emojiDefaults } = require('../src/emojis');
test('provided catalog resolves exact names and aliases only from returned application emoji', () => {
  configureApplicationEmojis([
    { id: '100000000000000010', name: 'wave2', animated: true },
    { id: '100000000000000011', name: 'shield' },
    { id: '100000000000000012', name: 'codex_warn', available: false },
    { id: 'invalid', name: 'lock' },
  ]);
  assert.equal(emoji('wave'), '<a:wave2:100000000000000010>');
  assert.equal(emoji('shield'), '<:shield:100000000000000011>');
  assert.equal(emoji('warning'), emojiDefaults.warning);
  assert.equal(emoji('lock'), emojiDefaults.lock);
  configureApplicationEmojis([]);
  assert.equal(emoji('wave'), emojiDefaults.wave);
  assert.equal(emoji('shield'), emojiDefaults.shield);
});
