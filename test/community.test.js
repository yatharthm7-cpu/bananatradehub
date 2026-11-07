const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Community, verificationProblem, pollAnswers, inviteAttribution, pickWinners } = require('../src/community');
const { Store } = require('../src/storage');
const { brandedContainer, brandedEmbed, verificationComponents, welcomeMessage, welcomeComponents, greeting, panelLayout } = require('../src/presentation');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.test-setup-community-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'data'));
  for (const asset of ['BananaSMP_Icon.png', 'BananaSMP_Banner.png']) fs.copyFileSync(path.join(__dirname, '..', 'assets', asset), path.join(root, 'assets', asset));
  const state = { guildId: 'guild', botId: 'bot', roles: { verified: 'verified', developer: 'dev', moderator: 'mod' }, channels: { welcome: 'welcome', verify: 'verify' }, messages: { verify: 'verify-panel' } };
  fs.writeFileSync(path.join(root, 'data', 'guild-guild.json'), JSON.stringify(state));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = { user: { id: 'bot' }, guilds: { fetch: async () => ({}) } };
  return { root, state, client, c: new Community({ client, root, guildId: 'guild' }) };
}
function member(id = 'member') {
  return { id, user: { id, username: 'Test', createdTimestamp: Date.now() - 48 * 3600000, bot: false }, joinedTimestamp: Date.now() - 20 * 60000, pending: false, roles: { cache: new Set(['verified']) } };
}
test('verification gates account age, membership age, screening, bots, and timeouts', () => {
  const m = member(); assert.equal(verificationProblem(m), null);
  assert.match(verificationProblem({ ...m, user: { ...m.user, createdTimestamp: Date.now() } }), /24 hours/);
  assert.match(verificationProblem({ ...m, joinedTimestamp: Date.now() }), /10 minutes/);
  assert.match(verificationProblem({ ...m, pending: true }), /screening/);
  assert.match(verificationProblem({ ...m, user: { ...m.user, bot: true } }), /Bots/);
  assert.match(verificationProblem({ ...m, communicationDisabledUntilTimestamp: Date.now() + 10000 }), /timed out/);
});
test('verify is website-only: it redirects and never grants the role', async t => {
  const { c, state } = fixture(t);
  const m = member(); m.roles.cache.clear(); let adds = 0;
  m.roles.add = async role => { adds++; m.roles.cache.add(role.id); };
  const i = { isButton: () => false };
  process.env.WEBSITE_URL = 'https://hub.example.test';
  t.after(() => { delete process.env.WEBSITE_URL; });
  assert.match(await c.verify(i, state, m), /Sign in with Discord/i);
  assert.match(await c.verify(i, state, m), /#verify/);
  assert.equal(c.store.data.verified.member, undefined);
  assert.equal(adds, 0);
  // An eligible member who has already accepted is still sent to the website.
  assert.doesNotMatch(await c.verify(i, state, m), /already have/);
  await assert.rejects(c.verify({ isButton: () => true, message: { id: 'old-panel' } }, state, m), /outdated/);
});
test('verify explains the waiting requirement before redirecting', async t => {
  const { c, state } = fixture(t);
  process.env.WEBSITE_URL = 'https://hub.example.test';
  t.after(() => { delete process.env.WEBSITE_URL; });
  const fresh = member(); fresh.user.createdTimestamp = Date.now();
  assert.match(await c.verify({ isButton: () => false }, state, fresh), /24 hours/);
  assert.match(await c.verify({ isButton: () => false }, state, fresh), /#verify/);
});
test('verify fails closed when the website is not configured', async t => {
  const { c, state } = fixture(t);
  const i = { isButton: () => false };
  await assert.rejects(c.verify(i, state, member()), /WEBSITE_URL/);
});
test('invite attribution never fabricates unknown, ambiguous, or historical invite credit', () => {
  const item = uses => ({ uses, inviterId: 'host' });
  assert.equal(inviteAttribution({ a: item(1) }, { a: item(2) }), 'host');
  assert.equal(inviteAttribution(null, { a: item(2) }), null);
  assert.equal(inviteAttribution({}, { a: item(1) }), null);
  assert.equal(inviteAttribution({ a: item(1) }, { a: item(3) }), null);
  assert.equal(inviteAttribution({ a: item(1), b: item(1) }, { a: item(2), b: item(2) }), null);
});
test('invite tracking deduplicates joins and preserves one referral on rejoin', async t => {
  const { c } = fixture(t); let uses = 0;
  c.store.data.greet.enabled = false;
  c.store.data.inviteSnapshot = { a: { uses: 0, inviterId: 'host' } };
  c.invitesSnapshot = async () => ({ a: { uses, inviterId: 'host' } });
  const m = member(); m.guild = { id: 'guild' };
  uses = 1; await c.onJoin(m); await c.onJoin(m);
  assert.equal(Object.keys(c.store.data.inviteMembers).length, 1);
  assert.equal(c.store.data.inviteMembers.member.inviterId, 'host');
  await c.onLeave(m); assert.equal(c.store.data.inviteMembers.member.active, false);
  uses = 2; m.joinedTimestamp++; await c.onJoin(m);
  assert.equal(c.store.data.inviteMembers.member.rejoined, true);
  assert.equal(c.store.data.inviteMembers.member.inviterId, 'host');
});
test('giveaway entries are unique and reject host, bots, and unverified members', async t => {
  const { c, state } = fixture(t);
  c.store.data.giveaways.g = { status: 'running', endsAt: Date.now() + 100000, hostId: 'host', entrants: [] };
  const i = { message: { id: 'g' } };
  assert.match(await c.enter(i, state, member()), /entered!/);
  assert.match(await c.enter(i, state, member()), /already entered/);
  assert.match(await c.enter(i, state, member('host')), /cannot enter/);
  const unverified = member('outsider'); unverified.roles.cache.clear();
  assert.match(await c.enter(i, state, unverified), /need Verified/);
  assert.deepEqual(c.store.data.giveaways.g.entrants, ['member']);
});
test('giveaway draws persist before delivery, recover without redrawing, and reroll excludes past winners', async t => {
  const { c, client, root } = fixture(t);
  c.store.data.giveaways.g = { status: 'running', endsAt: 0, channelId: 'channel', hostId: 'host', prize: 'Test prize', count: 1, entrants: ['one', 'two', 'left'], winners: [], previousWinners: [] };
  client.guilds.fetch = async () => ({ members: { fetch: async ({ user }) => { if (user === 'left') throw Object.assign(new Error('left'), { code: 10007 }); return member(user); } } });
  let failDelivery = true;
  client.channels = { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => { if (failDelivery) throw new Error('offline'); } }) } }) };
  await assert.rejects(c.draw('g'), /offline/);
  const stored = new Store(root, 'guild'); const first = [...stored.data.giveaways.g.winners];
  assert.equal(stored.data.giveaways.g.status, 'ended');
  assert.equal(stored.data.giveaways.g.deliveryPending, true);
  c.store = stored; failDelivery = false;
  await c.tick(); assert.deepEqual(c.store.data.giveaways.g.winners, first);
  assert.equal(c.store.data.giveaways.g.deliveryPending, false);
  await c.draw('g', true);
  assert(!c.store.data.giveaways.g.winners.includes(first[0]));
  assert(!c.store.data.giveaways.g.winners.includes('left'));
});
test('poll validation and random draw enforce distinct choices and unique winners', () => {
  assert.equal(pollAnswers('Yes | No').length, 2);
  for (const value of ['only one', 'yes|YES', 'a||b', `a|${'x'.repeat(56)}`]) assert.throws(() => pollAnswers(value));
  assert.deepEqual(pickWinners(['one', 'one', 'two'], 10, () => 0), ['one', 'two']);
});
test('branded embeds, V2 containers, and greetings use assets without enabling mass mentions', t => {
  const { root } = fixture(t);
  const embed = brandedEmbed(root, 'Title', 'Body', { banner: true });
  assert.equal(embed.files.length, 2);
  assert.equal(embed.embeds[0].author.icon_url, 'attachment://banana-logo.png');
  assert(!embed.embeds[0].thumbnail);
  const container = brandedContainer(root, 'Title', 'Body', { banner: true });
  assert.equal(container.flags, 32768);
  assert.equal(container.components[0].type, 17);
  assert(!container.embeds); assert(!container.content);
  assert.deepEqual(container.allowedMentions.parse, []);
  // Website-only verification: no Discord button exists to press anymore.
  assert.deepEqual(verificationComponents(), []);
  const m = member(); m.guild = { name: 'BananaSMP', memberCount: 50 };
  assert.equal(greeting('Hi {user}, {server} #{count}', m), 'Hi <@member>, BananaSMP #50');
});
test('compact verification has side-by-side fields and no default tall image', t => {
  const { root } = fixture(t);
  const layout = panelLayout('verify', 'Verify', 'old copy');
  const payload = brandedEmbed(root, layout.title, layout.description, { fields: layout.fields });
  assert(layout.description.length < 250);
  assert.equal(payload.embeds[0].fields[0].inline, true);
  assert.equal(payload.embeds[0].fields[1].inline, true);
  assert(!payload.embeds[0].image);
  assert(!payload.embeds[0].thumbnail);
  assert.match(payload.embeds[0].fields[2].value, /IGN is self-reported/);
  assert.equal(brandedEmbed(root, 'Test', '### Heading').embeds[0].description, '**Heading**');
});
test('welcome routes to the website verification page, never to a Discord channel', t => {
  const { root, state } = fixture(t);
  state.channels.rules = 'rules';
  const m = member();
  m.guild = { id: 'guild', name: 'BananaSMP', memberCount: 52 };
  m.user.displayAvatarURL = () => 'https://cdn.discordapp.com/embed/avatars/0.png';
  const payload = welcomeMessage(root, m, state, { inviterId: 'inviter' });
  assert.match(payload.embeds[0].description, /member \*\*#52\*\*/);
  assert.match(payload.embeds[0].description, /<@inviter> \(tracked\)/);
  assert.match(payload.embeds[0].fields[0].value, /1\. Read <#rules>/);
  assert.equal(payload.embeds[0].thumbnail.url, m.user.displayAvatarURL());
  state.websiteUrl = 'https://hub.example.test/';
  const linked = welcomeMessage(root, m, state, { inviterId: 'inviter' });
  assert.equal(linked.components[0].components[0].url, 'https://hub.example.test/#verify');
  assert.equal(linked.components[0].components[0].label, 'Sign in with Discord');
  assert.equal(linked.components[0].components[0].style, 5);
  assert.match(welcomeMessage(root, m, state).embeds[0].description, /Unknown \/ not tracked/);
  assert.deepEqual(welcomeComponents(undefined), []);
  assert.match(linked.embeds[0].fields[0].value, /hub\.example\.test\/#verify/);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['member'] });
});
test('ordinary members cannot publish embeds, containers, giveaways, or change greetings', async t => {
  const { c, client } = fixture(t);
  client.guilds.fetch = async () => ({ ownerId: 'owner', members: { fetch: async () => member() } });
  for (const name of ['embed', 'container', 'giveaway', 'greet', 'poll', 'bot-status']) {
    let answer;
    await c.handle({ commandName: name, guildId: 'guild', user: { id: 'member' }, isButton: () => false, isChatInputCommand: () => true, inGuild: () => true, deferReply: async () => {}, editReply: async payload => { answer = payload.content; } });
    assert.match(answer, /Only Owner, Developer, or Moderator/);
  }
});
