const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { openDatabase, transaction } = require('./db');
const { configuredDiscord, authorize, discordIdentity, verifiedMember, tradeMessenger, listingMessenger,
  guildMember, publicUser, fetchRole, guildRoles, assignRole, removeRole, channelBelongsToGuild, verificationLogMessenger } = require('./discord');
const verification = require('./verification');
const { listingDetails, screenshot } = require('./listing-proof');
const { createMinecraftSkins } = require('./minecraft-skins');
const { validateOffer, saveOffer, readOfferHistory, summary: offerSummary } = require('./trade-offers');
const notifications = require('./notifications');
const outbox = require('./outbox');
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['../dist/app.js', 'text/javascript; charset=utf-8'],
  '/spotlight.css': ['../dist/spotlight.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/items.svg': ['items.svg', 'image/svg+xml'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
  '/logo.png': ['../../assets/BananaSMP_Icon.png', 'image/png'],
  '/banner.png': ['../../assets/BananaSMP_Banner.png', 'image/png'],
};
const digest = token => createHash('sha256').update(token).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function field(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} must be ${min}–${max} characters.`);
  return value.trim();
}
function getToken(req) {
  return /(?:^|;\s*)banana_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}
async function readBody(req, limit = 16384) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON is required.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid request body.');
  return value;
}

const LISTING_LIMIT = 9;
function createHandler({ db = openDatabase(), secure = false, discord = null, identify = discordIdentity,
  checkMember = verifiedMember, sendTradeMessage = tradeMessenger(discord), postListing = listingMessenger(discord),
  background = promise => void promise, cronSecret = null, clientAddress = req => req.socket.remoteAddress,
  minecraftSkins = createMinecraftSkins(), postVerificationLog = verificationLogMessenger(discord),
  verifyDeps = {}, verify = verification.processSignIn, refreshVerification = verification.refresh,
  reportFor = verification.migrationReport, memberLookup = guildMember, removeRoleFn = removeRole,
  logChannelValidate = channelBelongsToGuild } = {}) {
  const attempts = new Map();
  const adminIds = new Set(discord?.adminIds || []);
  const allListings = `SELECT l.*, u.ign AS seller, p.details, p.review_note FROM listings l
    JOIN users u ON u.id=l.seller_id LEFT JOIN listing_proofs p ON p.listing_id=l.id`;
  const publicListings = allListings + " WHERE l.status='open' AND u.suspended=0 AND p.listing_id IS NOT NULL";
  const slotsUsed = async id => (await db.prepare(`SELECT count(*) AS used FROM listings l LEFT JOIN listing_proofs p ON p.listing_id=l.id
    WHERE l.seller_id=? AND (l.status='reserved' OR (l.status IN ('review','open') AND p.listing_id IS NOT NULL))`).get(id)).used;
  async function requireSlot(id) {
    if ((await slotsUsed(id)) >= LISTING_LIMIT) fail(409, 'All 9 listing slots are occupied. Withdraw an open or pending listing to free a slot.');
  }
  let posting = false;
  async function flushListingFeed() {
    if (!postListing || posting) return;
    posting = true;
    try {
      const jobs = await db.prepare('SELECT listing_id FROM listing_feed WHERE delivered=0 AND retry_at<=unixepoch() ORDER BY listing_id LIMIT 5').all();
      for (const { listing_id: id } of jobs) {
        const claim = await db.prepare(`UPDATE listing_feed SET retry_at=unixepoch()+300
          WHERE listing_id=? AND delivered=0 AND retry_at<=unixepoch()`).run(id);
        if (!claim.changes) continue;
        const listing = (await db.prepare(publicListings + ' AND l.id=?').get(id));
        if (!listing) {
          await db.prepare('UPDATE listing_feed SET delivered=1 WHERE listing_id=?').run(id);
          continue;
        }
        try {
          await postListing(listing);
          await db.prepare('UPDATE listing_feed SET delivered=1 WHERE listing_id=?').run(id);
        } catch {
          await db.prepare('UPDATE listing_feed SET retry_at=unixepoch()+60 WHERE listing_id=?').run(id);
          console.error('Trade Radar delivery failed. The listing remains queued.');
        }
      }
    } finally { posting = false; }
  }
  const allTrades = `SELECT t.*,l.item,l.quantity,l.wants,l.seller_id,s.ign AS seller,b.ign AS buyer,
    d.status AS dispute_status,d.decision AS dispute_decision,
    COALESCE(p.terms,t.offer) AS current_offer, COALESCE(p.version,0) AS version,
    COALESCE(p.author,t.buyer_id) AS proposer
    FROM trades t JOIN listings l ON l.id=t.listing_id JOIN users s ON s.id=l.seller_id JOIN users b ON b.id=t.buyer_id
    LEFT JOIN disputes d ON d.trade_id=t.id
    LEFT JOIN trade_proposals p ON p.trade_id=t.id AND p.version=(SELECT MAX(version) FROM trade_proposals WHERE trade_id=t.id)`;
  const event = async (id, user, label) => (await db.prepare('INSERT INTO trade_events(trade_id,actor,label) VALUES(?,?,?)').run(id, user.id, label));
  const deliver = sendTradeMessage || postVerificationLog ? async (job) => {
    if (job.channel_id) {
      if (!postVerificationLog) throw Object.assign(new Error('Verification log unavailable.'), { permanent: true });
      const message = await postVerificationLog(job.channel_id, JSON.parse(job.embed_json));
      return message?.id || null;
    }
    const tradeId = Number(String(job.link).match(/\/trade\/(\d+)/)?.[1] || 0);
    await sendTradeMessage(job.discord_id, tradeId, job.content);
    return null;
  } : null;
  // Website-only verification audit channel. Validated against the live guild
  // and cached; an invalid channel degrades to "no audit log" rather than
  // failing a sign-in. Embed posts go through the same durable outbox as DMs.
  const logChannelCache = new Map();
  const resolveLogChannel = async () => {
    if (!discord?.logChannelId || !postVerificationLog) return null;
    const cached = logChannelCache.get(discord.logChannelId);
    if (cached && cached.until > Date.now()) return cached.ok ? discord.logChannelId : null;
    let ok = false;
    try { ok = Boolean(await logChannelValidate(discord, discord.logChannelId)); } catch { ok = false; }
    logChannelCache.set(discord.logChannelId, { ok, until: Date.now() + 300000 });
    if (!ok) console.error('DISCORD_VERIFICATION_LOG_CHANNEL_ID is not a reachable text channel in this guild. Sign-in audit embeds are disabled until it is fixed.');
    return ok ? discord.logChannelId : null;
  };
  const websiteOrigin = () => process.env.WEBSITE_URL || (discord ? new URL(discord.redirectUri).origin : null);
  const verificationOptions = async localUser => ({
    userId: localUser.id, discordId: localUser.discord_id, ign: localUser.ign || null,
    rulesVer: verification.rulesVersion(), channelId: await resolveLogChannel(), websiteUrl: websiteOrigin(),
  });
  const verificationDeps = () => ({ embedFor: verification.signInEmbed, ...verifyDeps });
  // Phase 2: records inbox entries (always) and durable outbox deliveries (DM opt-in
  // only) for a trade event. Must be called inside the event's transaction so a
  // committed action never loses its notification to a later failure. The stable
  // event key makes retries, double clicks, and worker restarts produce one record.
  async function notifyTradeEvent(tradeId, actorId, { eventKey, eventType, title, body }) {
    const recipients = (await db.prepare(`SELECT u.id AS user_id, link.discord_id, p.user_id AS opted_in
      FROM trades t JOIN listings l ON l.id=t.listing_id
      JOIN users u ON u.id IN (t.buyer_id,l.seller_id)
      LEFT JOIN discord_links link ON link.user_id=u.id
      LEFT JOIN trade_notification_preferences p ON p.user_id=u.id
      WHERE t.id=? AND u.id<>? AND u.suspended=0`).all(tradeId, actorId));
    if (!recipients.length) return;
    const link = `/trade/${tradeId}`;
    await notifications.record(db, recipients.map(recipient => ({
      userId: recipient.user_id, eventKey, eventType, title, body, link,
    })));
    const deliveries = recipients.filter(recipient => deliver && recipient.discord_id && recipient.opted_in)
      .map(recipient => ({ eventKey, userId: recipient.user_id, discordId: recipient.discord_id, content: `${title} · ${body}`, link }));
    await outbox.queue(db, deliveries);
  }
  // Phase 2: seller-facing notification for listing review outcomes.
  async function notifySellerEvent(sellerId, { eventKey, eventType, title, body, link }) {
    const rows = (await db.prepare(`SELECT u.id AS user_id, link.discord_id, p.user_id AS opted_in
      FROM users u LEFT JOIN discord_links link ON link.user_id=u.id
      LEFT JOIN trade_notification_preferences p ON p.user_id=u.id WHERE u.id=?`).get(sellerId));
    if (!rows) return;
    await notifications.record(db, [{ userId: rows.user_id, eventKey, eventType, title, body, link }]);
    if (deliver && rows.discord_id && rows.opted_in) {
      await outbox.queue(db, [{ eventKey, userId: rows.user_id, discordId: rows.discord_id, content: `${title} · ${body}`, link }]);
    }
  }
  const flushDeliveries = () => deliver ? outbox.flush(db, deliver).catch(() => console.error('DM delivery worker failed.')) : Promise.resolve();
  // Immediate delivery attempt on supported platforms (Vercel waitUntil). Tests and
  // hosts without background support can skip it by passing a falsy background.
  const scheduleDelivery = () => { if (background) background(flushDeliveries().catch(() => console.error('Could not process the notification outbox.'))); };
  const tradeLink = id => `/trade/${id}`;
  const audit = async (user, action, id) => (await db.prepare('INSERT INTO audit(actor,action,target) VALUES(?,?,?)').run(user.id, action, id));
  async function hideListing(id, status = 'hidden') {
    await db.prepare('UPDATE listings SET status=? WHERE id=?').run(status, id);
    await db.prepare("UPDATE trades SET status='cancelled' WHERE listing_id=? AND status IN ('pending','accepted')").run(id);
    await db.prepare("UPDATE cancellation_requests SET status='withdrawn' WHERE status='pending' AND trade_id IN (SELECT id FROM trades WHERE listing_id=?)").run(id);
  }
  function cookie(res, token, seconds) {
    res.setHeader('Set-Cookie', `banana_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (payload, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      const appearance = /^\/api\/minecraft\/([a-zA-Z0-9_]{3,16})\/(avatar|body)$/.exec(route);
      if (route.startsWith('/api/minecraft/')) {
        if (req.method !== 'GET' || !appearance) fail(404, 'Minecraft appearance not found.');
        const image = await minecraftSkins.image(appearance[1], appearance[2]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=1200', 'X-Content-Type-Options': 'nosniff' });
        return res.end(image);
      }
      if (route === '/api/feed-retry') {
        if (req.method !== 'GET' || !cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) fail(403, 'Forbidden.');
        await flushListingFeed();
        return json({ ok: true });
      }
      if (route === '/api/delivery-retry') {
        if (req.method !== 'GET' || !cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) fail(403, 'Forbidden.');
        // Read-only ops lookup: the member's verification record, sign-in
        // events, and durable delivery jobs. Cron-secret protected, and the
        // canonical way to answer "what is this member's state" without a
        // browser session.
        const member = url.searchParams.get('member');
        let lookup = null;
        if (member && /^\d{17,20}$/.test(member)) {
          lookup = {
            record: await verification.loadRecord(db, member, discord?.guildId),
            events: await db.prepare('SELECT event_key,event_type FROM website_signin_events WHERE discord_id=? ORDER BY id LIMIT 10').all(member),
            jobs: await db.prepare('SELECT state,content,last_error FROM delivery_outbox WHERE discord_id=? ORDER BY id DESC LIMIT 10').all(member),
          };
        }
        // Durable retry also recovers sign-ins interrupted between the Discord
        // role grant and the persisted completion — the crash window no browser
        // visit can repair. Runs on the Vercel cron (or an authorized ops
        // trigger), so completion never depends on the member's next request.
        let reconciliation = null;
        if (discord) {
          try {
            reconciliation = await verification.reconcileStuck(db, discord, { channelId: await resolveLogChannel(), websiteUrl: websiteOrigin() }, verificationDeps());
          } catch (error) {
            console.error('Verification reconciliation failed.', error.message);
            reconciliation = { attempted: 0, completed: 0, granted: 0, skipped: 0, records: [], error: String(error.message).slice(0, 200) };
          }
        }
        const result = await flushDeliveries();
        return json({ ok: true, delivery: result, reconciliation, ...(lookup ? { lookup } : {}) });
      }
      // Phase 2: authenticated internal endpoint so the separately hosted
      // Pterodactyl bot can act as a continuous delivery worker without another
      // hosting provider. Claims (leases) jobs for this worker only.
      if (route === '/api/delivery-work' && req.method === 'GET') {
        const workerSecret = process.env.INTERNAL_WORKER_SECRET || cronSecret;
        if (!workerSecret || req.headers.authorization !== 'Bearer ' + workerSecret) fail(403, 'Forbidden.');
        const jobs = await outbox.claim(db);
        return json({ jobs: jobs.map(job => ({ id: job.id, discordId: job.discord_id, content: job.content, link: job.link,
          channelId: job.channel_id, embedJson: job.embed_json })) });
      }
      if (!route.startsWith('/api/')) {
        // ESM code-splitting emits lazy chunks under /chunks/. They are same-origin
        // static assets, served with an explicit JS MIME so module loading works.
        const chunk = /^\/chunks\/([a-zA-Z0-9._-]+\.js)$/.exec(route);
        if (chunk && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end(fs.readFileSync(path.join(__dirname, 'dist', 'chunks', chunk[1])));
        }
        const page = /^\/trade\/\d+$/.test(route) ? '/' : route;
        if (req.method !== 'GET' || !Object.hasOwn(files, page)) fail(404, 'Page not found.');
        const [filename, type] = files[page];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', filename)));
      }
      const token = getToken(req);
      const session = token && digest(token);
      const findUser = async () => session && (await db.prepare(`SELECT u.id,u.ign,l.discord_id FROM sessions s JOIN users u ON u.id=s.user_id
        JOIN discord_links l ON l.user_id=u.id
        WHERE s.token=? AND s.auth_method='discord' AND s.expires>unixepoch() AND u.suspended=0`).get(session));
      const current = (await findUser());
      const user = current && { id: current.id, ign: current.ign, role: adminIds.has(current.discord_id) ? 'admin' : 'member' };
      const requireUser = async () => { if (!user || !(await findUser())) fail(401, 'Sign in to continue.'); };
      const requireAdmin = async () => { (await requireUser()); if (user.role !== 'admin') fail(403, 'Administrator access required.'); };
      // Website-only verification: a protected action needs both an
      // authoritative verified record and current Discord-side eligibility.
      // Legacy role holders without a record are never given a bypass route.
      const discordGuild = discord?.guildId || null;
      const hasWebsiteVerification = async discordId => Boolean(discordId &&
        (await db.prepare('SELECT 1 FROM website_verification_records WHERE discord_id=? AND guild_id=? AND state=?').get(discordId, discordGuild, 'verified')));
      async function requireVerified() {
        await requireUser();
        const record = await hasWebsiteVerification(current.discord_id);
        let roleHeld;
        try { roleHeld = record && await checkMember(discord, current.discord_id); }
        catch { fail(503, 'Discord verification is temporarily unavailable. Try again shortly.'); }
        await db.prepare('UPDATE discord_links SET verified=?,checked=unixepoch() WHERE user_id=?').run(Number(roleHeld), user.id);
        if (!record) fail(403, 'Complete website verification on the site to unlock listings and offers.');
        if (!roleHeld) fail(403, 'Your Discord access changed. Sign in again on the verification page to restore it.');
      }
      if (req.method === 'GET') {
        const offerProof = /^\/api\/trades\/(\d+)\/proposals\/(\d+)\/items\/([0-2])\/screenshot$/.exec(route);
        const agreementProof = /^\/api\/trades\/(\d+)\/agreement\/(seller|buyer)\/([0-2])\/screenshot$/.exec(route);
        if (offerProof || agreementProof) {
          const match = offerProof || agreementProof;
          const trade = await db.prepare(allTrades + ' WHERE t.id=?').get(Number(match[1]));
          if (!user || !trade || (user.role !== 'admin' && ![trade.seller_id, trade.buyer_id].includes(user.id))) fail(404, 'Evidence not found.');
          const evidence = offerProof
            ? await db.prepare('SELECT image FROM trade_offer_items WHERE trade_id=? AND version=? AND position=?').get(Number(match[1]), Number(match[2]), Number(match[3]))
            : await db.prepare('SELECT image FROM trade_agreement_evidence WHERE trade_id=? AND side=? AND position=?').get(Number(match[1]), match[2], Number(match[3]));
          if (!evidence) fail(404, 'Evidence not found.');
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' });
          return res.end(Buffer.from(evidence.image));
        }
        const proof = /^\/api\/listings\/(\d+)\/screenshot$/.exec(route);
        if (proof) {
          const id = Number(proof[1]);
          const listing = (await db.prepare(allListings + ' WHERE l.id=?').get(id));
          if (!listing?.details) fail(404, 'Screenshot not found.');
          const publicListing = listing.status === 'open' && !(await db.prepare('SELECT suspended FROM users WHERE id=?').get(listing.seller_id)).suspended;
          const participant = user && (await db.prepare('SELECT id FROM trades WHERE listing_id=? AND buyer_id=?').get(id, user.id));
          if (!publicListing && !(user && (user.role === 'admin' || user.id === listing.seller_id || participant))) fail(404, 'Screenshot not found.');
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' });
          return res.end(Buffer.from((await db.prepare('SELECT image FROM listing_proofs WHERE listing_id=?').get(id)).image));
        }
        const room = /^\/api\/trades\/(\d+)$/.exec(route);
        if (room) {
          await requireUser();
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(Number(room[1])));
          if (!trade || (user.role !== 'admin' && ![trade.buyer_id, trade.seller_id].includes(user.id))) fail(404, 'Trade not found.');
          const listing = await db.prepare(allListings + ' WHERE l.id=?').get(trade.listing_id);
          const proposals = await readOfferHistory(db, trade.id);
          const cancellation = (await db.prepare(`SELECT r.trade_id,r.requested_by,r.reason,r.status,r.decided_by,r.decided_at,r.created,
            requester.ign AS requested_by_ign, decided.ign AS decided_by_ign FROM cancellation_requests r
            LEFT JOIN users requester ON requester.id=r.requested_by
            LEFT JOIN users decided ON decided.id=r.decided_by WHERE r.trade_id=?`).get(trade.id));
          const arrangement = (await db.prepare(`SELECT a.*, proposer.ign AS proposed_by_ign, acknowledger.ign AS acknowledged_by_ign
            FROM trade_arrangements a LEFT JOIN users proposer ON proposer.id=a.proposed_by
            LEFT JOIN users acknowledger ON acknowledger.id=a.acknowledged_by WHERE a.trade_id=?`).get(trade.id));
          return json({
            trade,
            listing: { item: listing.item, category: listing.category, quantity: listing.quantity, notes: listing.notes,
              details: JSON.parse(listing.details || 'null'), screenshot: `/api/listings/${listing.id}/screenshot`, reviewStatus: listing.details ? 'Staff-reviewed listing' : 'Legacy listing' },
            requiresEvidence: trade.status === 'pending' && !proposals.find(proposal => proposal.version === trade.version)?.items.length,
            snapshot: JSON.parse((await db.prepare('SELECT terms FROM trade_snapshots WHERE trade_id=?').get(trade.id))?.terms || 'null'),
            cancellation: cancellation || null,
            arrangement: arrangement || null,
            proposals,
            events: (await db.prepare('SELECT e.*,u.ign FROM trade_events e JOIN users u ON u.id=e.actor WHERE e.trade_id=? ORDER BY e.id DESC').all(trade.id)),
          });
        }
        // Phase 2: lightweight change check for visibility-aware polling. Avoids
        // fetching screenshots or full histories on every tick.
        const versionCheck = /^\/api\/trades\/(\d+)\/version$/.exec(route);
        if (versionCheck) {
          await requireUser();
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(Number(versionCheck[1])));
          if (!trade || (user.role !== 'admin' && ![trade.buyer_id, trade.seller_id].includes(user.id))) fail(404, 'Trade not found.');
          const proposalCount = (await db.prepare('SELECT count(*) AS total FROM trade_proposals WHERE trade_id=?').get(trade.id)).total;
          const pendingCancellation = Boolean((await db.prepare("SELECT 1 FROM cancellation_requests WHERE trade_id=? AND status='pending'").get(trade.id)));
          return json({
            id: trade.id, status: trade.status, version: trade.version, proposer: trade.proposer,
            buyerDone: Boolean(trade.buyer_done), sellerDone: Boolean(trade.seller_done),
            buyerConfirmedAt: trade.buyer_confirmed_at || null, sellerConfirmedAt: trade.seller_confirmed_at || null,
            disputeStatus: trade.dispute_status || null, proposalCount, pendingCancellation,
          });
        }
        if (route === '/api/notifications/count') {
          await requireUser();
          return json({ unread: await notifications.unreadCount(db, user.id) });
        }
        if (route === '/api/notifications') {
          await requireUser();
          return json({ items: await notifications.inbox(db, user.id, { after: url.searchParams.get('after'), limit: url.searchParams.get('limit') }) });
        }
        if (route === '/api/session') return json({
          user: user || null, discordEnabled: Boolean(discord),
          notificationsAvailable: Boolean(sendTradeMessage),
          tradeNotifications: Boolean(user && (await db.prepare('SELECT 1 FROM trade_notification_preferences WHERE user_id=?').get(user.id))),
          unread: user ? await notifications.unreadCount(db, user.id) : 0,
          discord: user ? (await db.prepare('SELECT username,verified,checked FROM discord_links WHERE user_id=?').get(user.id)) || null : null,
          verification: user && discord ? await verification.verificationView(db, { discordId: current.discord_id, guildId: discordGuild }) : null,
          rulesVersion: verification.rulesVersion(),
        });
        if (route === '/api/discord/callback') {
          if (!discord) fail(503, 'Discord sign-in is unavailable.');
          const nonce = /(?:^|;\s*)banana_oauth=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
          const state = url.searchParams.get('state');
          // Single-use OAuth state carrying the rules consent: the DELETE guard
          // makes replay, reload, and double-click resolve to exactly one flow.
          const stateRow = nonce && state && (await db.prepare('SELECT rules_consent,rules_version FROM oauth_states WHERE state=? AND session=? AND expires>unixepoch()').get(digest(state), digest(nonce)));
          if (!stateRow || !(await db.prepare('DELETE FROM oauth_states WHERE state=? AND session=?').run(digest(state), digest(nonce))).changes) {
            fail(403, 'This Discord sign-in expired. Start again from the marketplace.');
          }
          if (!stateRow.rules_consent || stateRow.rules_version !== verification.rulesVersion()) {
            fail(403, 'Read and accept the current server rules before signing in.');
          }
          const finish = (result, admin = false) => {
            res.writeHead(303, { Location: (admin ? '/admin#' : '/#desk?') + 'discord=' + result, 'Cache-Control': 'no-store' });
            return res.end();
          };
          const code = url.searchParams.get('code');
          if (!code) return finish('cancelled');
          let identity;
          try { identity = await identify(discord, code); } catch { return finish('failed'); }
          const admin = adminIds.has(identity.id);
          const nextToken = randomBytes(32).toString('hex');
          // Step 1 — authentication. Signing in never depends on verification
          // eligibility; an unverified member must be able to reach the flow.
          const signedIn = (await transaction(db, async () => {
            const linked = (await db.prepare('SELECT u.id,u.suspended FROM discord_links l JOIN users u ON u.id=l.user_id WHERE l.discord_id=?').get(identity.id));
            if (linked?.suspended) return null;
            // Keep existing account IDs and trade history. Older databases require email and password columns.
            const id = linked?.id ?? (await db.prepare("INSERT INTO users(email,ign,password) VALUES(?,'','')").run('discord:' + identity.id)).lastInsertRowid;
            await db.prepare('UPDATE users SET role=? WHERE id=?').run(admin ? 'admin' : 'member', id);
            (await db.prepare('INSERT INTO discord_links(user_id,discord_id,username,verified) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,verified=excluded.verified,checked=unixepoch()')
              .run(id, identity.id, identity.username, Number(identity.verified)));
            if (session) (await db.prepare('DELETE FROM sessions WHERE token=?').run(session));
            await db.prepare('DELETE FROM sessions WHERE expires<=unixepoch()').run();
            await db.prepare("INSERT INTO sessions(token,user_id,expires,auth_method) VALUES(?,?,unixepoch()+86400,'discord')").run(digest(nextToken), id);
            return { id, ign: (await db.prepare('SELECT ign FROM users WHERE id=?').get(id)).ign };
          }));
          if (!signedIn) return finish('suspended');
          cookie(res, nextToken, 86400);
          // Step 2 — website verification. A grant or audit-embed failure must
          // never break the session; the page shows the pending state instead.
          let outcome = 'pending';
          try {
            const result = await verify(db, discord, { ...(await verificationOptions({ ...signedIn, discord_id: identity.id })), suspended: false },
              verificationDeps());
            outcome = result.outcome === 'verified' ? 'verified' : result.outcome === 'unavailable' ? 'linked' : 'pending';
          } catch (error) { console.error('Website verification step failed. The sign-in still succeeded.', error.message); }
          scheduleDelivery();
          return finish(outcome, admin);
        }
        const disputeMatch = /^\/api\/disputes\/(\d+)$/.exec(route);
        if (disputeMatch) {
          await requireUser();
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(Number(disputeMatch[1])));
          if (!trade || (user.role !== 'admin' && ![trade.buyer_id, trade.seller_id].includes(user.id))) fail(404, 'Dispute not found.');
          const dispute = (await db.prepare('SELECT * FROM disputes WHERE trade_id=?').get(trade.id));
          if (!dispute) fail(404, 'Dispute not found.');
          return json({ trade, dispute, evidence: (await db.prepare(`SELECT e.*,u.ign FROM dispute_evidence e
            JOIN users u ON u.id=e.author WHERE e.trade_id=? ORDER BY e.id`).all(trade.id)) });
        }
        if (route === '/api/listings') return json((await db.prepare(publicListings + ' ORDER BY l.id DESC LIMIT 250').all()));
        const publicListing = /^\/api\/listings\/(\d+)$/.exec(route);
        if (publicListing) {
          const listing = (await db.prepare(publicListings + ' AND l.id=?').get(Number(publicListing[1])));
          if (!listing) fail(404, 'This listing is no longer available.');
          return json(listing);
        }
        if (route === '/api/me') {
          await requireUser();
          return json({
            slots: { used: (await slotsUsed(user.id)), limit: LISTING_LIMIT },
            listings: (await db.prepare(allListings + ' WHERE l.seller_id=? ORDER BY l.id DESC').all(user.id)),
            trades: (await db.prepare(allTrades + ' WHERE t.buyer_id=? OR l.seller_id=? ORDER BY t.id DESC').all(user.id, user.id)),
          });
        }
        if (route === '/api/admin') {
          await requireAdmin();
          return json({
            listings: (await db.prepare(allListings + ' ORDER BY l.id DESC').all()),
            trades: (await db.prepare(allTrades + ' ORDER BY t.id DESC').all()),
            users: (await db.prepare('SELECT u.id,u.ign,u.suspended,l.username,l.discord_id FROM users u LEFT JOIN discord_links l ON l.user_id=u.id ORDER BY u.id DESC').all())
              .map(account => ({ ...account, role: adminIds.has(account.discord_id) ? 'admin' : 'member' })),
            audit: (await db.prepare('SELECT a.*,u.ign FROM audit a JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100').all()),
          });
        }
        // Owner migration report (dry-run): the authoritative record state and
        // the live role state for every linked account. Nothing is changed.
        if (route === '/api/admin/verification-report') {
          await requireAdmin();
          const rows = (await db.prepare(`SELECT l.discord_id,l.username,
            (SELECT r.state FROM website_verification_records r WHERE r.discord_id=l.discord_id AND r.guild_id=?) AS record_state,
            (SELECT r.rules_version FROM website_verification_records r WHERE r.discord_id=l.discord_id AND r.guild_id=?) AS rules_version
            FROM discord_links l ORDER BY l.username LIMIT 500`).all(discord?.guildId, discord?.guildId));
          const accounts = await reportFor(discord, rows, verificationDeps());
          const count = action => accounts.filter(item => item.action === action).length;
          // Owner diagnostics for stuck sign-ins: whether the audit channel
          // actually receives posts right now, and how many durable deliveries
          // are waiting. Non-secret facts only.
          const auditChannel = { configured: discord?.logChannelId || null, validated: Boolean(await resolveLogChannel()) };
          return json({ rulesVersion: verification.rulesVersion(), logChannelId: discord?.logChannelId || null, auditChannel,
            delivery: await outbox.pending(db), accounts,
            summary: { keep: count('keep'), repair: count('repair-role'), legacy: count('remove-legacy-role'), unknown: count('unknown'), total: accounts.length } });
        }
        fail(404, 'Endpoint not found.');
      }
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      const workerSecret = process.env.INTERNAL_WORKER_SECRET || cronSecret;
      if (route === '/api/delivery-work') {
        if (!workerSecret || req.headers.authorization !== 'Bearer ' + workerSecret) fail(403, 'Forbidden.');
        const report = await readBody(req, 100000);
        if (!(await outbox.complete(db, report.id, { state: report.state, error: report.error, messageId: report.messageId, retryAfter: report.retryAfter }))) fail(404, 'Delivery job not found.');
        return json({ ok: true });
      }
      const origin = req.headers.origin;
      const expectedOrigin = secure && discord ? new URL(discord.redirectUri).origin : `${secure ? 'https' : 'http'}://${req.headers.host}`;
      if (origin !== expectedOrigin || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Invalid request origin.');
      const largeUpload = route === '/api/listings' || /^\/api\/listings\/\d+\/request$/.test(route) || /^\/api\/trades\/\d+\/counter$/.test(route);
      const body = await readBody(req, largeUpload ? 2_820_000 : undefined);
      if (route === '/api/discord/login') {
        if (!discord) fail(503, 'Discord sign-in is unavailable until the server owner configures it.');
        const expectedOrigin = new URL(discord.redirectUri).origin;
        if (origin !== expectedOrigin) fail(400, 'Open the marketplace at ' + expectedOrigin + ' to sign in.');
        // Rules consent is bound to the single-use OAuth state so the callback
        // can never grant verification without an acceptance on record.
        const currentRules = verification.rulesVersion();
        if (body.accepted !== true || Number(body.rulesVersion) !== currentRules) {
          fail(400, `Read and accept the current server rules (version ${currentRules}) before signing in.`);
        }
        const now = Date.now();
        for (const [address, record] of attempts) if (record.until <= now) attempts.delete(address);
        const ip = clientAddress(req);
        const attempt = attempts.get(ip) || { count: 0, until: now + 600000 };
        if (++attempt.count > 20) fail(429, 'Too many attempts. Try again in 10 minutes.');
        attempts.set(ip, attempt);
        const state = randomBytes(32).toString('hex');
        const nonce = randomBytes(32).toString('hex');
        await db.prepare('DELETE FROM oauth_states WHERE expires<=unixepoch()').run();
        await db.prepare('INSERT INTO oauth_states(state,session,expires,rules_consent,rules_version) VALUES(?,?,unixepoch()+600,?,?)')
          .run(digest(state), digest(nonce), 1, currentRules);
        res.setHeader('Set-Cookie', 'banana_oauth=' + nonce + '; HttpOnly; SameSite=Lax; Path=/api/discord; Max-Age=600' + (secure ? '; Secure' : ''));
        return json({ url: authorize(discord, state), rulesVersion: currentRules });
      }
      if (route === '/api/verify/refresh') {
        // Bounded status re-check: completes pending grants, repairs a lost
        // role, or revokes eligibility when the member left the guild. It never
        // re-posts the sign-in embed, so polling cannot spam the audit log.
        const key = 'verify:' + (clientAddress(req) || '');
        const now = Date.now();
        const attempt = attempts.get(key) || { count: 0, until: now + 600000 };
        if (attempt.until > now && attempt.count > 10) fail(429, 'Status is checked automatically. Try again shortly.');
        attempt.count++; attempt.until = now + 600000;
        attempts.set(key, attempt);
        const local = current && await db.prepare('SELECT u.id,u.ign,l.discord_id FROM users u JOIN discord_links l ON l.user_id=u.id WHERE u.id=?').get(user.id);
        if (!local) fail(401, 'Sign in to continue.');
        const result = await refreshVerification(db, discord, await verificationOptions(local), verificationDeps());
        scheduleDelivery();
        return json({ ok: true, state: result.outcome, view: await verification.verificationView(db, { discordId: local.discord_id, guildId: discord.guildId }) });
      }
      if (route === '/api/admin/verification-cutover') {
        // Explicit, owner-reviewed legacy role removal. Never a side effect of
        // deployment or setup. Requires the typed confirmation phrase.
        await requireAdmin();
        if (!discord?.botToken) fail(503, 'Discord is not configured for this deployment.');
        if (body.confirm !== 'Remove legacy roles') fail(400, 'Type "Remove legacy roles" to confirm. This removes the Verified Member Discord role from members with no website verification record.');
        const rows = (await db.prepare(`SELECT l.discord_id,l.username,
          (SELECT r.state FROM website_verification_records r WHERE r.discord_id=l.discord_id AND r.guild_id=?) AS record_state
          FROM discord_links l ORDER BY l.username LIMIT 500`).all(discord.guildId));
        const roleId = discord.roleId();
        const results = [];
        let removed = 0;
        for (const row of rows) {
          let member = null;
          try { member = await memberLookup(discord, row.discord_id); }
          catch { results.push({ discordId: row.discord_id, action: 'error', note: 'Lookup failed' }); continue; }
          if (!member || !member.roles?.includes(roleId)) continue;
          if (row.record_state === 'verified') { results.push({ discordId: row.discord_id, action: 'kept' }); continue; }
          try { await removeRoleFn(discord, row.discord_id, roleId); removed++; results.push({ discordId: row.discord_id, action: 'removed-role' }); }
          catch { results.push({ discordId: row.discord_id, action: 'error', note: 'Role removal failed' }); }
        }
        await audit(user, 'verification-cutover', removed);
        return json({ ok: true, removed, results });
      }
      if (route === '/api/logout') {
        if (token) (await db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token)));
        cookie(res, '', 0);
        return json({ ok: true });
      }
      await requireUser();
      if (route === '/api/preferences/trade-notifications') {
        if (typeof body.enabled !== 'boolean') fail(400, 'Choose whether to receive Discord updates.');
        if (body.enabled && !sendTradeMessage) fail(503, 'Discord updates are unavailable.');
        if (body.enabled) (await db.prepare('INSERT OR IGNORE INTO trade_notification_preferences VALUES(?)').run(user.id));
        else (await db.prepare('DELETE FROM trade_notification_preferences WHERE user_id=?').run(user.id));
        return json({ ok: true });
      }
      if (route === '/api/profile') {
        const ign = field(body.ign, 'Minecraft IGN', 3, 16);
        if (!/^[a-zA-Z0-9_]+$/.test(ign)) fail(400, 'Enter a valid Minecraft IGN.');
        if (user.ign) fail(409, 'Your Minecraft IGN has already been set.');
        await db.prepare('UPDATE users SET ign=? WHERE id=? AND ign=?').run(ign, user.id, '');
        return json({ ok: true });
      }
      if (!user.ign) fail(409, 'Set your Minecraft IGN in My trades first.');
      if (route === '/api/notifications/read-all') {
        await notifications.markAllRead(db, user.id);
        return json({ ok: true });
      }
      const readMatch = /^\/api\/notifications\/(\d+)\/read$/.exec(route);
      if (readMatch) {
        if (!(await notifications.markRead(db, user.id, readMatch[1]))) fail(404, 'Notification not found.');
        return json({ ok: true });
      }
      // Phase 2: private exchange arrangement. Player-reported; it never modifies
      // the accepted item terms. The author is identified, and the arrangement is
      // only labelled agreed once the other player acknowledges it.
      const arrangementMatch = /^\/api\/trades\/(\d+)\/arrangement(\/ack)?$/.exec(route);
      if (arrangementMatch) {
        const id = Number(arrangementMatch[1]);
        const acknowledge = Boolean(arrangementMatch[2]);
        (await transaction(db, async () => {
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(id));
          if (!trade || ![trade.buyer_id, trade.seller_id].includes(user.id)) fail(404, 'Trade not found.');
          if (trade.status !== 'accepted') fail(409, 'Arrangements are available for accepted trades.');
          if (trade.dispute_status === 'open') fail(409, 'This trade is paused while staff review the dispute.');
          const existing = (await db.prepare('SELECT * FROM trade_arrangements WHERE trade_id=?').get(id));
          if (acknowledge) {
            if (!existing) fail(409, 'No arrangement has been proposed yet.');
            if (existing.proposed_by === user.id) fail(403, 'Wait for the other player to acknowledge your arrangement.');
            if (existing.acknowledged_by === user.id) return;
            await db.prepare('UPDATE trade_arrangements SET acknowledged_by=?, updated=unixepoch() WHERE trade_id=?').run(user.id, id);
            await event(id, user, 'Exchange arrangement acknowledged');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:arrangement:ack`, eventType: 'arrangement', title: 'Arrangement acknowledged', body: 'The other player acknowledged the meeting arrangement.' });
            return;
          }
          const server = field(body.server, 'Proposed server or location', 2, 100);
          const meetingTime = body.meetingTime ? field(body.meetingTime, 'Meeting time', 4, 60) : null;
          const timezone = body.timezone ? field(body.timezone, 'Timezone', 2, 40) : null;
          await db.prepare(`INSERT INTO trade_arrangements(trade_id,server,meeting_time,timezone,proposed_by,acknowledged_by)
            VALUES(?,?,?,?,?,NULL) ON CONFLICT(trade_id) DO UPDATE SET server=excluded.server, meeting_time=excluded.meeting_time,
            timezone=excluded.timezone, proposed_by=excluded.proposed_by, acknowledged_by=NULL, updated=unixepoch()`)
            .run(id, server, meetingTime, timezone, user.id);
          await event(id, user, 'Exchange arrangement proposed');
          await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:arrangement`, eventType: 'arrangement', title: 'Meeting arrangement proposed', body: 'The other player proposed a meeting arrangement.' });
        }));
        scheduleDelivery();
        return json({ ok: true });
      }
      // Phase 2: mutual cancellation. Pending proposals keep the baseline
      // participant-cancel route; accepted trades with neither receipt confirmed
      // and no open dispute use request/agree/decline/withdraw. Accepted trades
      // with a confirmed receipt require dispute review instead.
      const cancellationMatch = /^\/api\/trades\/(\d+)\/cancel-request(\/(agree|decline|withdraw))?$/.exec(route);
      if (cancellationMatch) {
        const id = Number(cancellationMatch[1]);
        const decision = cancellationMatch[3];
        (await transaction(db, async () => {
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(id));
          const participant = trade && [trade.buyer_id, trade.seller_id].includes(user.id);
          if (!trade || !participant) fail(404, 'Trade not found.');
          const request = (await db.prepare('SELECT * FROM cancellation_requests WHERE trade_id=?').get(id));
          if (!decision) {
            if (trade.status !== 'accepted') fail(409, 'Only accepted trades can request cancellation.');
            if (trade.dispute_status === 'open') fail(409, 'This trade is paused while staff review the dispute.');
            if (trade.buyer_done || trade.seller_done) fail(409, 'A receipt was already confirmed. Open a dispute for staff review instead.');
            if (request?.status === 'pending') fail(409, 'A cancellation request is already waiting for the other player.');
            const reason = field(body.reason, 'Reason', 10, 1500);
            await db.prepare(`INSERT INTO cancellation_requests(trade_id,requested_by,reason,status) VALUES(?,?,?,'pending')
              ON CONFLICT(trade_id) DO UPDATE SET requested_by=excluded.requested_by, reason=excluded.reason, status='pending',
              decided_by=NULL, decided_at=NULL, created=unixepoch()`).run(id, user.id, reason);
            await event(id, user, 'Cancellation requested');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:cancel-request`, eventType: 'cancellation_request', title: 'Cancellation requested', body: 'The other player requested to cancel this accepted trade.' });
            return;
          }
          if (!request || request.status !== 'pending') fail(409, 'There is no pending cancellation request.');
          if (decision === 'withdraw') {
            if (request.requested_by !== user.id) fail(403, 'Only the player who requested the cancellation can withdraw it.');
            await db.prepare("UPDATE cancellation_requests SET status='withdrawn', decided_by=?, decided_at=unixepoch() WHERE trade_id=? AND status='pending'").run(user.id, id);
            await event(id, user, 'Cancellation request withdrawn');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:cancel-withdrawn`, eventType: 'cancellation_withdrawal', title: 'Cancellation withdrawn', body: 'The cancellation request was withdrawn. The trade continues.' });
            return;
          }
          if (request.requested_by === user.id) fail(403, 'Wait for the other player to respond to your request.');
          if (trade.status !== 'accepted') fail(409, 'This trade is no longer active.');
          if (decision === 'decline') {
            await db.prepare("UPDATE cancellation_requests SET status='declined', decided_by=?, decided_at=unixepoch() WHERE trade_id=? AND status='pending'").run(user.id, id);
            await event(id, user, 'Cancellation declined');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:cancel-decision`, eventType: 'cancellation_decision', title: 'Cancellation declined', body: 'The other player declined the cancellation request.' });
            return;
          }
          // Agree: close the trade once, preserve the agreement, evidence, and
          // history, and release the reservation safely by withdrawing the listing.
          await db.prepare("UPDATE cancellation_requests SET status='agreed', decided_by=?, decided_at=unixepoch() WHERE trade_id=? AND status='pending'").run(user.id, id);
          await db.prepare("UPDATE trades SET status='cancelled' WHERE id=? AND status='accepted'").run(id);
          await db.prepare("UPDATE listings SET status='withdrawn' WHERE id=? AND status='reserved'").run(trade.listing_id);
          await event(id, user, 'Cancellation agreed · trade closed');
          await notifyTradeEvent(id, 0, { eventKey: `trade:${id}:cancel-agreed`, eventType: 'cancellation_decision', title: 'Cancellation agreed', body: 'The trade was cancelled by mutual agreement. The listing was withdrawn; submit a fresh listing for review if you still want to trade.' });
        }));
        scheduleDelivery();
        return json({ ok: true });
      }
      const disputeAction = /^\/api\/disputes\/(\d+)\/(open|evidence|resolve)$/.exec(route);
      if (disputeAction) {
        const [, rawId, action] = disputeAction;
        const id = Number(rawId);
        (await transaction(db, async () => {
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(id));
          const participant = trade && [trade.buyer_id, trade.seller_id].includes(user.id);
          if (!trade || (!participant && user.role !== 'admin')) fail(404, 'Trade not found.');
          if (action === 'open') {
            if (!participant) fail(403, 'Only trade participants can open a dispute.');
            if (!['accepted', 'completed'].includes(trade.status) || trade.dispute_status) fail(409, 'This trade is not eligible for a new dispute.');
            if ((await db.prepare("SELECT status FROM cancellation_requests WHERE trade_id=? AND status='pending'").get(id))) fail(409, 'Decide the pending cancellation request before opening a dispute.');
            await db.prepare('INSERT INTO disputes(trade_id,opened_by,reason) VALUES(?,?,?)').run(id, user.id, field(body.reason, 'Reason', 10, 1500));
            await event(id, user, 'Dispute opened');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:dispute`, eventType: 'dispute', title: 'Dispute opened', body: 'A dispute was opened on this trade.' });
            return;
          }
          if (trade.dispute_status !== 'open') fail(409, 'This dispute is closed or unavailable.');
          if (action === 'evidence') {
            const note = field(body.note, 'Evidence note', 3, 1500);
            let link = null;
            if (body.url) {
              const raw = field(body.url, 'Evidence URL', 8, 1000);
              try { link = new URL(raw); } catch { fail(400, 'Enter a valid HTTPS evidence link.'); }
              if (link.protocol !== 'https:' || link.username || link.password) fail(400, 'Enter a valid HTTPS evidence link.');
            }
            if ((await db.prepare('SELECT count(*) AS count FROM dispute_evidence WHERE trade_id=?').get(id)).count >= 40) fail(409, 'This dispute has reached its evidence limit.');
            await db.prepare('INSERT INTO dispute_evidence(trade_id,author,note,url) VALUES(?,?,?,?)').run(id, user.id, note, link?.href || null);
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:dispute:evidence`, eventType: 'dispute_evidence', title: 'Dispute evidence added', body: 'Evidence was added to the dispute.' });
            return;
          }
          await requireAdmin();
          if (participant) fail(403, 'Another administrator must resolve a dispute involving your trade.');
          const allowed = trade.status === 'accepted' ? ['resume', 'cancel'] : ['record'];
          if (!allowed.includes(body.decision)) fail(400, 'Choose a decision available for this trade.');
          if (body.decision === 'resume' && (await db.prepare('SELECT id FROM users WHERE id IN (?,?) AND suspended=1').get(trade.buyer_id, trade.seller_id))) fail(409, 'Reinstate both players before resuming this trade.');
          const resolution = field(body.resolution, 'Decision notes', 10, 1500);
          if (body.decision === 'cancel') {
            await db.prepare("UPDATE trades SET status='cancelled' WHERE id=?").run(id);
            await db.prepare("UPDATE listings SET status='withdrawn' WHERE id=? AND status='reserved'").run(trade.listing_id);
          } else if (body.decision === 'resume') {
            await db.prepare('UPDATE trades SET buyer_done=0,seller_done=0 WHERE id=?').run(id);
          }
          (await db.prepare(`UPDATE disputes SET status='resolved', decision=?, resolution=?, resolved_by=?, resolved=unixepoch()
            WHERE trade_id=?`).run(body.decision, resolution, user.id, id));
          await audit(user, 'Dispute resolved: ' + body.decision, id);
          await event(id, user, 'Staff resolved dispute: ' + body.decision);
          await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:dispute:resolved`, eventType: 'dispute_decision', title: 'Dispute decision recorded', body: `Staff recorded a dispute decision: ${body.decision}.` });
        }));
        scheduleDelivery();
        return json({ ok: true });
      }
      if (route === '/api/listings') {
        await requireSlot(user.id);
        await requireVerified();
        const details = listingDetails(body, field);
        const wants = field(body.wants, 'Looking for', 2, 100);
        const notes = field(body.notes ?? '', 'Notes', 0, 500);
        if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 100000) fail(400, 'Enter a quantity from 1 to 100,000.');
        const image = await screenshot(body.screenshot);
        await requireUser();
        const id = (await transaction(db, async () => {
          await requireSlot(user.id);
          const { lastInsertRowid } = (await db.prepare("INSERT INTO listings(seller_id,item,category,quantity,wants,notes,status) VALUES(?,?,?,?,?,?,'review')")
            .run(user.id, details.item, body.category, body.quantity, wants, notes));
          await db.prepare('INSERT INTO listing_proofs(listing_id,details,image) VALUES(?,?,?)').run(lastInsertRowid, JSON.stringify(details), image);
          return lastInsertRowid;
        }));
        return json({ id, status: 'review' }, 201);
      }
      const listingMatch = /^\/api\/listings\/(\d+)\/(request|withdraw|hide|restore|approve|reject)$/.exec(route);
      if (listingMatch) {
        const [, rawId, action] = listingMatch;
        const id = Number(rawId);
        if (['hide', 'restore', 'approve', 'reject'].includes(action)) (await requireAdmin());
        if (action === 'request') await requireVerified();
        let offeredItems;
        if (action === 'request') {
          const available = await db.prepare("SELECT l.id FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=? AND l.status='open' AND u.suspended=0 AND l.seller_id<>?").get(id, user.id);
          if (!available) fail(409, 'This listing is unavailable.');
          offeredItems = await validateOffer(body, { db, actorId: user.id, field });
        }
        const newTrade = (await transaction(db, async () => {
          const listing = (await db.prepare(`SELECT l.*,u.suspended,p.details FROM listings l JOIN users u ON u.id=l.seller_id
            LEFT JOIN listing_proofs p ON p.listing_id=l.id WHERE l.id=?`).get(id));
          if (!listing) fail(404, 'Listing not found.');
          if (action === 'request') {
            if (listing.status !== 'open' || listing.suspended || !listing.details) fail(409, 'This listing is unavailable.');
            if (listing.seller_id === user.id) fail(400, 'Choose another player’s listing.');
            if ((await db.prepare("SELECT id FROM trades WHERE listing_id=? AND buyer_id=? AND status IN ('pending','accepted')").get(id, user.id))) fail(409, 'You already requested this listing.');
            const tradeId = (await db.prepare('INSERT INTO trades(listing_id,buyer_id,offer) VALUES(?,?,?)').run(id, user.id, offerSummary(offeredItems.map(item => item.details)))).lastInsertRowid;
            await saveOffer(db, tradeId, 0, user.id, offeredItems);
            await event(tradeId, user, 'Offer sent · v0');
            await notifyTradeEvent(tradeId, user.id, { eventKey: `trade:${tradeId}:offer`, eventType: 'offer', title: 'New offer received', body: 'A new offer is waiting for you.' });
            return tradeId;
          } else if (action === 'approve' || action === 'reject') {
            if (listing.status !== 'review' || listing.suspended || !listing.details) fail(409, 'This listing cannot be reviewed.');
            if (action === 'approve' && body.proofReviewed !== true) fail(400, 'Confirm you checked the item, eligibility, and screenshot.');
            const note = action === 'reject' ? field(body.reason, 'Rejection reason', 3, 300) : null;
            await db.prepare('UPDATE listing_proofs SET review_note=? WHERE listing_id=?').run(note, id);
            await db.prepare('UPDATE listings SET status=? WHERE id=?').run(action === 'approve' ? 'open' : 'rejected', id);
            if (action === 'approve') (await db.prepare('INSERT INTO listing_feed(listing_id) VALUES(?)').run(id));
            await audit(user, action === 'approve' ? 'Listing approved' : 'Listing rejected', id);
            await notifySellerEvent(listing.seller_id, action === 'approve'
              ? { eventKey: `listing:${id}:approved`, eventType: 'listing_approved', title: 'Listing approved', body: 'Your listing was approved and is now public.', link: `/#market?listing=${id}` }
              : { eventKey: `listing:${id}:rejected`, eventType: 'listing_rejected', title: 'Listing rejected', body: 'Your listing was rejected. Check the review note in My trades.', link: '/#desk' });
          } else if (action === 'withdraw') {
            if (listing.seller_id !== user.id) fail(403, 'This listing belongs to another player.');
            if (!['open', 'review'].includes(listing.status)) fail(409, 'Only open or submitted listings can be withdrawn.');
            await hideListing(id, 'withdrawn');
          } else if (action === 'hide') {
            if (!['open', 'reserved'].includes(listing.status)) fail(409, 'Only active listings can be hidden.');
            if ((await db.prepare(`SELECT t.id FROM trades t LEFT JOIN disputes d ON d.trade_id=t.id
              WHERE t.listing_id=? AND (d.status='open' OR (t.status='accepted' AND (t.buyer_done=1 OR t.seller_done=1)))`).get(id))) fail(409, 'Use dispute review to resolve the recorded exchange before hiding this listing.');
            await hideListing(id);
            await audit(user, 'Listing hidden', id);
          } else {
            if (listing.status !== 'hidden' || listing.suspended || !listing.details) fail(409, 'Only previously approved listings from active members can be restored.');
            await requireSlot(listing.seller_id);
            await db.prepare("UPDATE listings SET status='open' WHERE id=?").run(id);
            await audit(user, 'Listing restored', id);
          }
        }));
        if (newTrade || action === 'approve' || action === 'reject') scheduleDelivery();
        if (action === 'approve') background(flushListingFeed().catch(() => console.error('Could not process the Trade Radar queue.')));
        return json({ ok: true, ...(newTrade ? { tradeId: newTrade } : {}) });
      }
      const tradeMatch = /^\/api\/trades\/(\d+)\/(accept|decline|counter|cancel|confirm|moderate)$/.exec(route);
      if (tradeMatch) {
        const [, rawId, action] = tradeMatch;
        const id = Number(rawId);
        if (action === 'moderate') (await requireAdmin());
        if (action === 'counter') await requireVerified();
        let offeredItems;
        if (action === 'counter' || action === 'accept') {
          const pending = await db.prepare(allTrades + ' WHERE t.id=?').get(id);
          if (!pending || ![pending.seller_id, pending.buyer_id].includes(user.id)) fail(403, 'This trade belongs to other players.');
          if (pending.status !== 'pending' || pending.proposer === user.id) fail(409, 'It is the other player’s turn to respond.');
          if (body.version !== pending.version) fail(409, 'The offer changed. Refresh the trade room before responding.');
          if (pending.dispute_status === 'open') fail(409, 'This trade is paused while staff review the dispute.');
          if (action === 'counter') offeredItems = await validateOffer(body, { db, tradeId: id, latestVersion: pending.version, actorId: user.id, field });
          else {
            if (body.agreementReviewed !== true) fail(400, 'Review both sides and their screenshots before accepting.');
            if (!(await db.prepare('SELECT 1 FROM trade_offer_items WHERE trade_id=? AND version=?').get(id, pending.version))) fail(409, 'This older offer needs structured items and screenshots. Send a counteroffer to continue.');
            const accounts = await db.prepare('SELECT u.id,u.ign,u.suspended,l.discord_id FROM users u LEFT JOIN discord_links l ON l.user_id=u.id WHERE u.id IN (?,?)').all(pending.seller_id, pending.buyer_id);
            if (accounts.length !== 2 || accounts.some(account => account.suspended || !account.ign || !account.discord_id)) fail(403, 'Both players need active Discord-linked accounts and a Minecraft IGN.');
            const missingVerification = (await Promise.all(accounts.map(account => hasWebsiteVerification(account.discord_id)))).some(verified => !verified);
            if (missingVerification) fail(403, 'Both players must complete website verification before a request can be accepted.');
            let verified;
            try { verified = await Promise.all(accounts.map(account => checkMember(discord, account.discord_id))); }
            catch { fail(503, 'Discord eligibility could not be checked. Try again shortly.'); }
            if (!verified.every(Boolean)) fail(403, 'Both players must currently have BananaSMP Discord trading access.');
          }
        }
        (await transaction(db, async () => {
          const trade = (await db.prepare(allTrades + ' WHERE t.id=?').get(id));
          if (!trade) fail(404, 'Trade not found.');
          const seller = trade.seller_id === user.id;
          if (action !== 'moderate' && !seller && trade.buyer_id !== user.id) fail(403, 'This trade belongs to other players.');
          if (trade.dispute_status === 'open') fail(409, 'This trade is paused while staff review the dispute.');
          if (!['pending', 'accepted'].includes(trade.status)) fail(409, 'This request is closed.');
          if (['accept', 'decline', 'counter'].includes(action)) {
            if (trade.proposer === user.id || trade.status !== 'pending') fail(409, 'It is the other player’s turn to respond.');
            if (body.version !== trade.version) fail(409, 'The offer changed. Refresh the trade room before responding.');
            if (action === 'counter') {
              if (trade.version >= 50) fail(409, 'This trade reached its counteroffer limit.');
              await saveOffer(db, id, trade.version + 1, user.id, offeredItems);
              await event(id, user, 'Counteroffer v' + (trade.version + 1));
              await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:counter:${trade.version + 1}`, eventType: 'counteroffer', title: 'Counteroffer received', body: 'A counteroffer is waiting for you.' });
              return;
            }
            if (action === 'accept') {
              const listing = (await db.prepare(allListings + ' WHERE l.id=?').get(trade.listing_id));
              if (!listing.details) fail(409, 'The listing must be resubmitted with screenshot evidence.');
              await requireUser();
              const accounts = await db.prepare('SELECT u.id,u.ign,u.suspended,l.discord_id FROM users u JOIN discord_links l ON l.user_id=u.id WHERE u.id IN (?,?)').all(trade.seller_id, trade.buyer_id);
              if (accounts.length !== 2 || accounts.some(account => account.suspended || !account.ign)) fail(403, 'Both players must have active trading accounts.');
              const proofs = await db.prepare('SELECT position,details,image,submitted_by FROM trade_offer_items WHERE trade_id=? AND version=? ORDER BY position').all(id, trade.version);
              if (!proofs.length) fail(409, 'This older offer needs structured items and screenshots.');
              const { changes } = (await db.prepare("UPDATE listings SET status='reserved' WHERE id=? AND status='open'").run(trade.listing_id));
              if (!changes) fail(409, 'The listing is already reserved or unavailable.');
              const freezeEvidence = async (side, position, bytes) => {
                const image = Buffer.from(bytes);
                const sha256 = createHash('sha256').update(image).digest('hex');
                await db.prepare('INSERT INTO trade_agreement_evidence(trade_id,side,position,image,sha256) VALUES(?,?,?,?,?)').run(id, side, position, image, sha256);
                return { screenshot: `/api/trades/${id}/agreement/${side}/${position}/screenshot`, sha256 };
              };
              const sellerEvidence = await db.prepare('SELECT image FROM listing_proofs WHERE listing_id=?').get(listing.id);
              const sellerItem = { ...JSON.parse(listing.details), category: listing.category, quantity: listing.quantity, notes: listing.notes,
                reviewStatus: 'Staff-reviewed listing', ...await freezeEvidence('seller', 0, sellerEvidence.image) };
              const buyerItems = [];
              for (const proof of proofs) buyerItems.push({ ...JSON.parse(proof.details), submittedBy: proof.submitted_by,
                submittedByIgn: accounts.find(account => account.id === proof.submitted_by)?.ign || 'Trade participant',
                reviewStatus: 'Submitted · not staff-reviewed', ...await freezeEvidence('buyer', proof.position, proof.image) });
              const accountSnapshot = accountId => { const account = accounts.find(account => account.id === accountId); return { id: account.id, ign: account.ign, discordId: account.discord_id }; };
              (await db.prepare('INSERT INTO trade_snapshots VALUES(?,?)').run(id, JSON.stringify({
                ...JSON.parse(listing.details), item: listing.item, category: listing.category, quantity: listing.quantity,
                notes: listing.notes, seller: trade.seller, buyer: trade.buyer, offer: trade.current_offer, version: trade.version,
                screenshot: sellerItem.screenshot, schemaVersion: 2, tradeId: id, acceptedAt: Math.floor(Date.now() / 1000),
                acceptedBy: user.id, participants: { seller: accountSnapshot(trade.seller_id), buyer: accountSnapshot(trade.buyer_id) },
                sellerItems: [sellerItem], buyerItems,
              })));
              const competing = await db.prepare("SELECT id FROM trades WHERE listing_id=? AND id<>? AND status='pending'").all(trade.listing_id, id);
              for (const request of competing) await event(request.id, user, 'Request closed: seller accepted another offer');
              await db.prepare("UPDATE trades SET status='declined' WHERE listing_id=? AND id<>? AND status='pending'").run(trade.listing_id, id);
              for (const request of competing) await notifyTradeEvent(request.id, 0, { eventKey: `trade:${request.id}:closed`, eventType: 'cancellation', title: 'Request closed', body: 'The seller accepted another offer on this listing.' });
              await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:accept`, eventType: 'acceptance', title: 'Offer accepted', body: 'Your offer was accepted. Arrange the exchange in Minecraft.' });
            }
            await db.prepare('UPDATE trades SET status=? WHERE id=?').run(action === 'accept' ? 'accepted' : 'declined', id);
            await event(id, user, action === 'accept' ? 'Offer accepted · v' + trade.version : 'Offer declined');
            if (action === 'decline') await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:decline`, eventType: 'decline', title: 'Offer declined', body: 'Your offer on this trade was declined.' });
          } else if (action === 'confirm') {
            if (trade.status !== 'accepted') fail(409, 'Accept the trade before confirming delivery.');
            if ((await db.prepare("SELECT status FROM cancellation_requests WHERE trade_id=? AND status='pending'").get(id))) fail(409, 'Decide the pending cancellation request before confirming receipt.');
            const side = seller ? 'seller_done' : 'buyer_done';
            const stamp = seller ? 'seller_confirmed_at' : 'buyer_confirmed_at';
            if (trade[side]) return;
            const now = Math.floor(Date.now() / 1000);
            await db.prepare(`UPDATE trades SET ${side}=1, ${stamp}=? WHERE id=?`).run(now, id);
            await event(id, user, 'Receipt confirmed: I received the agreed items');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:receipt:${seller ? 'seller' : 'buyer'}`, eventType: 'receipt', title: 'Receipt confirmed', body: 'The other player confirmed: I received the agreed items.' });
            if (seller ? trade.buyer_done : trade.seller_done) {
              await db.prepare("UPDATE trades SET status='completed' WHERE id=?").run(id);
              await db.prepare("UPDATE listings SET status='completed' WHERE id=?").run(trade.listing_id);
              await event(id, user, 'Trade completed');
              await notifyTradeEvent(id, 0, { eventKey: `trade:${id}:completed`, eventType: 'completion', title: 'Trade completed', body: 'Both players confirmed the exchange. The trade is complete.' });
            }
          } else {
            if (trade.status === 'accepted') fail(409, 'Accepted trades are cancelled through the mutual cancellation request or dispute review.');
            if (action === 'moderate' && trade.status !== 'pending') fail(409, 'Only pending requests can be moderated directly.');
            await db.prepare("UPDATE trades SET status='cancelled' WHERE id=?").run(id);
            if (action === 'moderate') (await audit(user, 'Trade cancelled', id));
            await event(id, user, 'Trade cancelled');
            await notifyTradeEvent(id, user.id, { eventKey: `trade:${id}:cancelled`, eventType: 'cancellation', title: 'Trade cancelled', body: 'This trade request was cancelled.' });
          }
        }));
        scheduleDelivery();
        return json({ ok: true });
      }
      const accountMatch = /^\/api\/admin\/users\/(\d+)\/(suspend|reinstate)$/.exec(route);
      if (accountMatch) {
        await requireAdmin();
        const id = Number(accountMatch[1]);
        const suspend = accountMatch[2] === 'suspend';
        (await transaction(db, async () => {
          const account = (await db.prepare('SELECT u.id,l.discord_id FROM users u LEFT JOIN discord_links l ON l.user_id=u.id WHERE u.id=?').get(id));
          if (!account || adminIds.has(account.discord_id)) fail(403, 'Only member accounts can be moderated here.');
          await db.prepare('UPDATE users SET suspended=? WHERE id=?').run(Number(suspend), id);
          if (suspend) {
            await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
            const held = `SELECT t.id FROM trades t LEFT JOIN disputes d ON d.trade_id=t.id
              WHERE d.status='open' OR (t.status='accepted' AND (t.buyer_done=1 OR t.seller_done=1))`;
            for (const listing of (await db.prepare(`SELECT id FROM listings WHERE seller_id=? AND status IN ('open','reserved')
              AND id NOT IN (SELECT listing_id FROM trades WHERE id IN (${held}))`).all(id))) (await hideListing(listing.id));
            (await db.prepare(`UPDATE listings SET status='open' WHERE status='reserved' AND id IN
              (SELECT listing_id FROM trades WHERE buyer_id=? AND status='accepted' AND id NOT IN (${held}))`).run(id));
            await db.prepare(`UPDATE trades SET status='cancelled' WHERE buyer_id=? AND status IN ('pending','accepted') AND id NOT IN (${held})`).run(id);
          }
          await audit(user, suspend ? 'Member suspended' : 'Member reinstated', id);
        }));
        return json({ ok: true });
      }
      fail(404, 'Endpoint not found.');
    } catch (error) {
      if (!error.status) console.error('Marketplace request failed:', error.code || error.name);
      if (!res.headersSent) json({ error: error.status ? error.message : 'Something went wrong.' }, error.status || 500);
      else res.end();
    }
  };
  return { handler, flushListingFeed, flushDeliveries, feedEnabled: Boolean(postListing) };
}

function createServer(options) {
  const { handler, flushListingFeed, flushDeliveries, feedEnabled } = createHandler(options);
  const server = http.createServer(handler);
  const worker = () => {
    void flushListingFeed().catch(() => console.error('Could not process the Trade Radar queue.'));
    void flushDeliveries().catch(() => console.error('Could not process the notification outbox.'));
  };
  let timer;
  server.once('listening', () => {
    timer = setInterval(worker, 15000);
    timer.unref();
  });
  server.once('close', () => clearInterval(timer));
  return server;
}
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const port = Number(process.env.WEB_PORT || 3000);
  createServer({ discord: configuredDiscord() }).listen(port, '127.0.0.1', () => console.log(`BananaSMP marketplace listening on http://127.0.0.1:${port}`));
}
module.exports = { createServer, createHandler };
