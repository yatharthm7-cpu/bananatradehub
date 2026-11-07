// Regression coverage for the hosted initialization failure path: the 503 the
// serverless entry returns must name the failing configuration stage and the
// missing variable names, while never echoing values, URLs, or tokens.
// Every credential-shaped string below is a non-functional test fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const { discordConfigProblems, databaseConfigProblems, sanitizeDetail, initFailure, initFailureBody, initFailureLog } = require('../website/init-errors');
const { openHostedDatabase } = require('../website/db');

// Fixture builders: assembled at runtime so no usable credential literal is
// ever written into the repository. None of these authenticate anywhere.
const fixtureSecret = ['fixture', 'secret', 'not', 'usable'].join('-');
const fixtureToken = ['fixture', 'token', 'not', 'usable'].join('-');
const jwtShaped = 'eyJ' + '0123456789abcdef'.repeat(4);
const longToken = 't'.repeat(48);

const FULL_ENV = {
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: fixtureSecret,
  DISCORD_REDIRECT_URI: 'https://bananatradehub.vercel.app/api/discord/callback',
  GUILD_ID: '1568329619407638668',
  TURSO_DATABASE_URL: 'libsql://example.turso.io',
  TURSO_AUTH_TOKEN: fixtureToken,
};

test('discord config problems name each missing or malformed variable', () => {
  assert.deepEqual(discordConfigProblems(FULL_ENV), []);
  assert.deepEqual(discordConfigProblems({ ...FULL_ENV, GUILD_ID: undefined }), ['GUILD_ID:missing']);
  assert.deepEqual(discordConfigProblems({ ...FULL_ENV, GUILD_ID: 'guild' }), ['GUILD_ID:not_an_id']);
  assert.deepEqual(discordConfigProblems({}), [
    'DISCORD_CLIENT_ID:missing',
    'DISCORD_CLIENT_SECRET:missing',
    'DISCORD_REDIRECT_URI:missing',
    'GUILD_ID:missing',
  ]);
});

test('database config problems report exactly the credentials pair', () => {
  assert.deepEqual(databaseConfigProblems(FULL_ENV), []);
  assert.deepEqual(databaseConfigProblems({ TURSO_DATABASE_URL: 'libsql://x.turso.io' }), ['TURSO_AUTH_TOKEN:missing']);
  assert.deepEqual(databaseConfigProblems({}), ['TURSO_DATABASE_URL:missing', 'TURSO_AUTH_TOKEN:missing']);
});

test('a missing Discord configuration maps to the discord_config stage', () => {
  const body = initFailureBody(new Error('Configure the public HTTPS Discord OAuth callback.'), {});
  assert.equal(body.stage, 'discord_config');
  assert.deepEqual(body.problems, ['DISCORD_CLIENT_ID:missing', 'DISCORD_CLIENT_SECRET:missing', 'DISCORD_REDIRECT_URI:missing', 'GUILD_ID:missing']);
  assert.equal(body.error, 'Marketplace setup is incomplete. Ask the owner to check the hosting configuration.');
});

test('a missing Turso pair maps to the database_config stage with variable names', () => {
  const body = initFailureBody(new Error('Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.'), { TURSO_DATABASE_URL: 'libsql://x.turso.io' });
  assert.equal(body.stage, 'database_config');
  assert.deepEqual(body.problems, ['TURSO_AUTH_TOKEN:missing']);
});

test('database failure stages stay public-safe: no URLs, no tokens', () => {
  const leaked = new Error('fetch failed for libsql://db.turso.io?auth=' + jwtShaped + ' ' + longToken);
  leaked.code = 'HTTP_AUTH_FAILED';
  const body = initFailureBody(leaked, FULL_ENV);
  assert.equal(body.stage, 'database_unreachable');
  assert.equal(body.code, 'HTTP_AUTH_FAILED');
  const json = JSON.stringify(body);
  assert.ok(!json.includes('turso.io'), 'database URL leaked into public body: ' + json);
  assert.ok(!json.includes('eyJ'), 'token-looking content leaked into public body: ' + json);
  assert.ok(!json.includes(longToken), 'token leaked into public body: ' + json);
});

test('the runtime log line carries the stage but never values', () => {
  const log = initFailureLog(new Error('fetch failed for libsql://db.turso.io ' + longToken));
  const parsed = JSON.parse(log);
  assert.equal(parsed.stage, 'database_unreachable');
  assert.ok(!log.includes('turso.io'), 'URL leaked into log line');
});

test('sanitizeDetail reduces connection strings and long tokens', () => {
  assert.equal(sanitizeDetail('GET libsql://db.turso.io failed'), 'GET <url> failed');
  assert.equal(sanitizeDetail('bearer ' + jwtShaped), 'bearer <token>');
});

test('config validation errors from configuredDiscord keep their stage and names', () => {
  const body = initFailureBody(new Error('Set DISCORD_REDIRECT_URI to the website callback URL.'), FULL_ENV);
  assert.equal(body.stage, 'discord_config');
  assert.equal(body.detail, 'Set DISCORD_REDIRECT_URI to the website callback URL.');
});

function fakeClient({ batchError, transactionError }) {
  let batchCalls = 0;
  return {
    batch: async () => { batchCalls += 1; if (batchError) throw batchError; },
    transaction: async () => { if (transactionError) throw transactionError; return { commit: async () => {}, rollback: async () => {}, close: () => {}, closed: false }; },
    close: () => {},
  };
}

test('openHostedDatabase tags transport failures as unreachable', async () => {
  const error = new Error('fetch failed');
  error.code = 'HTTP_AUTH_FAILED';
  await assert.rejects(() => openHostedDatabase({ url: 'libsql://db.turso.io', authToken: fixtureToken, client: fakeClient({ batchError: error }) }), e => e.dbStage === 'database_unreachable');
});

test('openHostedDatabase tags schema failures as a schema stage', async () => {
  const error = new Error('SQLITE_ERROR: no such table');
  error.code = 'SQLITE_ERROR';
  await assert.rejects(() => openHostedDatabase({ url: 'libsql://db.turso.io', authToken: fixtureToken, client: fakeClient({ batchError: error }) }), e => e.dbStage === 'database_schema');
});

test('openHostedDatabase tags migration failures as a schema stage', async () => {
  const error = new Error('SQLITE_ERROR: duplicate column');
  error.code = 'SQLITE_ERROR';
  await assert.rejects(() => openHostedDatabase({ url: 'libsql://db.turso.io', authToken: fixtureToken, client: fakeClient({ transactionError: error }) }), e => e.dbStage === 'database_schema');
});
