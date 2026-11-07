// Slash-command response lifecycle: acknowledge once, run, edit the deferred
// response with the result, and never misreport a successful setup as failed
// when the reply delivery breaks (expired token, duplicate process). The
// runtime log lines are sanitized: no tokens, only codes and a correlation ID.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupHandler } = require('../src/setup-command');
const { responseDead } = require('../src/interaction-lifecycle');

function fakeInteraction({ ownerId = 'owner', userId = 'owner', deadEditReplyAt = Infinity, deadCode = 10062, ackFails = null }) {
  const deadError = () => Object.assign(new Error('Unknown interaction'), { code: deadCode });
  let editCalls = 0;
  return {
    commandName: 'setup',
    isChatInputCommand: () => true,
    inGuild: () => true,
    guildId: 'guild',
    user: { id: userId },
    deferred: false,
    repliedIn: false,
    get replied() { return this.repliedIn; },
    options: { getBoolean: () => false },
    client: { guilds: { fetch: async () => ({ ownerId, id: 'guild' }) } },
    repliedTexts: [],
    async deferReply() {
      if (ackFails) throw ackFails;
      this.deferred = true;
    },
    async editReply({ content }) {
      editCalls += 1;
      if (editCalls > deadEditReplyAt) throw deadError();
      this.repliedTexts.push(content);
    },
    async followUp() {
      if (editCalls > deadEditReplyAt) throw deadError();
      this.repliedTexts.push('followUp');
    },
    async reply() { this.repliedIn = true; this.repliedTexts.push('reply'); },
    editCalls: () => editCalls,
  };
}

function collectLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.log = original; } };
}

test('setup succeeds and the finished result edits the deferred response', async () => {
  const interaction = fakeInteraction({});
  let ran = false;
  const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner: async () => { ran = true; return { roles: 14, categories: 6, channels: 21, voiceChannels: 5 }; } });
  await handler(interaction);
  assert.ok(ran, 'runner executed');
  assert.ok(interaction.deferred, 'deferred (acknowledged) before work');
  assert.equal(interaction.repliedTexts.at(-1), 'Setup complete: 14 roles, 6 categories, 16 text channels, and 5 voice rooms. Existing unrelated content was preserved. Discord rules verification is configured. Minecraft IGN ownership is not checked.');
});

test('a successful setup whose reply is dead is not reported as failed', async () => {
  // deadEditReplyAt 0: the runner does not send progress, so the first and
  // only editReply attempt is the completion message — and it is dead.
  const interaction = fakeInteraction({ deadEditReplyAt: 0 });
  const { lines, restore } = collectLogs();
  try {
    const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner: async () => ({ roles: 14, categories: 6, channels: 21, voiceChannels: 5 }) });
    await handler(interaction);
    const combined = lines.join('\n');
    assert.match(combined, /setup-ok/);
    assert.match(combined, /work-ok-reply-failed/);
    assert.ok(!combined.includes('setup-failed'), 'setup must not be misreported as failed');
  } finally { restore(); }
});

test('setup failure surfaces the cause when the response is still available', async () => {
  const interaction = fakeInteraction({});
  const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner: async () => { throw Object.assign(new Error('nope'), { status: 403, code: 50013 }); } });
  await handler(interaction);
  assert.match(interaction.repliedTexts.at(-1), /Discord setup failed \(HTTP 403, code 50013\)/);
});

test('setup failure with a dead response never throws and is logged', async () => {
  const interaction = fakeInteraction({ deadEditReplyAt: 0 });  const { lines, restore } = collectLogs();
  try {
    const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner: async () => { throw Object.assign(new Error('nope'), { status: 403 }); } });
    await handler(interaction);
    const combined = lines.join('\n');
    assert.match(combined, /setup-failed/);
  } finally { restore(); }
});

test('an interaction another process already answered never runs the work', async () => {
  const interaction = fakeInteraction({ ackFails: Object.assign(new Error('Interaction has already been acknowledged.'), { code: 40060 }) });
  const { lines, restore } = collectLogs();
  try {
    let ran = false;
    const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner: async () => { ran = true; return { roles: 1, categories: 1, channels: 1, voiceChannels: 0 }; } });
    await handler(interaction);
    assert.equal(ran, false, 'work must not start when the interaction is dead');
    assert.match(lines.join('\n'), /duplicate-process/);
  } finally { restore(); }
});

test('overlap: a second setup while one is running is refused', async () => {
  const interactionA = fakeInteraction({});
  const interactionB = fakeInteraction({});
  let finish;
  const runner = () => new Promise(resolve => { finish = () => resolve({ roles: 1, categories: 1, channels: 1, voiceChannels: 0 }); });
  const handler = createSetupHandler({ guildId: 'guild', token: 'tok', runner });
  const first = handler(interactionA);
  await handler(interactionB);
  assert.match(interactionB.repliedTexts.at(-1), /Setup is already running/);
  finish();
  await first;
});

test('responseDead classifies dead response errors only', () => {
  assert.ok(responseDead(Object.assign(new Error('x'), { code: 10062 })));
  assert.ok(responseDead(Object.assign(new Error('x'), { code: 40060 })));
  assert.ok(!responseDead(Object.assign(new Error('x'), { code: 50013, status: 403 })));
  assert.ok(!responseDead(new Error('some other failure')));
});
