export function itemCard(item, { escapeHtml, tag, itemFacts }) {
  return `<article class="trade-item"><h3>${escapeHtml(item.quantity)} × ${escapeHtml(item.item)}</h3>${tag(item.category)} ${tag(item.reviewStatus || 'Submitted · not staff-reviewed')}
    ${itemFacts(item)}${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}
    ${item.submittedByIgn ? `<p class="muted">Evidence supplied by ${escapeHtml(item.submittedByIgn)}. Ownership is not verified.</p>` : ''}
    ${item.screenshot ? `<a href="${escapeHtml(item.screenshot)}" target="_blank" rel="noopener"><img loading="lazy" class="item-screenshot" src="${escapeHtml(item.screenshot)}" alt="Submitted screenshot for ${escapeHtml(item.item)}"></a>` : ''}</article>`;
}

function proposalChanges(previous, current) {
  if (!previous?.length) return 'Structured item evidence submitted.';
  const changes = [];
  for (let i = 0; i < Math.max(previous.length, current.length); i++) {
    const before = previous[i], after = current[i];
    if (!before) changes.push(`Added ${after.item}`);
    else if (!after) changes.push(`Removed ${before.item}`);
    else {
      if (before.item !== after.item) changes.push(`${before.item} → ${after.item}`);
      if (before.quantity !== after.quantity) changes.push(`${after.item}: quantity ${before.quantity} → ${after.quantity}`);
      for (const [key, label] of [['category', 'category'], ['customName', 'custom name'], ['durability', 'durability'], ['enchantments', 'enchantments'], ['rarityReason', 'origin'], ['notes', 'notes']]) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(`${after.item}: ${label} changed`);
      }
    }
  }
  return changes.join(' · ') || 'Item terms unchanged; review the submitted evidence.';
}

