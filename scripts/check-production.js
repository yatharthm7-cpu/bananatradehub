// One-command production health check: triggers the ops sweep (cron-secret
// protected, the same authorized trigger documented in
// docs/VERIFICATION-RECOVERY.md) and turns the consolidated roll-up into a
// clear per-section PASS/FAIL report. Exits non-zero on any failure, so it
// composes with scripts, CI, and monitoring.
//
//   node scripts/check-production.js                     # WEBSITE_URL from .env
//   node scripts/check-production.js --base https://bananatradehub.vercel.app
//   node scripts/check-production.js --json              # raw roll-up
//
// Requires CRON_SECRET in .env (or the environment) and curl on PATH (Windows
// 10+, macOS, and most Linux distributions ship it). The secret never appears
// on the command line or in the process list: it reaches curl as config text
// on stdin, and the request URL is allowlisted before anything runs. Prints
// only non-secret facts: deploy SHA, table counts, channel/role names and
// snowflake IDs, timestamps, and error classes.
require('dotenv').config({ quiet: true });
const { execFileSync } = require('node:child_process');
const { CRON_STALE_AFTER } = require('../website/ops-health');

const DEFAULT_BASE = 'https://bananatradehub.vercel.app';
const SWEEP_PATH = '/api/delivery-retry?stats=1';
const SWEEP_LAG_LIMIT = 2 * 3600;

