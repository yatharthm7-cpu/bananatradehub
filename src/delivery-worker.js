// Phase 2: continuous DM delivery worker for the separately hosted website.
// The website runs on Vercel, where long-lived loops are not available. This
// worker runs on the same Pterodactyl process as the bot and drives the durable
// outbox through the website's authenticated internal endpoint:
//
//   GET  /api/delivery-work  -> claims a bounded batch of jobs (leased)
//   POST /api/delivery-work  -> reports one outcome (sent | failed | permanent | rate_limited)
//
// The lease prevents two workers from sending the same DM; an unreported claim
// expires so another pass can reclaim it. Delivery is best-effort: the website's
// notification inbox stays the durable source of truth, and this worker never
// sees credentials, private evidence, or inbox contents beyond each message.

const { REST, Routes } = require('discord.js');

const POLL_INTERVAL = 30000;
const MAX_IN_FLIGHT = 3;

function safeError(error) {
  const code = error?.code ?? error?.status ?? null;
  // Discord code 50007: cannot send DMs to this user; 403: forbidden.
  if (code === 50007 || code === 403) return { state: 'permanent', error: 'DMs unavailable for this recipient.' };
  if (error?.retryAfter || code === 429) return { state: 'rate_limited', retryAfter: Number(error.retryAfter) || 60 };
  return { state: 'failed', error: String(error?.message || 'Delivery failed.').slice(0, 200) };
}

class DeliveryWorker {
  constructor({ token, baseUrl, secret, api, request = fetch, pollInterval = POLL_INTERVAL }) {
    if (!token || !baseUrl || !secret) return null;
    this.api = api || new REST({ version: '10', timeout: 8000 }).setToken(token);
    this.endpoint = baseUrl.replace(/\/$/, '') + '/api/delivery-work';
    this.secret = secret;
    this.request = request;
    this.pollInterval = pollInterval;
    this.timer = null;
    this.inFlight = new Set();
  }

  async collect() {
    const response = await this.request(this.endpoint, {
      method: 'GET', headers: { Authorization: 'Bearer ' + this.secret, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Delivery work unavailable (HTTP ${response.status}).`);
    const result = await response.json();
    return Array.isArray(result.jobs) ? result.jobs : [];
  }

  async deliver(job) {
    // Channel jobs carry a prepared, server-built embed (the verification
    // audit log). DM jobs reach an inbox-opted-in user with a trade link.
    if (job.channelId) {
      const message = await this.api.post(Routes.channelMessages(job.channelId), {
        body: { embeds: [JSON.parse(job.embedJson)], allowed_mentions: { parse: [] } } });
      return { state: 'sent', messageId: message.id };
    }
    const channel = await this.api.post(Routes.userChannels(), { body: { recipient_id: job.discordId } });
    const message = await this.api.post(Routes.channelMessages(channel.id), { body: {
      content: `${job.content}\n<${this.endpoint.replace('/api/delivery-work', '')}${job.link}>`,
      allowed_mentions: { parse: [] },
    } });
    return { state: 'sent', messageId: message.id };
  }

  async report(job, outcome) {
    const response = await this.request(this.endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, state: outcome.state, error: outcome.error || null, messageId: outcome.messageId || null, retryAfter: outcome.retryAfter }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  }

  async process(job) {
    let outcome;
    try {
      outcome = await this.deliver(job);
    } catch (error) {
      outcome = safeError(error);
    }
    try { await this.report(job, outcome); } catch { /* a lost report lets the lease expire and the job re-run */ }
    this.inFlight.delete(job.id);
  }

  tick() {
    this.collect().then(jobs => {
      for (const job of jobs) {
        if (this.inFlight.size >= MAX_IN_FLIGHT || this.inFlight.has(job.id)) break;
        this.inFlight.add(job.id);
        this.process(job).catch(() => this.inFlight.delete(job.id));
      }
    }).catch(error => {
      if (error?.message !== 'Delivery work unavailable (HTTP 403).') console.error('Delivery worker poll failed:', String(error.message || error).slice(0, 160));
    });
  }

  start() {
    if (!this.api || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.pollInterval);
    this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

function startDeliveryWorker({ token, baseUrl = process.env.TRADE_HUB_URL, secret = process.env.INTERNAL_WORKER_SECRET, api, request } = {}) {
  const worker = new DeliveryWorker({ token, baseUrl, secret, api, request });
  worker?.start();
  return worker;
}

module.exports = { DeliveryWorker, startDeliveryWorker, safeError };