export function renderTradeRoom({ trade, proposals, events, snapshot, listing, requiresEvidence, cancellation, arrangement }, ui) {
  const { main, user, escapeHtml, tag, button, row } = ui;
  const cards = items => items.map(item => itemCard(item, ui)).join('');
  const date = time => new Date(time * 1000).toLocaleString();
  const identity = ign => `<div class="trade-identity"><img class="player-avatar" data-player-avatar="${escapeHtml(ign)}" src="/logo.png" alt="Public Java avatar"><div><strong>${escapeHtml(ign)}</strong><small>Self-reported Minecraft IGN</small></div>${button('Copy IGN', 'copy:' + escapeHtml(ign))}</div>`;
  const active = ['pending', 'accepted'].includes(trade.status);
  const paused = trade.dispute_status === 'open';
  const participant = [trade.seller_id, trade.buyer_id].includes(user.id);
  const seller = trade.seller_id === user.id;
  const confirmed = seller ? trade.seller_done : trade.buyer_done;
  const latest = proposals.find(proposal => proposal.version === trade.version);
  const buyerItems = snapshot?.schemaVersion === 2 ? snapshot.buyerItems : latest?.items || [];
  const sellerItems = snapshot?.schemaVersion === 2 ? snapshot.sellerItems : [{ ...(snapshot || listing.details || {}),
    item: snapshot?.item || listing.item, category: snapshot?.category || listing.category, quantity: snapshot?.quantity || listing.quantity,
    notes: snapshot?.notes ?? listing.notes, screenshot: snapshot?.screenshot || listing.screenshot, reviewStatus: listing.reviewStatus }];
  const sellerIgn = snapshot?.participants?.seller?.ign || snapshot?.seller || trade.seller;
  const buyerIgn = snapshot?.participants?.buyer?.ign || snapshot?.buyer || trade.buyer;
  const receiptText = (name, done, at) => `${name}: ${done ? 'received the items · ' + date(at) : 'not confirmed'}`;
  let instruction;
  if (paused) instruction = 'Trade paused for staff review.';
  else if (trade.status === 'completed') instruction = 'Trade completed. Both players confirmed they received the agreed items.';
  else if (!active) instruction = ({ declined: 'This offer was declined.', cancelled: 'This trade was cancelled.', expired: 'This request expired.' })[trade.status] || 'This trade is closed.';
  else if (!participant) instruction = 'Staff view. Review the recorded terms and activity.';
  else if (trade.status === 'accepted') instruction = confirmed ? 'You confirmed. Waiting for the other player.' : 'Offer accepted. Arrange your exchange inside Minecraft, then confirm you received the agreed items.';
  else if (cancellation?.status === 'pending') instruction = 'Cancellation requested. Decide the pending request before continuing.';
  else instruction = trade.proposer === user.id ? `Waiting for the ${seller ? 'buyer' : 'seller'}.` : 'Your turn to respond. Review both sides below.';
  let actions = '';
  if (participant && trade.status === 'pending' && !paused) {
    if (trade.proposer !== user.id) actions = (!requiresEvidence ? button('Review & accept offer', `offer:accept:${trade.id}:${trade.version}`, 'primary') : '') +
      button('Counteroffer', `offer:counter:${trade.id}:${trade.version}`) + button('Decline', `offer:decline:${trade.id}:${trade.version}`);
    actions += button('Cancel request', `trades/${trade.id}/cancel`);
  }
  if (participant && trade.status === 'accepted' && !paused && cancellation?.status !== 'pending') {
    actions = confirmed ? tag('Waiting for other player') : button('I received the agreed items', `receipt:${trade.id}`, 'primary');
  }
  if (participant && trade.status === 'accepted' && !paused && cancellation?.status !== 'pending' && !trade.buyer_done && !trade.seller_done) {
    actions += button('Request cancellation', `cancel-request:${trade.id}`);
  }
  if (user.role === 'admin' && active && !paused) actions += button('Cancel as admin', `trades/${trade.id}/moderate`, 'outline danger');
  if (trade.dispute_status) actions += button('View dispute', `case:${trade.id}`);
  else if (participant && ['accepted', 'completed'].includes(trade.status) && cancellation?.status !== 'pending') actions += button('Open dispute', `dispute:${trade.id}`);
  let cancellationBlock = '';
  if (cancellation) {
    const requester = cancellation.requested_by_ign || (cancellation.requested_by === trade.seller_id ? sellerIgn : buyerIgn);
    if (cancellation.status === 'pending') {
      const mine = cancellation.requested_by === user.id;
      cancellationBlock = `<section class="cancellation-request" aria-label="Pending cancellation request"><strong>Cancellation requested by ${escapeHtml(requester)}</strong>
        <p>${escapeHtml(cancellation.reason)}</p>
        <p class="muted">The listing stays reserved while this request is open. Receipt confirmation and disputes are paused until it is decided.</p>
        <div class="actions">${mine ? button('Withdraw request', `cancel-request:${trade.id}:withdraw`) : button('Agree to cancel', `cancel-request:${trade.id}:agree`, 'primary') + button('Decline cancellation', `cancel-request:${trade.id}:decline`)}</div></section>`;
    } else {
      const outcome = { agreed: 'agreed · the trade was closed and the listing withdrawn', declined: 'declined · the trade continues', withdrawn: 'withdrawn · the trade continues' }[cancellation.status] || cancellation.status;
      cancellationBlock = `<p class="muted">Cancellation request ${escapeHtml(outcome)} · requested by ${escapeHtml(requester)}${cancellation.decided_by_ign ? ' · decided by ' + escapeHtml(cancellation.decided_by_ign) : ''} · ${date(cancellation.decided_at || cancellation.created)}</p>`;
    }
  }
  let arrangementBlock = '';
  if (participant && trade.status === 'accepted') {
    const a = arrangement;
    arrangementBlock = '<section class="arrangement" aria-label="Exchange arrangement"><h2>Meeting arrangement</h2>';
    if (a) {
      const agreed = Boolean(a.acknowledged_by);
      arrangementBlock += `<p><strong>${escapeHtml(a.server)}</strong>${a.meeting_time ? ` · ${escapeHtml(a.meeting_time)}` : ''}${a.timezone ? ` (${escapeHtml(a.timezone)})` : ''}</p>
        <p class="muted">Proposed by ${escapeHtml(a.proposed_by_ign)} · ${agreed ? 'acknowledged by ' + escapeHtml(a.acknowledged_by_ign) : 'waiting for the other player to acknowledge'} · ${date(a.updated)}</p>
        <div class="actions">${a.proposed_by === user.id ? (agreed ? tag('Arrangement agreed') : tag('Waiting for acknowledgement')) : (agreed ? '' : button('Acknowledge arrangement', `arrangement-ack:${trade.id}`))} ${button('Change arrangement', `arrangement:${trade.id}`)}</div>`;
    } else {
      arrangementBlock += `<p class="muted">Agree on a server or location and an optional meeting time with a timezone. This is player-reported and never changes the accepted item terms.</p>
        <div class="actions">${button('Propose arrangement', `arrangement:${trade.id}`)}</div>`;
    }
    arrangementBlock += '</section>';
  }
  const offers = proposals.some(proposal => proposal.version === 0) ? proposals : [...proposals, { version: 0, author: trade.buyer_id, terms: trade.offer, created: trade.created, items: [] }];
  const step = trade.status === 'completed' ? 5 : trade.status === 'accepted' ? (trade.buyer_done || trade.seller_done ? 4 : 3) : trade.version > 0 ? 1 : 0;
  const progress = ['Offer sent', 'Negotiating', 'Accepted', 'Exchange in Minecraft', 'Both confirm', 'Completed'];
  main.innerHTML = `<div class="page-head"><a class="eyebrow" href="/#desk">← My trades</a><h1 class="page-title">Trade room #${trade.id}</h1><div class="actions">${button('Copy reference', 'copy:Trade #' + trade.id)}${button('Refresh trade', 'refresh-trade')} ${tag(paused ? 'Disputed · paused' : trade.status)}</div></div>
    <ol class="trade-progress" aria-label="Trade progress">${progress.map((label, index) => `<li class="${index < step ? 'is-done' : index === step ? 'is-current' : ''}" ${index === step ? 'aria-current="step"' : ''}>${escapeHtml(label)}</li>`).join('')}</ol>
    <section class="trade-instruction" aria-label="Current trade status"><strong>${escapeHtml(instruction)}</strong>${paused || !active ? '' : '<p>The website records your agreement. Players exchange items manually inside Minecraft. The website cannot transfer items or verify possession.</p>'}</section>
    ${requiresEvidence ? '<p class="legacy-notice">This older pending offer has no structured item evidence. The responding player can send a counteroffer with screenshots, or cancel and submit a new request. Acceptance is blocked until evidence is supplied.</p>' : ''}
    ${snapshot ? `<p class="muted">${snapshot.schemaVersion === 2 ? 'Locked agreement · accepted ' + date(snapshot.acceptedAt) : 'Legacy accepted agreement · preserved as originally recorded'} · Offer v${snapshot.version}</p>` : ''}
    ${cancellationBlock}
    <div class="trade-grid"><section class="trade-side"><div class="eyebrow">Seller gives · full listed quantity</div>${identity(sellerIgn)}${cards(sellerItems)}</section>
    <section class="trade-side"><div class="eyebrow">Buyer gives · Offer v${trade.version}</div>${identity(buyerIgn)}${buyerItems.length ? cards(buyerItems) : `<p>${escapeHtml(snapshot?.offer || trade.current_offer)}</p><p class="muted">Legacy text offer. Buyer screenshots were not recorded.</p>`}</section></div>
    ${['accepted', 'completed'].includes(trade.status) ? `<div class="receipt-status">${tag(receiptText('Seller', trade.seller_done, trade.seller_confirmed_at))} ${tag(receiptText('Buyer', trade.buyer_done, trade.buyer_confirmed_at))}</div>` : ''}
    <div class="actions room-actions">${actions}</div>
    ${arrangementBlock}
    <div class="trade-grid"><section><h2>Proposal history</h2>${offers.map(proposal => `<details class="proposal-history"><summary>v${proposal.version} · ${escapeHtml(proposal.author_ign || (proposal.author === trade.buyer_id ? buyerIgn : sellerIgn))} · ${escapeHtml(proposal.terms)}</summary><p class="muted">${date(proposal.created)}</p><p>${escapeHtml(proposalChanges(offers.find(previous => previous.version === proposal.version - 1)?.items, proposal.items || []))}</p>${cards(proposal.items || [])}</details>`).join('')}</section>
    <section><h2>Activity</h2><div class="rows">${events.map(e => row(escapeHtml(e.label), `${escapeHtml(e.ign)} · ${date(e.created)}`)).join('') || row('Request opened', date(trade.created))}</div></section></div>`;
  main.querySelectorAll('[data-player-avatar]').forEach(image => {
    image.addEventListener('error', () => { image.src = '/logo.png'; }, { once: true });
    image.src = '/api/minecraft/' + encodeURIComponent(image.dataset.playerAvatar.toLowerCase()) + '/avatar';
  });
}
