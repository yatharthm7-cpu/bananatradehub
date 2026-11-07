const { listingDetails, screenshot } = require('./listing-proof');

const MAX_ITEMS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const summary = items => items.map(item => `${item.quantity} × ${item.customName ? item.customName + ' (' + item.item + ')' : item.item}`).join(' + ');

async function validateOffer(body, { db, tradeId, latestVersion, actorId, field }) {
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS) fail(400, 'Offer between 1 and 3 Rare or P2W items with screenshots.');
  let sourceBytes = 0;
  let storedBytes = 0;
  const result = [];
  for (const item of body.items) {
    if (!item || typeof item !== 'object') fail(400, 'Enter complete offered item details.');
    const details = { ...listingDetails(item, field), category: item.category, quantity: item.quantity,
      notes: field(item.notes ?? '', 'Item notes', 0, 500) };
    if (!Number.isInteger(details.quantity) || details.quantity < 1 || details.quantity > 100000) fail(400, 'Enter an item quantity from 1 to 100,000.');
    let image;
    let submittedBy = actorId;
    if (item.screenshot) {
      const encoded = typeof item.screenshot === 'string' ? item.screenshot.split(',')[1] || '' : '';
      sourceBytes += Math.floor(encoded.length * 3 / 4) - (encoded.match(/=+$/)?.[0].length || 0);
      if (sourceBytes > MAX_BYTES) fail(400, 'All offered screenshots together must be at most 2 MB.');
      image = await screenshot(item.screenshot);
    } else {
      const ref = item.proofRef;
      if (!tradeId || !ref || !Number.isInteger(ref.version) || ref.version < 0 || ref.version > latestVersion ||
          !Number.isInteger(ref.position) || ref.position < 0 || ref.position >= MAX_ITEMS) fail(400, 'Attach a screenshot for every offered item.');
      const proof = await db.prepare('SELECT details,image,submitted_by FROM trade_offer_items WHERE trade_id=? AND version=? AND position=?').get(tradeId, ref.version, ref.position);
      if (!proof) fail(400, 'The referenced screenshot is unavailable. Upload a new screenshot.');
      const previous = JSON.parse(proof.details);
      const { quantity: oldQuantity, notes: _oldNotes, ...oldFacts } = previous;
      const { quantity: newQuantity, notes: _newNotes, ...newFacts } = details;
      if (JSON.stringify(oldFacts) !== JSON.stringify(newFacts) || newQuantity > oldQuantity) fail(400, 'Upload a new screenshot when changing item details or increasing quantity.');
      image = Buffer.from(proof.image);
      submittedBy = proof.submitted_by;
      sourceBytes += image.length;
    }
    storedBytes += image.length;
    if (sourceBytes > MAX_BYTES || storedBytes > MAX_BYTES) fail(400, 'All offered screenshots together must be at most 2 MB.');
    result.push({ details, image, submittedBy });
  }
  return result;
}

async function saveOffer(db, tradeId, version, actorId, items) {
  if ((await db.prepare('SELECT count(*) AS total FROM trade_proposals WHERE author=? AND created>unixepoch()-60').get(actorId)).total >= 20) fail(429, 'You sent too many proposals. Wait a minute before trying again.');
  await db.prepare('INSERT INTO trade_proposals(trade_id,version,author,terms) VALUES(?,?,?,?)').run(tradeId, version, actorId, summary(items.map(item => item.details)));
  for (let position = 0; position < items.length; position++) {
    const item = items[position];
    await db.prepare('INSERT INTO trade_offer_items(trade_id,version,position,details,image,submitted_by) VALUES(?,?,?,?,?,?)')
      .run(tradeId, version, position, JSON.stringify(item.details), item.image, item.submittedBy);
  }
}

async function readOfferHistory(db, tradeId) {
  const proposals = await db.prepare('SELECT p.*,u.ign AS author_ign FROM trade_proposals p JOIN users u ON u.id=p.author WHERE trade_id=? ORDER BY version DESC').all(tradeId);
  const items = await db.prepare(`SELECT i.version,i.position,i.details,i.submitted_by,u.ign AS submitted_by_ign
    FROM trade_offer_items i JOIN users u ON u.id=i.submitted_by WHERE trade_id=? ORDER BY i.version,i.position`).all(tradeId);
  return proposals.map(proposal => ({ ...proposal, items: items.filter(item => item.version === proposal.version).map(item => ({
    ...JSON.parse(item.details), position: item.position, version: item.version, submittedBy: item.submitted_by,
    submittedByIgn: item.submitted_by_ign, reviewStatus: 'Submitted · not staff-reviewed',
    screenshot: `/api/trades/${tradeId}/proposals/${item.version}/items/${item.position}/screenshot`,
  })) }));
}

module.exports = { validateOffer, saveOffer, readOfferHistory, summary, MAX_ITEMS, MAX_BYTES };
