import catalog from '../catalog';

const main = document.querySelector('#main');
const dialog = document.querySelector('#dialog');
const dialogBody = document.querySelector('#dialog-body');
const categories = ['All items', 'Rare', 'P2W'];
let user;
let listingGrid;
let playerProfile;
let headingAnimations;
let offerEditor;
let discordEnabled;
let discordLink;
let tradeNotifications;
let notificationsAvailable;
let rulesVersion = 1;
let reviewListings = [];
let adminSection = 'Item review';
let selectedCategory = 'All items';
let version = 0;
let noticeTimer;
let heroMedia = null;

// Mounts the cinematic hero background: poster first, video layered above only
// when playback is allowed (reduced motion and data saver see the poster).
function mountHero() {
  const heroArt = main.querySelector('#hero-art');
  if (!heroArt) return;
  disposeHeroMedia();
  heroMedia = mountHeroVideo(heroArt.querySelector('.hero-media-slot'));
}

function disposeHeroMedia() {
  heroMedia?.dispose();
  heroMedia = null;
}
// Phase 2: lightweight visibility-aware polling state.
let pollTimer = null;
let pollFailures = 0;
let lastTradeCheck = null;
const POLL_INTERVAL = 12000;
const POLL_MAX = 120000;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = id => `<svg aria-hidden="true" viewBox="0 0 32 32"><use href="/items.svg#${id}"></use></svg>`;
const button = (label, action, style = 'outline') => `<button type="button" class="${style}" data-action="${action}">${label}</button>`;
const empty = text => `<div class="empty">${text}</div>`;
const tag = text => `<span class="tag">${escapeHtml(text)}</span>`;
const go = route => { if (location.pathname === '/' && location.hash === '#' + route) render(); else location.assign('/#' + route); };

async function api(path, body) {
  // Request boundary: only a plain object of primitives is ever serialized.
  // A DOM node or React event arriving here (a UI bug) fails with a clear
  // message instead of a circular-structure serialization error.
  if (body !== undefined && !plainObject(body)) {
    throw new Error('This action could not be sent (invalid request data). Reload the page and try again.');
  }
  const response = await fetch('/api' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function notify(message) {
  const el = document.querySelector('#notice');
  clearTimeout(noticeTimer);
  el.textContent = message;
  noticeTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}
function openDialog(title, content) {
  offerEditor?.dispose();
  offerEditor = undefined;
  document.querySelector('#dialog-title').textContent = title;
  dialogBody.innerHTML = content;
  if (!dialog.open) dialog.showModal();
}
function form(title, fields, submit, handler, extra = '') {
  openDialog(title, `<form>${fields}<p class="form-error" role="alert" hidden></p><button class="primary">${submit}</button></form>${extra}`);
  const element = dialogBody.querySelector('form');
  element.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = element.querySelector('button');
    const errorElement = element.querySelector('.form-error');
    errorElement.hidden = true;
    submitButton.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(element)));
      dialog.close();
      await render();
    } catch (error) {
      errorElement.textContent = error.message;
      errorElement.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}
