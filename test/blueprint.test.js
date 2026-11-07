const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { roles, categories, panels, overwrites } = require('../src/blueprint');
const ids = Object.fromEntries(roles.map((r, i) => [r.key, String(i + 10)]));
test('compact scope has no tickets or trade-request channels', () => {
  assert.equal(roles.length, 14);
  assert.equal(categories.flatMap(c => c.channels).length, 21);
  assert.equal(new Set(categories.flatMap(c => c.channels.map(x => x[0]))).size, 21);
  assert.equal(new Set(categories.flatMap(c => [c.key, ...c.channels.map(x => x[0])])).size, 26);
  assert(!JSON.stringify(categories).includes('ticket'));
  for (const c of categories) for (const [, name] of c.channels) assert.match(name, /│[a-z-]+$/u);
});
test('no human role receives administrator and developer has no moderation or role control', () => {
  for (const r of roles) assert.equal(BigInt(r.permissions) & P.Administrator, 0n);
  const developer = BigInt(roles.find(r => r.key === 'developer').permissions);
  assert.equal(developer & (P.ManageRoles | P.ManageGuild | P.BanMembers | P.ModerateMembers), 0n);
});
test('unverified users cannot view hub/staff, post, create threads, or ping everyone', () => {
  for (const c of categories) {
    const all = overwrites('guild', ids, 'bot', c.access, true);
    const everyone = all.find(o => o.id === 'guild');
    for (const flag of [P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads, P.MentionEveryone]) assert(BigInt(everyone.deny) & flag);
    if (c.access !== 'support') assert(BigInt(everyone.deny) & P.SendMessages);
    if (!['public', 'support'].includes(c.access)) assert(BigInt(everyone.deny) & P.ViewChannel);
    if (c.access === 'staff') assert(!all.some(o => [ids.verified, ids.middleman].includes(o.id)));
  }
});
test('newcomers can ask for support while voice remains verified and staff voice private', () => {
  const help = overwrites('guild', ids, 'bot', 'support', true).find(o => o.id === 'guild');
  assert(BigInt(help.allow) & P.SendMessages);
  assert(BigInt(help.deny) & P.AttachFiles);
  const voice = overwrites('guild', ids, 'bot', 'verified', true, true);
  assert(BigInt(voice.find(o => o.id === ids.verified).allow) & P.Connect);
  assert(BigInt(voice.find(o => o.id === 'guild').deny) & P.Connect);
  assert(!overwrites('guild', ids, 'bot', 'staff', true, true).some(o => o.id === ids.verified));
});
test('members can discuss but cannot publish official notices or create trade threads', () => {
  for (const writable of [true, false]) {
    const member = overwrites('guild', ids, 'bot', 'verified', writable).find(o => o.id === ids.verified);
    assert.equal(Boolean(BigInt(member.allow) & P.SendMessages), writable);
    assert(BigInt(member.deny) & P.CreatePublicThreads);
  }
});
test('verification panel never claims game verification is implemented', () => {
  assert.match(panels.verify[1], /does not verify your email, phone, identity, or Minecraft account/);
  assert.match(panels.verify[1], /IGN during a trade is self-reported/);
});

