const { waitUntil } = require('@vercel/functions');
const { openHostedDatabase } = require('../website/db');
const { configuredDiscord } = require('../website/discord');
const { createHandler } = require('../website/server');
const { initFailureBody, initFailureLog } = require('../website/init-errors');

let application;
async function initialize() {
  const discord = configuredDiscord();
  if (!discord || !discord.redirectUri.startsWith('https:')) throw new Error('Configure the public HTTPS Discord OAuth callback.');
  const db = await openHostedDatabase({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  return createHandler({
    db, discord, secure: true, background: waitUntil, cronSecret: process.env.CRON_SECRET,
    clientAddress: req => req.headers['x-vercel-forwarded-for'] || req.socket.remoteAddress,
  }).handler;
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('__route');
  if (!route || !/^[a-zA-Z0-9_/-]+$/.test(route) || route === 'marketplace') {
    res.writeHead(404);
    return res.end();
  }
  url.searchParams.delete('__route');
  req.url = '/api/' + route + url.search;
  try {
    application ||= initialize().catch(error => {
      application = undefined;
      throw error;
    });
    const handler = await application;
    return await handler(req, res);
  } catch (error) {
    // A failed startup must remain diagnosable from the runtime log and from
    // the 503 itself: the response carries the failing configuration stage
    // and variable names only — never values, URLs, or credentials.
    console.error(initFailureLog(error));
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(initFailureBody(error)));
  }
};