async function auth(options = {}) {
  try { location.assign((await api('/discord/login', options)).url); } catch (error) { notify(error.message); }
}
function setIgn() {
  form('Set your Minecraft IGN', '<label>Minecraft IGN<input name="ign" pattern="[A-Za-z0-9_]{3,16}" required maxlength="16"></label><p class="muted">Your IGN is self-reported and appears on your listings.</p>', 'Save IGN', values => api('/profile', values));
}
// Website-only verification. The rules acceptance and the bot's role grant
// happen on this page; nothing in Discord grants the role anymore.
const VERIFY_RULES = [
  'No duped items, exploits, scams, impersonation, spam, or unsolicited advertising.',
  'Never share passwords, login codes, recovery codes, or tokens.',
  'No public doxxing or accusations; contact a real Moderator through their profile.',
  'Requests and escrow use this website, not Discord tickets or per-trade channels.',
  'A middleman holds assets and can still lose or misuse them. This service is not a guarantee against loss.',
  'Discord verification cannot detect or prevent duplicated Minecraft items.',
];
const VERIFY_REASONS = {
  not_member: 'Join the BananaSMP Discord server, then sign in again.',
  screening: 'Complete Discord membership screening, then sign in again.',
  timeout: 'Your Discord timeout must expire before verification can continue.',
  bot: 'Bot accounts cannot verify.',
  account_age: 'Your Discord account must be at least 24 hours old.',
  member_age: 'You joined less than 10 minutes ago. Stay in the server, then re-check.',
  suspended: 'Your marketplace access is suspended by staff.',
  role_failed: 'The Verified Member role could not be granted right now. Use Re-check status.',
  revoked: 'Your website verification is no longer active. Sign in again.',
  missing_record: 'Sign in with Discord to verify.',
};
const VERIFY_STATUS = {
  none: ['Not started', 'Read the rules, accept them, and sign in with Discord. The Verified Member role is granted automatically once you meet the requirements.'],
  authenticated_pending: ['Verification in progress', 'Discord is checking the requirements. This page updates automatically.'],
  role_assignment_pending: ['Verification in progress', 'The bot is granting Verified Member. This page updates automatically.'],
  role_assignment_failed: ['Role assignment failed', 'Your sign-in is recorded, but Discord could not grant the Verified Member role right now (bot permissions, role hierarchy, or a temporary Discord outage). Use Re-check status to retry.'],
  verified: ['Verified Member', 'Verification complete. Every sign-in is recorded in the staff verification channel.'],
  blocked: ['Not eligible yet', ''],
  revoked: ['Verification inactive', VERIFY_REASONS.revoked],
};
const AUDIT_DELIVERY = {
  pending: ' The staff audit notification for this sign-in is still being delivered.',
  failed: ' The staff audit notification for this sign-in is waiting for its next delivery attempt.',
  rate_limited: ' The staff audit notification is waiting for a Discord rate limit to clear.',
  exhausted: ' The staff audit notification could not be delivered; staff can still see the sign-in record on the website.',
  permanent: ' The staff audit notification could not be delivered; staff can still see the sign-in record on the website.',
};
let verifyTimer = null;
let verifyFailures = 0;
let verifyInterval = 20000;
let verifyRulesVersion = 1;
function eligibleText(eligibleAt) {
  if (!eligibleAt) return '';
  return ` Re-check around ${new Date(eligibleAt * 1000).toLocaleString()} in your timezone.`;
}
function verifyStatus(session) {
  const view = session?.verification || { state: 'none', message: null, reason: null, eligibleAt: null, delivery: null };
  const [title, body] = VERIFY_STATUS[view.state] || VERIFY_STATUS.none;
  // A failed audit delivery never makes a verified member look unverified, but
  // it does stay visible so staff know the channel post did not arrive.
  const auditNote = view.state === 'verified' && view.delivery && view.delivery !== 'sent' ? (AUDIT_DELIVERY[view.delivery] || '') : '';
  const detail = view.state === 'blocked'
    ? (VERIFY_REASONS[view.reason] || view.message || 'You are not eligible yet.') + eligibleText(view.eligibleAt)
    : body + auditNote;
  return { title, detail: detail || body, verified: view.state === 'verified', view };
}
function stopVerifyPolling() { clearTimeout(verifyTimer); verifyTimer = null; verifyFailures = 0; verifyInterval = 20000; }
async function verifyRefresh(quiet = true) {
  try {
    const result = await api('/verify/refresh', {});
    verifyFailures = 0;
    verifyInterval = 20000;
    if (result.view?.state === 'verified') { stopVerifyPolling(); await render(); notify('Verification complete.'); }
    else if (!quiet) notify(result.view?.message || 'Verification is still in progress.');
    return result;
  } catch (error) {
    verifyFailures += 1;
    // Bounded polling: escalate the interval and stop after five consecutive
    // failures so a persistent API outage never spins forever. The manual
    // Re-check button stays available and uses the authenticated session.
    verifyInterval = Math.min(verifyInterval * 2, 60000);
    if (verifyTimer && verifyFailures >= 5) { stopVerifyPolling(); if (!quiet) notify('Automatic checks stopped after repeated failures. Use Re-check status.'); }
    if (!quiet) notify(error.message);
  }
}
function renderVerify(session) {
  stopPolling();
  const status = verifyStatus(session);
  const rules = VERIFY_RULES.map(rule => `<li>${escapeHtml(rule)}</li>`).join('');
  verifyRulesVersion = session?.rulesVersion || 1;
  const signedIn = Boolean(session?.user);
  const signIn = signedIn
    ? `${button('Re-check status', 'verify-refresh', 'primary')}${status.verified ? '' : ` <button type="button" class="outline" data-action="verify-signout">Sign out</button>`}`
    : `<label class="check-label"><input type="checkbox" name="rules" required> I have read and accept the server rules</label>` +
      `<div class="section-head">${button('Sign in with Discord', 'verify-login', 'primary')}</div>` +
      `<p class="muted">Discord account at least 24 hours old · joined the server at least 10 minutes ago · screening complete · no timeout. Unverified members can sign in; eligibility is checked on the website.</p>`;
  main.innerHTML = `<div class="page-head"><div class="eyebrow">BananaSMP Discord</div><h1 class="page-title">Verification</h1></div>
    <div class="rows">
      <div class="verify-status"><h2>${escapeHtml(status.title)}</h2><p class="muted">${escapeHtml(status.detail)}</p></div>
      <div class="verify-rules"><h2>Server rules (v${verifyRulesVersion})</h2><ul>${rules}</ul>
        <p class="muted">Verification grants Discord access only. It does not verify email, phone, identity, or ownership of a Minecraft account; your IGN is self-reported.</p></div>
      <div class="verify-signin">${signIn}</div>
    </div>`;
  const checkbox = main.querySelector('input[name="rules"]');
  const loginButton = main.querySelector('[data-action="verify-login"]');
  if (checkbox && loginButton) {
    loginButton.disabled = true;
    checkbox.addEventListener('change', () => { loginButton.disabled = !checkbox.checked; });
  }
  if (!status.verified && signedIn && !verifyTimer) {
    // Escalating interval with a cap: 20s → 40s → 60s, reset after any
    // successful check. Cleared by render() on every route change, so timers
    // never leak past this page.
    const tick = () => {
      if (document.hidden) return;
      verifyRefresh(true).finally(() => {
        if (verifyTimer) verifyTimer = setTimeout(tick, verifyInterval);
      });
    };
    verifyTimer = setTimeout(tick, verifyInterval);
  }
  if (status.verified) stopVerifyPolling();
  // Keep the live state honest on every visit: a reload after the callback
  // must not show a stale pending state when the record already completed.
  if (signedIn && !status.verified) verifyRefresh(true);
}
function createListing() {
  if (!user) return go('verify');
  if (!user.ign) return setIgn();
  form('Submit an item for review', `<label>Category<select name="category"><option>Rare</option><option>P2W</option></select></label>
    <label>Find an item<input type="search" id="catalog-search" placeholder="Search the rare item catalog"></label>
    <div class="item-selection"><svg aria-hidden="true" viewBox="0 0 32 32"><use id="catalog-icon" href="/items.svg#elytra"></use></svg>
    <label>Catalog item<select name="catalogId" required></select></label></div>
    <label id="other-item" hidden>Item name<input name="item" minlength="2" maxlength="64" placeholder="Exact in-game name"></label>
    <label>Custom name<input name="customName" maxlength="64" placeholder="Optional"></label>
    <label>Quantity<input type="number" name="quantity" min="1" max="100000" value="1" required></label>
    <label>Enchantments<textarea name="enchantments" maxlength="1200" placeholder="One per line, for example Sharpness:5"></textarea></label>
    <label>Durability remaining (%)<input type="number" name="durability" min="0" max="100" placeholder="Optional"></label>
    <label>Rarity or shop origin<textarea name="rarityReason" required minlength="10" maxlength="300" placeholder="Explain how it was obtained or identify the shop item"></textarea></label>
    <label>Looking for<input name="wants" required minlength="2" maxlength="100" placeholder="What would you trade it for?"></label>
    <p class="ask-preview" aria-live="polite" hidden></p>
    <label>Notes<textarea name="notes" maxlength="500" placeholder="Optional trade terms"></textarea></label>
    <label>Item screenshot<input name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" required></label>
    <p class="muted">Show the item and its tooltip in your inventory. Make the quantity, name and enchantments readable. PNG, JPEG or WebP up to 2 MB. Approved screenshots become public.</p>`,
    'Submit for review', async ({ screenshot, enchantments, durability, ...values }) => {
      if (!(screenshot instanceof File) || !screenshot.size || screenshot.size > 2 * 1024 * 1024) throw new Error('Attach a screenshot up to 2 MB.');
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('The screenshot could not be read.'));
        reader.readAsDataURL(screenshot);
      });
      const parsed = enchantments.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const match = line.match(/^(.+):\s*(\d+)$/);
        if (!match) throw new Error('Enter each enchantment as Name:Level, one per line.');
        return { name: match[1].trim(), level: Number(match[2]) };
      });
      await api('/listings', { ...values, screenshot: image, enchantments: parsed, durability: durability === '' ? null : Number(durability), quantity: Number(values.quantity) });
      notify('Submitted. Staff will check eligibility and the screenshot before publishing.');
    });
  const category = dialogBody.querySelector('[name="category"]');
  const search = dialogBody.querySelector('#catalog-search');
  const select = dialogBody.querySelector('[name="catalogId"]');
  const custom = dialogBody.querySelector('#other-item');
  // Trade calculator preview: while the seller types the ask, this shows the
  // total (or the per-item rate) implied by their own wording and the
  // quantity. It stays quiet while the wording means nothing computable, and
  // never replaces the ask text — which is the recorded, binding term.
  const wantsField = dialogBody.querySelector('[name="wants"]');
  const quantityField = dialogBody.querySelector('[name="quantity"]');
  const askPreview = dialogBody.querySelector('.ask-preview');
  function syncAskPreview() {
    const calc = summarizeAsk(wantsField.value, quantityField.value);
    askPreview.hidden = !calc;
    askPreview.textContent = calc
      ? `Calculator: ${calc.text} — worked out from your text; the ask you write stays the binding term.`
      : '';
  }
  wantsField.addEventListener('input', syncAskPreview);
  quantityField.addEventListener('input', syncAskPreview);
  syncAskPreview();
  function syncSelection() {
    const entry = catalog.find(item => item.id === select.value);
    custom.hidden = !entry?.custom;
    custom.querySelector('input').required = Boolean(entry?.custom);
    dialogBody.querySelector('#catalog-icon').setAttribute('href', '/items.svg#' + (entry?.icon || 'book'));
  }
  function filterCatalog() {
    const previous = select.value;
    search.disabled = category.value === 'P2W';
    const list = catalog.filter(item => search.disabled ? item.id === 'server-item' : item.name.toLowerCase().includes(search.value.trim().toLowerCase()));
    select.replaceChildren(...list.map(item => new Option(item.name, item.id)));
    if (list.some(item => item.id === previous)) select.value = previous;
    syncSelection();
  }
  search.addEventListener('input', filterCatalog);
  category.addEventListener('change', filterCatalog);
  select.addEventListener('change', syncSelection);
  filterCatalog();
}
function itemFacts(details) {
  if (!details) return '';
  const enchantments = (details.enchantments || []).map(({ name, level }) => `${escapeHtml(name)} ${level}`).join(' · ');
  return `<div class="item-facts">
    ${details.customName ? `<p><strong>Custom name</strong> ${escapeHtml(details.customName)}</p>` : ''}
    ${enchantments ? `<p><strong>Enchantments</strong> ${enchantments}</p>` : ''}
    ${details.durability != null ? `<p><strong>Durability</strong> ${escapeHtml(details.durability)}%</p>` : ''}
    <p><strong>Rarity or shop origin</strong> ${escapeHtml(details.rarityReason || 'Not recorded for this legacy agreement.')}</p></div>`;
}
const screenshotImage = id => `<a href="/api/listings/${id}/screenshot" target="_blank" rel="noopener"><img class="item-screenshot" src="/api/listings/${id}/screenshot" alt="Seller’s in-game item screenshot"></a>`;
function listingDetails(listing) {
  openDialog(listing.item, `<p>${listing.quantity.toLocaleString()} available · ${escapeHtml(listing.category)}</p>
    <div class="want"><small>Looking for</small>${escapeHtml(listing.wants)}</div>
    ${listing.details ? itemFacts(listing.details) + screenshotImage(listing.id) : ''}
    ${listing.notes ? `<p>${escapeHtml(listing.notes)}</p>` : ''}
    <p class="muted">Seller IGN · ${escapeHtml(listing.seller)} (self-reported)</p>
    ${user?.id === listing.seller_id ? '<p class="muted">Manage this listing in My trades.</p>' : button('Make an offer', 'offer', 'primary')}`);
  dialogBody.querySelector('[data-action="offer"]')?.addEventListener('click', () => {
    if (!user) return go('verify');
    if (!user.ign) return setIgn();
    showOfferEditor(listing);
  });
}
function showOfferEditor(listing, room) {
  const currentItems = room?.proposals.find(proposal => proposal.version === room.trade.version)?.items || [];
  openDialog(room ? 'Send a structured counteroffer' : 'Make an item offer', '<div id="offer-editor"></div>');
  offerEditor = mountOfferBuilder(dialogBody.querySelector('#offer-editor'), {
    initialItems: currentItems, sellerDescription: `${listing.quantity} × ${listing.item}`,
    onSubmit: async payload => {
      const response = room ? await api(`/trades/${room.trade.id}/counter`, { ...payload, version: room.trade.version }) :
        await api(`/listings/${listing.id}/request`, payload);
      dialog.close();
      if (room) await render();
      else location.assign('/trade/' + response.tradeId);
    },
  });
}
function marketplace(listings) {
  const records = listings.map(listing => {
    const details = JSON.parse(listing.details);
    return { ...listing, details, icon: catalog.find(item => item.id === details.catalogId)?.icon };
  });
  main.innerHTML = `<section class="hero">
    <div class="hero-art" id="hero-art" aria-hidden="true"><div class="hero-media-slot"></div></div>
    <div class="hero-copy"><div class="eyebrow"><i class="dot"></i> BananaSMP Trading Hub · Minecraft Java</div>
    <div data-reveal-heading="hero"></div>
    <p>A player-to-player marketplace for rare gear and P2W items. Every listing is submitted with an in-game screenshot and reviewed by BananaSMP staff before publication.</p>
    <div class="actions"><a class="primary" href="#browse">Browse items ↓</a>${button('Trade calculator', 'calc', 'outline')}${button('+ Post a listing', 'new')}${user ? '' : button('Sign in with Discord', 'login')}</div></div></section>
    <section class="section-panel" data-reveal>
    <div class="section-head" id="browse"><div><div class="eyebrow">The exchange</div><div data-reveal-heading="Browse listings"></div>
    <p>${listings.length ? 'Find your next trade by item, category, or seller.' : 'Approved listings from verified members appear here.'}</p></div></div>
    ${listings.length ? `<div class="controls"><input id="search" type="search" aria-label="Search listings" placeholder="Search items, offers, or players…">
    <select id="sort" aria-label="Sort listings"><option value="new">Newest first</option><option value="name">Item name</option><option value="quantity">Most available</option></select></div>
    <div class="controls"><input id="enchant" type="search" aria-label="Enchantment" placeholder="Enchantment, e.g. Sharpness">
    <input id="enchant-level" type="number" min="1" max="255" aria-label="Minimum enchantment level" placeholder="Minimum level"></div>
    <div class="tabs" aria-label="Filter by category">${categories.map(c => `<button class="tab" data-category="${c}" aria-pressed="${c === selectedCategory}">${c}</button>`).join('')}</div>` : ''}
    <div id="listing-results" aria-live="polite"></div>
    </section>
    <section class="how-works panel-section" id="how-it-works" data-reveal>
      <div class="section-head"><div><div class="eyebrow">The process</div><div data-reveal-section="How trading works"></div>
      <p>From sign-in to confirmed receipt.</p></div></div>
      <ol class="steps">
        <li data-reveal data-reveal-delay="0"><strong>01 · Sign in and verify</strong><span>Read the rules on the verification page and sign in with Discord. The bot grants Verified Member once your account meets the requirements.</span></li>
        <li data-reveal data-reveal-delay="90"><strong>02 · Post or browse</strong><span>Submit a Rare or P2W listing with an in-game screenshot, or browse approved listings posted by verified members.</span></li>
        <li data-reveal data-reveal-delay="180"><strong>03 · Negotiate</strong><span>Make a structured offer with its own screenshots, or counter. Only the recorded terms are binding.</span></li>
        <li data-reveal data-reveal-delay="270"><strong>04 · Exchange in Minecraft</strong><span>Once accepted, the listing is reserved and the agreement is frozen. Meet in-game and trade by hand.</span></li>
        <li data-reveal data-reveal-delay="360"><strong>05 · Confirm receipt</strong><span>Each player confirms “I received the agreed items.” Disputes with evidence go to staff review.</span></li>
      </ol>
    </section>
    <section class="policies panel-section" data-reveal>
      <div class="section-head"><div><div class="eyebrow">Trading policies</div><div data-reveal-section="Protections and limits"></div>
      <p>What the marketplace enforces — and what it cannot do.</p></div></div>
      <div class="policy-grid">
        <article class="policy" data-reveal data-reveal-delay="0"><h3>Compulsory evidence</h3><p>Every listing and structured offer needs a genuine in-game screenshot. Listings without evidence are never published.</p></article>
        <article class="policy" data-reveal data-reveal-delay="90"><h3>Staff review</h3><p>Approvals and rejections are recorded per listing with a reason, and rejected sellers are notified through the inbox.</p></article>
        <article class="policy" data-reveal data-reveal-delay="180"><h3>Private agreements</h3><p>Accepted terms are immutable snapshots with SHA-256 evidence. Offer screenshots stay private to the two participants and staff.</p></article>
        <article class="policy" data-reveal data-reveal-delay="270"><h3>Nine-listing limit</h3><p>Each member holds at most nine open, pending, or reserved listings, so inventory stays current and reviewable.</p></article>
      </div>
      <p class="policy-limits" data-reveal data-reveal-delay="360">Not provided: verified Minecraft account ownership, automatic in-game delivery, or escrow. Items are exchanged manually inside Minecraft; middleman custody can still lose or misuse assets.</p>
    </section>`;
  mountHero();
  const results = main.querySelector('#listing-results');
  if (!listings.length) {
    results.innerHTML = `<div class="empty marketplace-empty"><strong>No approved listings yet</strong>
      <p>Be the first to post a Rare or P2W item with an in-game screenshot.</p>
      <div class="actions">${user ? button('+ Post a listing', 'new', 'primary') : button('Sign in with Discord', 'login', 'primary')}</div></div>`;
    return;
  }
  const search = main.querySelector('#search');
  const sort = main.querySelector('#sort');
  const enchant = main.querySelector('#enchant');
  const level = main.querySelector('#enchant-level');
  const grid = mountListingGrid(results, listingDetails);
  listingGrid = grid;
  function filter() {
    if (listingGrid !== grid) return;
    const query = search.value.trim().toLowerCase();
    const enchantment = enchant.value.trim().toLowerCase();
    const filtered = records.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
      (selectedCategory === categories[0] || selectedCategory === entry.category) &&
      [entry.item, entry.wants, entry.seller, entry.details?.customName].some(value => value?.toLowerCase().includes(query)) &&
      ((!enchantment && !level.value) || entry.details?.enchantments.some(e => e.name.toLowerCase().includes(enchantment) && e.level >= Number(level.value))));
    if (sort.value === 'name') filtered.sort((a, b) => a.entry.item.localeCompare(b.entry.item));
    if (sort.value === 'quantity') filtered.sort((a, b) => b.entry.quantity - a.entry.quantity);
    grid.show(filtered);
  }
  search.addEventListener('input', filter);
  enchant.addEventListener('input', filter);
  level.addEventListener('input', filter);
  sort.addEventListener('change', filter);
  main.querySelectorAll('[data-category]').forEach(tab => tab.addEventListener('click', () => {
    selectedCategory = tab.dataset.category;
    main.querySelectorAll('[data-category]').forEach(item => item.setAttribute('aria-pressed', String(item === tab)));
    filter();
  }));
  filter();
}
function row(title, detail, actions = '') {
  return `<article class="row"><div><strong>${title}</strong><p>${detail}</p></div><div class="actions">${actions}</div></article>`;
}
const active = status => ['pending', 'accepted'].includes(status);
function tradeRow(trade) {
  return row(`${escapeHtml(trade.item)} ${tag(trade.dispute_status === 'open' ? 'Disputed · paused' : trade.status)}`,
    `${escapeHtml(trade.buyer)} ↔ ${escapeHtml(trade.seller)} · ${escapeHtml(trade.current_offer)}`,
    `<a class="outline" href="/trade/${trade.id}">Open trade room ↗</a>`);
}
// Phase 2: lightweight, visibility-aware live updates. One in-flight request per
// resource, cancellation on navigation or sign-out, backoff on failure, and an
// immediate refresh when the page becomes visible again. Drafts, selected files,
// scroll position, and open dialogs are preserved: a changed trade surfaces as a
// banner (and a re-render only when nothing is being edited), never as a wipe.
function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  lastTradeCheck = null;
}
function tradeChanged(check, known) {
  return Boolean(known) && ['status', 'version', 'buyerDone', 'sellerDone', 'disputeStatus', 'proposalCount', 'pendingCancellation']
    .some(key => check[key] !== known[key]);
}
function editingNow() {
  return dialog.open || Boolean(offerEditor) || (document.activeElement instanceof HTMLElement &&
    Boolean(document.activeElement.closest('input,textarea,select,file,[contenteditable="true"]')));
}
function showTradeBanner() {
  let banner = main.querySelector('#trade-update-banner');
  if (!banner) {
    banner = document.createElement('p');
    banner.id = 'trade-update-banner';
    banner.className = 'live-banner';
    banner.setAttribute('role', 'status');
    main.prepend(banner);
  }
  banner.innerHTML = 'This trade changed since you opened it. <button type="button" class="quiet" data-action="refresh-trade">Review the latest state</button>';
  notify('This trade changed. Review the latest state.');
}
async function refreshTradeRoom(tradeId) {
  const scrollY = window.scrollY;
  const data = await api('/trades/' + tradeId);
  tradeRoom(data);
  window.scrollTo({ top: scrollY });
  const banner = main.querySelector('#trade-update-banner');
  if (banner) banner.remove();
}
function startTradePolling(tradeId) {
  stopPolling();
  let inFlight = false;
  const schedule = delay => { pollTimer = setTimeout(tick, delay); };
  async function tick() {
    pollTimer = null;
    if (document.hidden || inFlight) { schedule(POLL_INTERVAL); return; }
    inFlight = true;
    try {
      const check = await api('/trades/' + tradeId + '/version');
      if (user) { try { notificationBell.setUnread((await api('/notifications/count')).unread || 0); } catch { /* best-effort */ } }
      pollFailures = 0;
      if (tradeChanged(check, lastTradeCheck)) {
        lastTradeCheck = check;
        if (editingNow()) showTradeBanner();
        else await refreshTradeRoom(tradeId);
      }
      schedule(POLL_INTERVAL);
    } catch (error) {
      pollFailures++;
      if (editingNow()) notify('Live update failed. Your draft is safe; retrying shortly.');
      else showTradeBanner();
      schedule(Math.min(POLL_INTERVAL * Math.pow(2, Math.min(pollFailures, 3)), POLL_MAX));
    } finally {
      inFlight = false;
    }
  }
  schedule(POLL_INTERVAL);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && lastTradeCheck && !pollTimer) startTradePolling(lastTradeCheck.id);
});
function tradeRoom(data) {
  renderTradeRoom(data, { main, user, escapeHtml, tag, button, row, itemFacts });
  lastTradeCheck = {
    id: data.trade.id, status: data.trade.status, version: data.trade.version,
    buyerDone: Boolean(data.trade.buyer_done), sellerDone: Boolean(data.trade.seller_done),
    disputeStatus: data.trade.dispute_status || null, proposalCount: data.proposals.length,
    pendingCancellation: data.cancellation?.status === 'pending',
  };
  startTradePolling(data.trade.id);
}
// Phase 2: receipt acknowledgement. The participant confirms the exact items the
// immutable agreement says they will receive, with an explicit statement.
async function showReceipt(id) {
  const room = await api('/trades/' + id);
  if (room.trade.status !== 'accepted') { notify('This trade is no longer active.'); return render(); }
  if (room.cancellation?.status === 'pending') { notify('Decide the pending cancellation request first.'); return render(); }
  const seller = room.trade.seller_id === user.id;
  const expect = seller
    ? (room.snapshot?.schemaVersion === 2 ? room.snapshot.buyerItems : room.proposals.find(p => p.version === room.trade.version)?.items || [])
    : (room.snapshot?.schemaVersion === 2 ? room.snapshot.sellerItems : [{ ...room.listing.details, ...room.listing }]);
  return form('Confirm you received the items', `<p class="muted">According to the accepted agreement, you will receive:</p>
    <h3>You will receive · ${escapeHtml(seller ? room.trade.buyer : room.trade.seller)}</h3>
    ${expect.map(item => itemCard(item, { escapeHtml, tag, itemFacts })).join('') || empty('No items were recorded in this agreement.')}
    <p class="muted">Only the manual Minecraft exchange moves items. The website does not transfer, hold, or verify anything. A confirmation is player-reported.</p>
    <label class="check-label"><input name="received" type="checkbox" required> I received the agreed items.</label>`,
    'I received the agreed items', () => api('/trades/' + id + '/confirm', {}));
}

