// Phase 2: durable DM delivery outbox.
// Only committed events are queued. Attempts use a bounded claim/lease so
// concurrent workers (Vercel background execution, cron, or the Pterodactyl
// bot worker) cannot claim the same job. Failures back off; permanent
// failures stop retrying instead of looping forever. Delivery is best-effort:
// Discord cannot guarantee exactly-once delivery across every crash window,
// so the notification inbox stays the durable source of truth.

const LEASE_SECONDS = 30;
const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 5;
const MAX_BACKOFF = 3600;

const retryable = new Set(['failed', 'pending', 'rate_limited']);

function backoff(attempts) {
  return Math.min(60 * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF);
}

function sanitize(message) {
  return String(message || '').replace(/[^\x20-\x7E]/g, '?').slice(0, 200);
}

// Queues deliveries. Safe to call repeatedly: the (event_key, user_id) key
// deduplicates. Entries optionally carry a channel_id + embed_json for branded
// channel posts (the verification audit log) instead of a user DM.
// Called inside the business event's transaction.
async function queue(db, entries) {
  if (!entries?.length) return;
  for (const entry of entries) {
    await db.prepare(`INSERT OR IGNORE INTO delivery_outbox(event_key,user_id,discord_id,content,link,state,attempts,next_attempt_at,lease_until,channel_id,embed_json)
      VALUES(?,?,?,?,?,'pending',0,0,0,?,?)`)
      .run(entry.eventKey, entry.userId, entry.discordId, entry.content || '', entry.link || '', entry.channelId || null, entry.embedJson || null);
  }
}

async function claim(db, now = Math.floor(Date.now() / 1000)) {
  const candidates = await db.prepare(`SELECT id,discord_id,channel_id,content,link,embed_json,attempts FROM delivery_outbox
    WHERE state IN ('pending','failed','rate_limited') AND next_attempt_at<=? AND lease_until<=?
    ORDER BY next_attempt_at LIMIT ?`).all(now, now, CLAIM_LIMIT);
  const claimed = [];
  for (const candidate of candidates) {
    const result = await db.prepare(`UPDATE delivery_outbox SET attempts=attempts+1, lease_until=?
      WHERE id=? AND state IN ('pending','failed','rate_limited') AND lease_until<=?`).run(now + LEASE_SECONDS, candidate.id, now);
    if (result.changes) claimed.push(candidate);
  }
  return claimed;
}

function classify(error) {
  const code = error?.code ?? error?.status ?? null;
  // Discord code 50007: cannot send DMs to this user (DMs closed or no shared guild).
  if (code === 50007 || code === 403 || error?.permanent) return { outcome: 'permanent' };
  if (error?.retryAfter) return { outcome: 'rate_limited', delay: Math.min(Number(error.retryAfter), MAX_BACKOFF) };
  return { outcome: 'failed' };
}

function recordResult(db, job, outcome, message, messageId, now = Math.floor(Date.now() / 1000)) {
  if (outcome === 'sent') {
    return db.prepare('UPDATE delivery_outbox SET state=?, message_id=?, last_error=NULL, lease_until=0, next_attempt_at=0 WHERE id=?')
      .run('sent', messageId || null, job.id);
  }
  if (outcome === 'permanent') {
    return db.prepare('UPDATE delivery_outbox SET state=?, last_error=?, lease_until=0 WHERE id=?')
      .run('permanent', sanitize(message), job.id);
  }
  if (outcome === 'rate_limited') {
    return db.prepare('UPDATE delivery_outbox SET state=?, next_attempt_at=?, last_error=?, lease_until=0 WHERE id=?')
      .run('rate_limited', now + job.delay, sanitize(message), job.id);
  }
  if (job.attempts >= MAX_ATTEMPTS) {
    return db.prepare('UPDATE delivery_outbox SET state=?, last_error=?, lease_until=0 WHERE id=?')
      .run('exhausted', sanitize(message), job.id);
  }
  return db.prepare('UPDATE delivery_outbox SET state=?, next_attempt_at=?, last_error=?, lease_until=0 WHERE id=?')
    .run('failed', now + backoff(job.attempts), sanitize(message), job.id);
}

async function flush(db, send, { now = Math.floor(Date.now() / 1000), redact = sanitize } = {}) {
  const summary = { attempted: 0, sent: 0, failed: 0, permanent: 0, pending: 0 };
  const jobs = await claim(db, now);
  for (const job of jobs) {
    summary.attempted++;
    let messageId = null;
    try {
      messageId = await send(job);
      await recordResult(db, job, 'sent', null, messageId, now);
      summary.sent++;
    } catch (error) {
      const { outcome, delay } = classify(error);
      const jobWithDelay = { ...job, delay };
      await recordResult(db, jobWithDelay, outcome === 'rate_limited' ? 'rate_limited' : outcome, redact(error.message), null, now);
      if (outcome === 'permanent') summary.permanent++;
      else if (outcome === 'rate_limited') summary.pending++;
      else summary.failed++;
    }
  }
  return summary;
}

async function pending(db) {
  const rows = await db.prepare(`SELECT state, count(*) AS total FROM delivery_outbox
    WHERE state IN ('pending','failed','rate_limited','exhausted','permanent') GROUP BY state`).all();
  return Object.fromEntries(rows.map(row => [row.state, row.total]));
}

// Records a delivery outcome reported by an external worker (the Pterodactyl bot
// driving retries through the authenticated internal endpoint). The job must have
// been claimed first; the claim's lease prevents two workers sending the same DM.
async function complete(db, id, report, now = Math.floor(Date.now() / 1000)) {
  const row = await db.prepare('SELECT id,attempts FROM delivery_outbox WHERE id=?').get(Number(id));
  if (!row) return false;
  const outcome = ['sent', 'permanent', 'rate_limited'].includes(report.state) ? report.state : 'failed';
  await recordResult(db, { id: row.id, attempts: row.attempts, delay: Math.min(Number(report.retryAfter) || 0, MAX_BACKOFF) },
    outcome, report.error || null, report.messageId || null, now);
  return true;
}

module.exports = { queue, claim, flush, pending, complete, backoff, classify, MAX_ATTEMPTS, LEASE_SECONDS };