// The sweep target may only ever be the documented production deployment or a
// loopback preview, and never an internal address, so the script is a client
// of the one deployment it checks — never a relay into a private network.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const INTERNAL_HOST_PREFIXES = [
  '10.', '192.168.', '169.254.',
  '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  'fc', 'fd', // IPv6 unique-local address literals
];
function resolveTarget(base) {
  let url;
  try { url = new URL(base); } catch { throw new TypeError('Not a valid URL: ' + base); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname === '[::1]';
  if (url.username || url.password) throw new RangeError('Refusing a URL with embedded credentials.');
  if (!loopback && INTERNAL_HOST_PREFIXES.some(prefix => url.hostname.startsWith(prefix))) {
    throw new RangeError('Refusing to probe an internal address: ' + url.hostname);
  }
  if (url.hostname.indexOf('.') < 0 && !loopback) {
    throw new RangeError('Refusing a non-qualified hostname: ' + url.hostname);
  }
  if (url.protocol === 'https:') return new URL(SWEEP_PATH, url).href;
  if (url.protocol === 'http:' && loopback) return new URL(SWEEP_PATH, url).href;
  throw new RangeError('Only https:// URLs, or http:// on 127.0.0.1/localhost, are probed. Got: ' + url.protocol + '//' + url.hostname);
}

function parseArgs(argv) {
  const args = { base: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') args.base = argv[index + 1] || null;
    if (arg === '--json') args.json = true;
  }
  return args;
}

function age(at, now = Math.floor(Date.now() / 1000)) {
  if (at === null || at === undefined) return 'never';
  const seconds = Math.max(0, now - at);
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  return Math.floor(seconds / 3600) + 'h ago';
}

function report(body, { generatedAt = Math.floor(Date.now() / 1000) } = {}) {
  const failures = [];
  const warnings = [];
  const lines = [];
  const ok = line => lines.push('  PASS ' + line);
  const fail = line => { failures.push(line); lines.push('  FAIL ' + line); };
  const warn = line => { warnings.push(line); lines.push('  WARN ' + line); };
  const section = name => lines.push('\n' + name);

  if (!body || body.ok !== true) fail('sweep did not report ok');
  const health = body.lookup?.health;
  if (!health) {
    fail('the roll-up is missing from the response (older deployment?)');
    return { lines, failures, warnings, exitCode: 1 };
  }

  section('Deployment');
  ok('deploy SHA ' + (health.deploySha || 'unknown (local/preview run)'));
  ok('roll-up built on this sweep');

  section('Database');
  if (health.database?.reachable) {
    const counts = health.database.counts || {};
    ok('reachable — ' + (Object.entries(counts).map(([table, total]) => table + ':' + total).join(' ') || 'no counts'));
    if (counts.oauthStates > 0) ok('oauth_states probe rows present (write path shares this database)');
  } else {
    fail('not reachable — ' + (health.database?.errorClass || 'unknown') + ': ' + (health.database?.message || 'no detail'));
  }

  section('Discord configuration');
  if (health.auditChannel?.checked) {
    if (health.auditChannel.validated) ok('audit channel #' + health.auditChannel.name + ' (' + health.auditChannel.id + ') in this guild');
    else fail('DISCORD_VERIFICATION_LOG_CHANNEL_ID ' + (health.auditChannel.id || '(unset)') + ' is not a reachable text channel in this guild');
  } else warn('audit channel not checked (bot token missing?)');
  if (health.verifiedRole?.checked) {
    const role = health.verifiedRole;
    if (role.present === false) fail('Verified role ' + role.id + ' does not exist in the guild');
    else if (role.managed) fail('Verified role ' + role.name + ' is bot-managed and cannot be granted');
    else if (role.botCanGrant !== true) fail('bot cannot grant ' + role.name + ' (position ' + role.position + ' vs bot highest ' + health.bot?.highestRolePosition + ')');
    else ok('Verified role ' + role.name + ' (' + role.id + ', position ' + role.position + ') — bot can grant');
  } else warn('Verified role not checked');

  section('Heartbeats');
  const heartbeat = health.heartbeat || {};
  ok('cron heartbeat: ' + age(heartbeat.cronHeartbeat) + ' (refreshed by this check)');
  if (heartbeat.cronHeartbeat === null) fail('no cron heartbeat was recorded by this fire');
  if (heartbeat.lastSweep === null) fail('last_sweep is missing — reconcileStuck has never completed on a sweep (Discord unconfigured or failing?)');
  else if (heartbeat.cronHeartbeat !== null && heartbeat.cronHeartbeat - heartbeat.lastSweep > SWEEP_LAG_LIMIT) {
    fail('cron fired ' + age(heartbeat.cronHeartbeat) + ' but the last completed sweep is ' + age(heartbeat.lastSweep) + ' — sweeps keep failing');
  } else ok('last sweep completed ' + age(heartbeat.lastSweep));
  if (heartbeat.cronHeartbeat !== null && generatedAt - heartbeat.cronHeartbeat > CRON_STALE_AFTER) {
    warn('cron heartbeat is ' + age(heartbeat.cronHeartbeat) + ' — older than ' + (CRON_STALE_AFTER / 3600) + 'h means no unattended fire happened before this check');
  }

  section('Config-drift canary');
  const drift = body.drift || health.drift || [];
  if (!drift.length) ok('no drift: role and audit channel match the live guild');
  for (const warning of drift) {
    fail(warning.code + ': ' + warning.detail + ' -> ' + warning.fix);
  }
  if (body.driftNotice && body.driftNotice !== 'none') ok('operator notice: ' + body.driftNotice);

  if (body.reconciliation?.error) warn('reconciliation reported an error: ' + body.reconciliation.error);
  if (body.reconciliation) ok('reconciliation: attempted ' + body.reconciliation.attempted + ', completed ' + body.reconciliation.completed + ', granted ' + body.reconciliation.granted + ', skipped ' + body.reconciliation.skipped);

  return { lines, failures, warnings, exitCode: failures.length ? 1 : 0 };
}

module.exports = { report, parseArgs, resolveTarget, age, SWEEP_LAG_LIMIT, sweep };

// Performs the sweep request through curl. Nothing dynamic ever reaches argv:
// static flags only, the Authorization header arrives as config text on stdin
// (-K -), and the allowlisted URL follows curl's end-of-options '--'. The HTTP
// status comes back on the trailing line of the body (-w '\n%{http_code}').
function sweep(target, secret) {
  const config = 'header = "Authorization: Bearer ' + secret + '"\nmax-time = "30"\nsilent\nshow-error\n';
  const stdout = execFileSync('curl', ['-K', '-', '-w', '\n%{http_code}', '--', target], {
    input: config, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const split = stdout.lastIndexOf('\n');
  return { status: Number(stdout.slice(split + 1)), body: split < 0 ? '' : stdout.slice(0, split) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || process.env.WEBSITE_URL || DEFAULT_BASE;
  let target;
  try { target = resolveTarget(base); }
  catch (error) { console.error(String(error.message || error)); process.exitCode = 2; return; }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('CRON_SECRET is not set. Put it in .env or the environment (never paste it into chat).');
    process.exitCode = 2;
    return;
  }
  let body = null;
  try {
    const response = sweep(target, secret);
    if (response.status === 0) {
      console.error('Could not reach the sweep route (curl failed before a response).');
      process.exitCode = 1;
      return;
    }
    if (response.status !== 200) {
      console.error('Sweep request failed: HTTP ' + response.status + (response.status === 503 ? ' — the app reports it cannot start (read its init error body)' : ''));
      process.exitCode = 1;
      return;
    }
    body = JSON.parse(response.body);
  } catch (error) {
    console.error('Could not read the sweep response: ' + String(error.message || error).slice(0, 160));
    process.exitCode = 1;
    return;
  }
  if (args.json) { console.log(JSON.stringify(body, null, 2)); return; }
  const outcome = report(body || {}, { generatedAt: Math.floor(Date.now() / 1000) });
  console.log('Production check — ' + base);
  console.log(outcome.lines.join('\n'));
  console.log('\n' + (outcome.failures.length ? 'FAIL' : 'PASS') + ': ' + outcome.failures.length + ' failure(s), ' + outcome.warnings.length + ' warning(s)');
  process.exitCode = outcome.exitCode;
}

if (require.main === module) main();