function desk(data) {
  main.innerHTML = `<div class="page-head"><div class="eyebrow">Player workspace</div><h1 class="page-title">My trades</h1>
    <p class="muted">Agree on terms here. Confirm only after the exchange takes place in-game.</p></div>
    ${user.ign ? '<div id="player-profile"></div>' : ''}
    <div class="rows">${row('Discord account', discordLink
      ? `${escapeHtml(discordLink.username)} · ${discordLink.verified ? 'Discord Verified' : 'Website verification incomplete · complete it to trade'} · Last checked ${new Date(discordLink.checked * 1000).toLocaleString()}`
      : 'Sign in again to refresh your BananaSMP member role.',
      discordEnabled ? button('Recheck Discord', 'login') : '')}</div>
    <div class="rows">${row('Discord trade updates', tradeNotifications ? 'Enabled · Offers, counteroffers, and dispute updates' : 'Off · Opt in to receive private trade updates.',
      notificationsAvailable || tradeNotifications ? button(tradeNotifications ? 'Disable updates' : 'Enable updates', 'trade-notifications') : '')}</div>
    ${!user.ign ? '<div class="rows">' + row('Minecraft profile', 'Set your in-game name before trading.', button('Set IGN', 'set-ign', 'primary')) + '</div>' : ''}
    <div class="section-head"><h2>Requests</h2></div><div class="rows">${data.trades.map(t => tradeRow(t)).join('') || empty('No trade requests yet.')}</div>
    <div class="section-head"><div><h2>My listings</h2><p>${data.slots.used} of ${data.slots.limit} listing slots used</p></div>${button('+ Post a listing', 'new', 'primary')}</div>
    <div class="rows">${data.listings.map(l => row(`${escapeHtml(l.item)} ${tag(l.details ? l.status : 'Legacy · resubmit')}`, `${l.quantity} available · Wants ${escapeHtml(l.wants)}${l.review_note ? ' · ' + escapeHtml(l.review_note) : ''}`,
    ['open', 'review'].includes(l.status) ? button('Withdraw', `listings/${l.id}/withdraw`) : '')).join('') || empty('Your listings will appear here.')}</div>`;
  if (user.ign) playerProfile = mountPlayerProfile(document.querySelector('#player-profile'), user.ign);
}
// Staff workspace: catalog value editing. Saves the estimated unit value for
// one catalog item (blank = explicitly unpriced). Values drive the trade
// calculator; an unpriced item there withholds the verdict instead of guessing.
async function saveCatalogValue(itemId) {
  const input = main.querySelector(`input[name="value:${itemId}"]`);
  if (!input) return;
  const raw = input.value.trim();
  if (raw !== '' && (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) < 0)) {
    return notify('Value must be a number of diamonds, or blank to mark the item unpriced.');
  }
  try {
    const result = await api('/admin/catalog-values', { itemId, value: raw === '' ? null : Number(raw) });
    notify(result.priced ? `${result.name}: ${result.value} ${result.unit || 'diamonds'} per item.` : `${result.name} is now unpriced.`);
    render();
  } catch (error) { notify(error.message); }
}
function admin(data) {  reviewListings = data.listings.filter(l => l.status === 'review');
  const sections = {
    'Item review': reviewListings.map(l => row(`#${l.id} · ${escapeHtml(l.item)} ${tag(l.category)}`,
      `${escapeHtml(l.seller)} · ${l.quantity} available`, button('Review screenshot', `review:${l.id}`, 'primary'))),
    Listings: data.listings.map(l => row(`#${l.id} · ${escapeHtml(l.item)} ${tag(l.status)}`,
      `${escapeHtml(l.seller)} · ${l.quantity} available · Wants ${escapeHtml(l.wants)}`,
      ['open', 'reserved'].includes(l.status) ? button('Hide', `listings/${l.id}/hide`, 'outline danger') :
        l.status === 'hidden' && l.details ? button('Restore', `listings/${l.id}/restore`) : '')),
    Trades: data.trades.map(tradeRow),
    Disputes: data.trades.filter(t => t.dispute_status).sort((a, b) => Number(b.dispute_status === 'open') - Number(a.dispute_status === 'open'))
      .map(t => row(`#${t.id} · ${escapeHtml(t.item)} ${tag(t.dispute_status)}`, `${escapeHtml(t.buyer)} ↔ ${escapeHtml(t.seller)}`, button('Review case', `case:${t.id}`))),
    Members: data.users.map(u => row(`${escapeHtml(u.ign || u.username || 'Legacy account')} ${tag(u.suspended ? 'suspended' : u.role)}`, escapeHtml(u.username ? '@' + u.username : 'Discord connection pending'),
      u.role === 'admin' ? '' : button(u.suspended ? 'Reinstate' : 'Suspend', `admin/users/${u.id}/${u.suspended ? 'reinstate' : 'suspend'}`, u.suspended ? 'outline' : 'outline danger'))),
    'Audit log': data.audit.map(a => row(`${escapeHtml(a.action)} · #${a.target}`, `${escapeHtml(a.ign)} · ${new Date(a.created * 1000).toLocaleString()}`)),
    'Catalog values': data.catalog.items.map(item => row(`${escapeHtml(item.name)} ${tag(item.category)}`,
      item.priced
        ? `${item.value} ${data.catalog.unit} per item · set ${new Date(item.valueUpdatedAt * 1000).toLocaleDateString()}${item.updatedBy ? ' by ' + escapeHtml(item.updatedBy) : ''}`
        : `Unpriced${item.valueUpdatedAt ? ' — the calculator withholds a verdict when an unpriced item is selected' : ' — never set'}`,
      `<input class="value-input" type="number" name="value:${item.id}" value="${item.value ?? ''}" min="0" step="0.5" inputmode="decimal" aria-label="Estimated value in ${data.catalog.unit}"> ${button('Save', `value:${item.id}`, 'outline')}`)),
  };
  main.innerHTML = `<div class="page-head"><div class="eyebrow">Staff workspace</div><h1 class="page-title">Marketplace administration</h1>
    <p class="muted">Moderate listings, resolve active trades, and manage member access.</p></div>
    <div class="metrics">${Object.entries(sections).map(([name, items]) => `<div class="metric"><strong>${items.length}</strong>${name}</div>`).join('')}</div>
    <div class="tabs">${Object.keys(sections).map((name, i) => `<button class="tab" data-section="${name}" aria-pressed="${i === 0}">${name}</button>`).join('')}</div><div class="rows" id="admin-rows"></div>`;
  function show(name) {
    adminSection = name;
    main.querySelector('#admin-rows').innerHTML = sections[name].join('') || empty('Nothing to review here yet.');
    main.querySelectorAll('[data-section]').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.section === name)));
  }
  main.querySelectorAll('[data-section]').forEach(tab => tab.addEventListener('click', () => show(tab.dataset.section)));
  // A save re-renders the whole page: keep the operator on the section they
  // were editing (catalog values, for instance) instead of jumping back.
  show(sections[adminSection] ? adminSection : 'Item review');
}
function showListingReview(id) {
  const listing = reviewListings.find(l => l.id === Number(id));
  if (!listing) return;
  openDialog('Review ' + listing.item, `<p>${listing.quantity} × ${escapeHtml(listing.item)} · ${escapeHtml(listing.category)}</p>
    ${itemFacts(JSON.parse(listing.details))}${screenshotImage(id)}
    <p class="muted">Check that the item qualifies as Rare or P2W and that the screenshot clearly matches the listed name, quantity and details.</p>
    <div class="actions">${button('Approve listing', `approve-item:${id}`, 'primary')}${button('Reject listing', `reject-item:${id}`, 'outline danger')}</div>`);
}
async function showDispute(id) {
  const { trade, dispute, evidence } = await api('/disputes/' + id);
  const isOpen = dispute.status === 'open';
  const canResolve = user.role === 'admin' && ![trade.seller_id, trade.buyer_id].includes(user.id);
  openDialog('Dispute #' + id, `<p>${escapeHtml(trade.item)} ${tag(dispute.status)}</p>
    <p><strong>Reason</strong><br>${escapeHtml(dispute.reason)}</p>
    <h3>Evidence</h3>
    <div class="rows">${evidence.map(entry => row(escapeHtml(entry.ign), escapeHtml(entry.note) +
      (entry.url ? `<br><a class="evidence-link" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">Open evidence link ↗</a>` : ''))).join('') || empty('No evidence added yet.')}</div>
    ${isOpen ? button('Add evidence', `evidence:${id}`) + (canResolve ? ' ' + button('Resolve dispute', `resolve:${id}:${trade.status}`, 'primary') : '') :
      `<p><strong>Decision · ${escapeHtml(dispute.decision)}</strong><br>${escapeHtml(dispute.resolution)}</p>`}`);
}
async function render() {
  listingGrid?.dispose();
  listingGrid = undefined;
  playerProfile?.dispose();
  playerProfile = undefined;
  headingAnimations?.dispose();
  headingAnimations = undefined;
  disposeHeroMedia();
  stopPolling();
  stopVerifyPolling();
  const current = ++version;
  const isAdminPage = location.pathname === '/admin';
  const room = location.pathname.match(/^\/trade\/(\d+)$/);
  const [route, query] = isAdminPage ? ['admin', location.hash.slice(1)] : room ? ['room'] : (location.hash.slice(1) || 'market').split('?');
  const outcome = new URLSearchParams(query).get('discord');
  if (outcome) {
    history.replaceState(null, '', isAdminPage ? '/admin' : '/#desk');
    const messages = { linked: 'Signed in with Discord.', cancelled: 'Discord sign-in cancelled.', failed: 'Discord sign-in failed. Try again or ask staff to check the setup.', suspended: 'This marketplace account is suspended.', verified: 'Verification complete — Verified Member granted.', pending: 'Sign-in recorded. Verification is in progress on the verification page.' };
    notify(Object.hasOwn(messages, outcome) ? messages[outcome] : 'Discord linking did not finish.');
  }
  try {
    const session = await api('/session');
    if (current !== version) return;
    user = session.user;
    discordEnabled = session.discordEnabled;
    discordLink = session.discord;
    tradeNotifications = session.tradeNotifications;
    notificationsAvailable = session.notificationsAvailable;
    rulesVersion = session.rulesVersion || 1;
    notificationBell.setUnread(session.unread || 0);
    circularNavigation.show(user?.role === 'admin', route);
    accountControls.show(user, session.discord?.username);
    if ((route === 'desk' || room) && !user) {
      main.innerHTML = `<h1 class="page-title">My trades</h1><p class="muted">Sign in to view your listings and requests.</p><div class="section-head">${button('Sign in with Discord', 'login', 'primary')}</div>`;
      return;
    }
    if (room) {
      const data = await api('/trades/' + room[1]);
      if (current === version) tradeRoom(data);
      return;
    }
    if (route === 'calc') {
      // The calculator loads the staff-managed catalog (items + values) and
      // mounts the island. It never needs a session: any visitor can compare
      // a trade, and no API call here touches listings or trades.
      let data;
      try { data = await api('/catalog'); }
      catch (error) {
        if (current === version) main.innerHTML = '<h1 class="page-title">Trade calculator</h1>' + empty('The item catalog could not be loaded right now. Reload the page to try again.');
        return;
      }
      if (current === version) {
        main.innerHTML = `<div class="page-head"><div class="eyebrow">BananaSMP · item values</div><h1 class="page-title">Trade calculator</h1>
          <p class="muted">Compare what you give against what you get, priced against the staff-managed catalog values in ${escapeHtml(data.unit)}.</p></div>
          <div id="calc-root"></div>`;
        mountCalculator(main.querySelector('#calc-root'), { catalog: data, query, notify });
      }
      return;
    }
    if (route === 'guide') {
      main.innerHTML = `<div class="page-head"><div class="eyebrow">Minecraft Java</div><h1 class="page-title">Trading guide</h1></div><div class="rows">${row('01 · Verify on the website', `Join BananaSMP, then read and accept the rules on the ${'<a href="/#verify">verification page</a>'} and sign in with Discord. The bot grants Verified Member once your account meets the requirements.`)}${row('02 · Agree on terms', 'Set your Minecraft IGN, browse listings, and make an offer. Use the trade room to review and counter offers, and propose a meeting arrangement for the exchange.')}${row('03 · Exchange in Minecraft', 'After the trade is accepted, meet in-game. Each player then confirms: I received the agreed items. Open a dispute from the trade room if something goes wrong.')}${row('04 · Price a trade first', 'Open the trade calculator to compare both sides of a deal against the staff-managed item values before you agree. The verdict is estimated guidance — it never obliges either player.')}</div><div class="section-head">${button('Open the trade calculator', 'calc', 'primary')}</div>`;
      return;
    }
    if (route === 'verify') { renderVerify(session); return; }
    if (route === 'admin' && user?.role !== 'admin') {
      main.innerHTML = user ? empty('Administrator access required.') : '<h1 class="page-title">Marketplace administration</h1><div class="section-head">' + button('Sign in with Discord', 'login', 'primary') + '</div>';
      return;
    }
    const data = await api(route === 'desk' ? '/me' : route === 'admin' ? '/admin' : '/listings');
    if (current === version) {
      (route === 'desk' ? desk : route === 'admin' ? admin : marketplace)(data);
      const listingId = new URLSearchParams(query).get('listing');
      if (route === 'market' && /^\d+$/.test(listingId || '')) {
        try {
          const listing = await api('/listings/' + listingId);
          if (current === version) listingDetails({ ...listing, details: JSON.parse(listing.details) });
        } catch (error) { if (current === version) notify(error.message); }
      }
      if (route === 'browse') document.querySelector('#browse')?.scrollIntoView();
    }
  } catch (error) {
    // The shell stays usable: header, footer, and navigation remain mounted,
    // and the error carries a retry so a temporary API failure (session
    // expired, cold start, interruption) never leaves a dead page.
    if (current === version) {
      main.innerHTML = `<div class="empty api-down"><strong>The marketplace could not load right now.</strong>
        <p class="muted">${escapeHtml(error.message)}</p>
        <div class="actions">${button('Retry', 'render-retry', 'primary')}</div></div>`;
    }
  } finally {
    if (current === version) {
      headingAnimations = mountHeadingAnimations(main);
      revealScope(main);
    }
  }
}
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  const action = control?.dataset.action;
  if (action === 'refresh-trade') return render();
  if (action === 'render-retry') return render();
  if (action?.startsWith('copy:')) {
    try { await navigator.clipboard.writeText(action.slice(5)); notify('Copied.'); } catch { notify('Could not copy. Select and copy the visible text.'); }
    return;
  }
  if (action === 'new') return createListing();
  if (action === 'calc') return go('calc');
  if (action === 'login') {
    // Signed-in members re-consent to the current rules and sign in again;
    // anonymous visitors are routed to the verification page, where the rules
    // checkbox gates the sign-in button.
    return user ? auth({ accepted: true, rulesVersion }) : go('verify');
  }
  if (action === 'verify-login') return auth({ accepted: true, rulesVersion: verifyRulesVersion });
  if (action === 'verify-refresh') return verifyRefresh(false);  if (action === 'verify-signout') {
    try { await api('/logout', {}); notify('Signed out.'); stopVerifyPolling(); go('market'); } catch (error) { notify(error.message); }
    return;
  }
  if (action === 'set-ign') return setIgn();
  const valueEdit = action?.match(/^value:([a-z0-9-]+)$/);
  if (valueEdit) return saveCatalogValue(valueEdit[1]);
  if (action === 'trade-notifications') {
    const enabled = !tradeNotifications;
    return form(enabled ? 'Enable Discord trade updates' : 'Disable Discord trade updates',
      `<p class="muted">${enabled ? 'BananaTrade will DM your connected Discord account with trade updates and links.' : 'BananaTrade will stop sending you website trade updates.'}</p>`,
      enabled ? 'Enable Discord DMs' : 'Disable Discord DMs', () => api('/preferences/trade-notifications', { enabled }));
  }
  const receiptId = matchReceipt(action);
  if (receiptId) { try { await showReceipt(receiptId); } catch (error) { notify(error.message); } return; }
  const arrangementId = matchArrangement(action);
  if (arrangementId) {
    return form('Propose a meeting arrangement',
      '<label>Proposed server or location<input name="server" required minlength="2" maxlength="100" placeholder="Survival server, /spawn, or a landmark"></label>'
      + '<label>Meeting time (optional)<input name="meetingTime" maxlength="60" placeholder="Saturday 20:00, this weekend"></label>'
      + '<label>Timezone (optional)<input name="timezone" maxlength="40" placeholder="UTC+5:30 / EST"></label>'
      + '<p class="muted">Player-reported only. A meeting arrangement never changes the accepted item terms.</p>',
      'Send arrangement', values => api(`/trades/${arrangementId}/arrangement`, values));
  }
  const ackId = matchArrangementAck(action);
  if (ackId) {
    return form('Acknowledge the arrangement', '<p class="muted">Confirm you agree with the proposed server or location and meeting time. The accepted item terms stay unchanged.</p>',
      'Acknowledge', () => api(`/trades/${ackId}/arrangement/ack`, {}));
  }
  const cancellation = matchCancellation(action);
  if (cancellation) {
    const [id, decision] = cancellation;
    if (!decision) {
      return form('Request a cancellation', '<p class="muted">The other player can agree or decline. Neither side may confirm receipt while the request is open. The listing stays reserved until it is decided.</p>'
        + '<label>Why cancel?<textarea name="reason" required minlength="10" maxlength="1500"></textarea></label>',
        'Send request', values => api(`/trades/${id}/cancel-request`, values));
    }
    const confirmations = {
      agree: ['Agree to cancel this trade?', 'The trade closes once. The agreement, evidence, and history are preserved, and the listing is withdrawn (a slot is freed).', 'Agree and close trade'],
      decline: ['Decline this cancellation request?', 'The trade continues normally and the request is recorded.', 'Decline request'],
      withdraw: ['Withdraw your cancellation request?', 'The trade continues normally and the request is recorded.', 'Withdraw request'],
    };
    const [title, body, submit] = confirmations[decision];
    return form(title, '<p class="muted">' + body + '</p>', submit, () => api(`/trades/${id}/cancel-request/${decision}`, {}));
  }
  const review = (action || '').match(/^(review|approve-item|reject-item):(\d+)$/);
  if (review) {
    const [, kind, id] = review;
    if (kind === 'review') return showListingReview(id);
    if (kind === 'reject-item') return form('Reject listing', '<label>Reason<textarea name="reason" required minlength="3" maxlength="300"></textarea></label>',
      'Reject listing', values => api(`/listings/${id}/reject`, values));
    return form('Approve listing', '<label class="check-label"><input type="checkbox" name="proof" required> I checked the screenshot, item details, and Rare or P2W eligibility.</label>',
      'Publish listing', values => api(`/listings/${id}/approve`, { proofReviewed: values.proof === 'on' }));
  }
  const offerAction = (action || '').match(/^offer:(accept|decline|counter):(\d+):(\d+)$/);
  if (offerAction) {
    const [, kind, id, revision] = offerAction;
    try {
      const room = await api(`/trades/${id}`);
      if (room.trade.status !== 'pending' || room.trade.version !== Number(revision)) { notify('The offer changed. Review the updated trade room.'); return render(); }
      if (kind === 'counter') return showOfferEditor(room.listing, room);
      if (kind === 'decline') return form('Decline this offer', '<p>This closes this request. It does not cancel other requests for the listing.</p>', 'Decline offer', () => api(`/trades/${id}/decline`, { version: Number(revision) }));
      const items = room.proposals.find(proposal => proposal.version === room.trade.version)?.items || [];
      if (!items.length) { notify('This older offer needs item details and screenshots. Send a counteroffer first.'); return; }
      const sellerItem = { ...room.listing.details, ...room.listing };
      return form('Review the complete agreement', `<p>Trade #${id} · Proposal v${revision}. Review every item, quantity, and screenshot.</p>
        <h3>Seller gives · ${escapeHtml(room.trade.seller)}</h3>${itemCard(sellerItem, { escapeHtml, tag, itemFacts })}
        <h3>Buyer gives · ${escapeHtml(room.trade.buyer)}</h3>${items.map(item => itemCard(item, { escapeHtml, tag, itemFacts })).join('')}
        <p class="muted">The full listing will be reserved. The website cannot transfer items or verify possession. Exchange manually inside Minecraft.</p>
        <label class="check-label"><input name="review" type="checkbox" required> I reviewed both sides, quantities, and screenshots and accept these exact terms.</label>`,
        'Accept and reserve listing', values => api(`/trades/${id}/accept`, { version: Number(revision), agreementReviewed: values.review === 'on' }));
    } catch (error) { notify(error.message); }
    return;
  }
  const caseAction = (action || '').match(/^(case|dispute|evidence|resolve):(\d+)(?::(accepted|completed))?$/);
  if (caseAction) {
    const [, kind, id, status] = caseAction;
    if (kind === 'case') {
      try { await showDispute(id); } catch (error) { notify(error.message); }
      return;
    }
    if (kind === 'dispute') return form('Open a dispute', '<p class="muted">Staff will review this case. An active trade will pause.</p><label>What happened?<textarea name="reason" required minlength="10" maxlength="1500"></textarea></label>', 'Open dispute', values => api(`/disputes/${id}/open`, values));
    if (kind === 'evidence') return form('Add evidence', '<label>Evidence note<textarea name="note" required minlength="3" maxlength="1500"></textarea></label><label>Evidence link (optional)<input name="url" type="url" maxlength="1000" placeholder="https://…"></label><p class="muted">Only trade participants and admins can view this case. Use links you can safely share with them.</p>', 'Add evidence', values => api(`/disputes/${id}/evidence`, values));
    return form('Resolve dispute', `<label>Decision<select name="decision">${status === 'accepted'
      ? '<option value="resume">Resume trade and reset confirmations</option><option value="cancel">Cancel trade and withdraw listing</option>'
      : '<option value="record">Record decision for completed trade</option>'}</select></label>
      <label>Decision notes<textarea name="resolution" required minlength="10" maxlength="1500"></textarea></label>`, 'Record decision', values => api(`/disputes/${id}/resolve`, values));
  }
  if (!action || !/^(listings|trades|admin\/users)\/\d+\//.test(action)) return;
  const label = control.textContent;
  form(label, '<p class="muted">Confirm this action to update the marketplace.</p>', label, async () => {
    await api('/' + action, {});
    notify('Marketplace updated.');
  });
});
document.querySelector('#close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { offerEditor?.dispose(); offerEditor = undefined; });
// The header sign-in entry routes anonymous visitors to the verification page,
// so the rules acceptance always precedes the OAuth flow. auth() itself never
// receives the click event: the account controls wrap the callback.
const accountControls = mountAccountControls(document.querySelector('#account-control'), () => go('verify'), async () => {
  try { await api('/logout', {}); notify('Signed out.'); stopPolling(); go('market'); } catch (error) { notify(error.message); }
});
const circularNavigation = mountCircularNavigation(document.querySelector('#navigation-control'), createListing);
const notificationBell = mountNotificationBell(document.querySelector('#notification-control'), link => {
  if (location.pathname === link) render();
  else location.assign(link);
});
window.addEventListener('hashchange', render);
render();
import { mountListingGrid } from '../frontend/listing-grid';
import { mountAccountControls, mountPlayerProfile } from '../frontend/account-controls';
import { mountHeadingAnimations, mountCircularNavigation } from '../frontend/page-motion';
import { mountOfferBuilder } from '../frontend/offer-builder';
import { renderTradeRoom, itemCard } from '../frontend/trade-room';
import { mountNotificationBell } from '../frontend/notification-inbox';
import { matchReceipt, matchArrangement, matchArrangementAck, matchCancellation, plainObject } from '../frontend/route-helpers';
import { mountHeroVideo } from '../frontend/hero-video';
import { summarize as summarizeAsk } from '../frontend/ask-math';
import { mountCalculator } from '../frontend/trade-calc';
import { revealScope } from '../frontend/scroll-reveal';

