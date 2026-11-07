// Shared initialization diagnostics for the hosted (Vercel) website.
// The serverless entry must convert a failed startup into a 503 whose body
// tells the operator WHICH configuration stage failed, without ever echoing
// values, URLs, or credentials. Environment-variable names are configuration
// surface (they appear in .env.example and docs); their values are not.
// Test coverage lives in test/init-failure.test.js.

const ID = value => /^\d{17,20}$/.test(value || '');

function discordConfigProblems(env = process.env) {
  const problems = [];
  if (!env.DISCORD_CLIENT_ID) problems.push('DISCORD_CLIENT_ID:missing');
  else if (!ID(env.DISCORD_CLIENT_ID)) problems.push('DISCORD_CLIENT_ID:not_an_id');
  if (!env.DISCORD_CLIENT_SECRET) problems.push('DISCORD_CLIENT_SECRET:missing');
  if (!env.DISCORD_REDIRECT_URI) problems.push('DISCORD_REDIRECT_URI:missing');
  if (!env.GUILD_ID) problems.push('GUILD_ID:missing');
  else if (!ID(env.GUILD_ID)) problems.push('GUILD_ID:not_an_id');
  return problems;
}

function databaseConfigProblems(env = process.env) {
  const problems = [];
  if (!env.TURSO_DATABASE_URL) problems.push('TURSO_DATABASE_URL:missing');
  if (!env.TURSO_AUTH_TOKEN) problems.push('TURSO_AUTH_TOKEN:missing');
  return problems;
}

// Keep any error message safe for a public response: connection strings and
// bearer tokens can appear inside libsql network failures, so they are reduced
// to a placeholder before the message leaves the server.
function sanitizeDetail(text) {
  return String(text || '')
    .replace(/(?:libsql|wss|ws|https?):\/\/[^\s'"<>]+/gi, '<url>')
    .replace(/eyJ[A-Za-z0-9_.\-]{10,}/g, '<token>')
    .replace(/[A-Za-z0-9_\-]{40,}/g, '<token>')
    .trim()
    .slice(0, 300);
}

// Error shape produced by website/db.js (dbStage) plus libsql error codes.
const TRANSPORT = /^(HTTP_|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|EPIPE|fetch|network|getaddrinfo|socket)/i;

function initFailure(error, env = process.env) {
  const message = String(error?.message || error || '');
  if (/Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN/.test(message)) {
    return { stage: 'database_config', problems: databaseConfigProblems(env) };
  }
  if (/Configure the public HTTPS Discord OAuth callback/.test(message)) {
    return { stage: 'discord_config', problems: discordConfigProblems(env) };
  }
  // configuredDiscord() throws these validation errors itself; names only.
  if (/DISCORD_|GUILD_ID/.test(message)) {
    return { stage: 'discord_config', detail: sanitizeDetail(message) };
  }
  const stage = TRANSPORT.test(String(error?.code || '') + ' ' + message) ? 'database_unreachable' : (error?.dbStage || 'database_unreachable');
  return { stage, detail: sanitizeDetail(message), code: error?.code ? String(error.code) : undefined };
}

function initFailureBody(error, env = process.env) {
  const { stage, problems, detail, code } = initFailure(error, env);
  const body = { error: 'Marketplace setup is incomplete. Ask the owner to check the hosting configuration.', stage };
  if (problems?.length) body.problems = problems;
  if (detail) body.detail = detail;
  if (code) body.code = code;
  return body;
}

// Vercel runtime log line: same sanitized stages, plus the stack's leading
// line for triage. Never includes values, URLs, or tokens.
function initFailureLog(error) {
  const { stage, detail, code } = initFailure(error);
  return JSON.stringify({ msg: 'marketplace init failed', stage, code: code || null, cause: detail || String(error?.message || error || '').slice(0, 200) });
}

module.exports = { discordConfigProblems, databaseConfigProblems, sanitizeDetail, initFailure, initFailureBody, initFailureLog };
