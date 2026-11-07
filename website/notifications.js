// Phase 2: persistent notification inbox.
// Records are created inside the same transaction as the business event that
// caused them, so a committed action never loses its notification to a later
// failure. The (event_key, user_id) UNIQUE constraint makes retries, double
// clicks, repeated polling, and worker restarts produce exactly one row.

const PAGE_SIZE = 20;

async function record(db, entries) {
  if (!entries?.length) return;
  for (const entry of entries) {
    await db.prepare(`INSERT OR IGNORE INTO notifications(user_id,event_key,event_type,title,body,link)
      VALUES(?,?,?,?,?,?)`).run(entry.userId, entry.eventKey, entry.eventType, entry.title, entry.body, entry.link || null);
  }
}

async function unreadCount(db, userId) {
  const row = await db.prepare('SELECT count(*) AS total FROM notifications WHERE user_id=? AND read=0').get(userId);
  return row?.total || 0;
}

async function inbox(db, userId, { after = 0, limit = PAGE_SIZE } = {}) {
  const cursor = Number(after) > 0 ? Number(after) : Number.MAX_SAFE_INTEGER;
  const items = await db.prepare(`SELECT id,event_type,title,body,link,read,created FROM notifications
    WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ?`).all(userId, cursor, Math.min(Number(limit) || PAGE_SIZE, 100));
  return items.map(item => ({ ...item, read: Boolean(item.read), created: item.created * 1000 }));
}

async function markRead(db, userId, id) {
  const result = await db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(Number(id), userId);
  return Boolean(result.changes);
}

async function markAllRead(db, userId) {
  await db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').run(userId);
}

module.exports = { record, unreadCount, inbox, markRead, markAllRead, PAGE_SIZE };
