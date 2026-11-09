// The trade calculator UI. Two panels (YOU GIVE / YOU GET), an item picker
// modal, a live Win/Fair/Lose verdict, and controls: swap, clear, share link,
// and on-device history. All math lives in calc-core.js; this file only
// renders and wires events. Calculating never trades anything: no API call to
// a trade endpoint is made from here, and nothing leaves the device except the
// share link (item IDs and quantities, never account data).
import {
  DEFAULT_TOLERANCE, QUANTITY_MAX, HISTORY_KEY, TOLERANCE_KEY,
  compareTrade, stackEntries, setEntryQuantity, removeEntry, swapSides,
  buildShareQuery, parseShareQuery, pruneHistory, makeHistoryEntry,
  clampQuantity, clampTolerance, formatValue,
} from './calc-core';

const PICKER_PAGE_SIZE = 24;
// One calculator at a time: a route change drops the container, but the picker
// dialog is body-level. Mounting again (or a dispose registered by the router)
// closes a leftover picker instead of leaving a dead modal in the DOM.
let activeInstance = null;

const VERDICT_STYLES = {
  win: { label: 'Win', className: 'verdict-win', icon: '▲' },
  fair: { label: 'Fair', className: 'verdict-fair', icon: '◆' },
  lose: { label: 'Lose', className: 'verdict-lose', icon: '▼' },
};

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode: history just won't persist */ }
}

function itemOf(catalog, itemId) {
  return catalog.items.find(item => item.id === itemId);
}

function sideSummaryText(summary, unit) {
  return `${formatValue(summary.value, unit)} · ${summary.quantity} item${summary.quantity === 1 ? '' : 's'}`;
}

function itemCard(catalog, entry, side) {
  const item = itemOf(catalog, entry.itemId);
  const value = item && item.priced ? formatValue(item.value * entry.qty, catalog.unit) : '<span class="unpriced-tag">Unpriced</span>';
  const unitValue = item && item.priced ? `${formatValue(item.value, catalog.unit)} each` : 'No catalog value';
  return `<article class="calc-item" data-item="${entry.itemId}" data-side="${side}">
    <svg aria-hidden="true" viewBox="0 0 32 32"><use href="/items.svg#${item?.icon || 'book'}"></use></svg>
    <div class="calc-item-copy">
      <strong>${item ? escapeText(item.name) : entry.itemId}</strong>
      <small>${unitValue}</small>
    </div>
    <div class="calc-item-value">${value}</div>
    <div class="calc-qty">
      <button type="button" data-qty="dec" data-item="${entry.itemId}" data-side="${side}" aria-label="Decrease ${entry.itemId} quantity">−</button>
      <input type="number" min="1" max="${QUANTITY_MAX}" value="${entry.qty}" data-qty-input="${entry.itemId}" data-side="${side}" aria-label="${(item?.name || entry.itemId)} quantity">
      <button type="button" data-qty="inc" data-item="${entry.itemId}" data-side="${side}" aria-label="Increase ${entry.itemId} quantity">+</button>
    </div>
    <button type="button" class="calc-remove" data-remove="${entry.itemId}" data-side="${side}" aria-label="Remove ${item?.name || entry.itemId}">×</button>
  </article>`;
}

function panel(catalog, side, label, id) {
  const summary = side.reduce((acc, entry) => {
    acc.quantity += entry.qty;
    const item = itemOf(catalog, entry.itemId);
    if (item?.priced) acc.value += item.value * entry.qty;
    return acc;
  }, { value: 0, quantity: 0 });
  return `<section class="calc-panel" id="panel-${id}" aria-label="${label}">
    <header><strong>${label}</strong><span>${formatValue(summary.value, catalog.unit)} · ${summary.quantity} item${summary.quantity === 1 ? '' : 's'}</span></header>
    <div class="calc-items">
      ${side.map(entry => itemCard(catalog, entry, id)).join('')}
      <button type="button" class="calc-add" data-add="${id}" aria-label="Add an item to ${label}">+ Add item</button>
    </div>
  </section>`;
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function mountCalculator(container, { catalog, query = '', notify = () => {} } = {}) {
  if (!container || !catalog) return { dispose() {} };
  if (activeInstance && activeInstance.container !== container) activeInstance.dispose();
  const instance = { container, disposed: false,
    dispose() { instance.disposed = true; closePicker(); container.innerHTML = ''; } };
  const restored = parseShareQuery(query, catalog.items);
  let give = restored.give;
  let get = restored.get;
  const restoredNote = restored.dropped.give + restored.dropped.get > 0
    ? `This link contained ${restored.dropped.give + restored.dropped.get} unknown item entr${restored.dropped.give + restored.dropped.get === 1 ? 'y' : 'ies'} — the rest of the trade was restored.`
    : null;
  let tolerance = clampTolerance(Number(storageGet(TOLERANCE_KEY)) || DEFAULT_TOLERANCE);
  let history = pruneHistory(readHistory());
  let picker = null; // { side, dialog, focusIndex }
  let summaryOpen = false;
  let historyOpen = false;

  function readHistory() {
    try { return JSON.parse(storageGet(HISTORY_KEY) || '[]'); } catch { return []; }
  }
  function persistHistory() {
    storageSet(HISTORY_KEY, JSON.stringify(history));
  }
  function persistTolerance() {
    storageSet(TOLERANCE_KEY, String(tolerance));
  }

  function outcome() {
    return compareTrade({ give, get, items: catalog.items, tolerance });
  }

  function verdictMarkup(result) {
    if (result.incomplete) {
      return `<div class="calc-verdict verdict-pending" role="status">${result.reason || 'Enter items on both sides to compare the trade.'}</div>`;
    }
    const style = VERDICT_STYLES[result.verdict];
    const sign = result.percentage > 0 ? '+' : '';
    return `<div class="calc-verdict ${style.className}" role="status">
      <strong>${style.icon} ${style.label}</strong>
      <span>${formatValue(result.getTotal, catalog.unit)} received for ${formatValue(result.giveTotal, catalog.unit)} given</span>
      <em>${sign}${result.percentage}% difference · ${(result.difference > 0 ? '+' : '') + formatValue(result.difference, catalog.unit)}</em>
    </div>`;
  }

  function summaryMarkup(result) {
    if (!summaryOpen) return '';
    const rows = [
      ['You give', `${formatValue(result.give.value, catalog.unit)} · ${result.give.quantity} items`],
      ['You get', `${formatValue(result.get.value, catalog.unit)} · ${result.get.quantity} items`],
      ['Difference', (result.difference > 0 ? '+' : '') + formatValue(result.difference, catalog.unit)],
      ['Verdict', result.verdict ? `${VERDOLT_STYLES[result.verdict].label} (within ±${tolerance}% counts as Fair)` : 'No verdict yet'],
    ];
    return `<div class="calc-summary-box">
      <h3>Trade summary</h3>
      ${rows.map(([label, value]) => `<div><span>${label}</span><strong>${escapeText(value)}</strong></div>`).join('')}
      <p class="calc-disclaimer">Estimated catalog values in ${catalog.unit}, managed by BananaSMP staff. This comparison does not guarantee a trade outcome — always agree in the trade room before exchanging items.</p>
    </div>`;
  }

  function historyMarkup() {
    if (!historyOpen) return '';
    if (!history.length) {
      return `<div class="calc-history-box"><h3>Recent calculations</h3><p class="muted">No saved trades yet. Saves to this device only (last ${30} trades, kept for 30 days).</p></div>`;
    }
    return `<div class="calc-history-box"><h3>Recent calculations</h3>
      ${history.map(entry => `<article class="calc-history-entry" data-history="${entry.id}">
        <div><strong>${entry.verdict ? VERDICT_STYLES[entry.verdict].label : 'Unsupported trade'}</strong>
          <small>${formatValue(entry.difference || 0, entry.unit)} · ${new Date(entry.at).toLocaleDateString()}</small></div>
        <div class="actions">
          <button type="button" data-history-restore="${entry.id}">Restore</button>
          <button type="button" class="outline danger" data-history-delete="${entry.id}">Delete</button>
        </div>
      </article>`).join('')}
      <div class="actions"><button type="button" class="outline danger" data-history-clear>Clear all history</button></div>
      <p class="calc-disclaimer">Restored trades reprice against the current catalog — totals may have changed.</p>
    </div>`;
  }

  function render() {
    const result = outcome();
    const shareable = give.length && get.length;
    container.innerHTML = `
      <div class="calc-toolbar">
        <button type="button" data-action="swap">⇄ Swap sides</button>
        <button type="button" data-action="clear">Clear trade</button>
        <button type="button" data-action="share" ${shareable ? '' : 'disabled'}>⧉ Copy trade link</button>
        <button type="button" data-action="save" ${result.verdict ? '' : 'disabled'}>＋ Save to history</button>
        <button type="button" data-action="summary" aria-pressed="${summaryOpen}">✦ Summary</button>
        <button type="button" data-action="history" aria-pressed="${historyOpen}">⟲ History ${history.length ? `(${history.length})` : ''}</button>
      </div>
      ${restoredNote ? `<p class="calc-restored-note">${escapeText(restoredNote)}</p>` : ''}
      ${verdictMarkup(result)}
      <div class="calc-panels">
        ${panel(catalog, give, 'YOU GIVE', 'give')}
        <div class="calc-vs" aria-hidden="true">→</div>
        ${panel(catalog, get, 'YOU GET', 'get')}
      </div>
      <div class="calc-tolerance">
        <label for="tolerance-input">Fair tolerance</label>
        <input type="number" id="tolerance-input" min="0" max="50" value="${tolerance}" inputmode="numeric">
        <span>%<small>Trades within ±${tolerance}% are rated Fair; beyond that, the comparison favors one side. Set it to fit how strictly you negotiate.</small></span>
      </div>
      <p class="calc-disclaimer">Values are estimated catalog values in ${catalog.unit}, set by BananaSMP staff — not live market prices. An item without a catalog value is marked Unpriced and the verdict is withheld until every selected item is priced.</p>
      ${summaryMarkup(result)}
      ${historyMarkup()}`;
  }

  // --- Item picker modal ---------------------------------------------------
  function closePicker() {
    if (!picker) return;
    const { dialog, previouslyFocused } = picker;
    picker = null;
    dialog.remove();
    if (previouslyFocused && document.body.contains(previouslyFocused)) previouslyFocused.focus();
  }

  function openPicker(side) {
    if (picker) closePicker();
    const previouslyFocused = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'calc-picker';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `Add an item to ${side === 'give' ? 'YOU GIVE' : 'YOU GET'}`);
    document.body.appendChild(dialog);
    picker = { side, dialog, previouslyFocused, query: '', category: 'All', focusIndex: 0 };
    renderPicker();
    dialog.showModal();
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closePicker();
    });
  }

  function renderPicker() {
    if (!picker) return;
    const { dialog, query, category, side } = picker;
    const categories = ['All', ...new Set(catalog.items.map(item => item.category))];
    const matches = catalog.items.filter(item =>
      (category === 'All' || item.category === category) &&
      (!query || item.name.toLowerCase().includes(query.toLowerCase())));
    const pageCount = Math.ceil(matches.length / PICKER_PAGE_SIZE);
    const page = Math.min(picker.page || 0, Math.max(0, pageCount - 1));
    picker.page = page;
    picker.matches = matches;
    const visible = matches.slice(page * PICKER_PAGE_SIZE, (page + 1) * PICKER_PAGE_SIZE);
    picker.visible = visible;
    picker.focusIndex = Math.min(picker.focusIndex, Math.max(0, visible.length - 1));
    dialog.innerHTML = `
      <div class="calc-picker-head">
        <strong>Item list → ${side === 'give' ? 'YOU GIVE' : 'YOU GET'}</strong>
        <button type="button" data-picker-close aria-label="Close item list">×</button>
      </div>
      <input type="search" id="picker-search" value="${escapeText(query)}" placeholder="Search items…" aria-label="Search items">
      <div class="calc-picker-filters" role="tablist">
        ${categories.map(name => `<button type="button" class="tab" data-picker-category="${escapeText(name)}" aria-pressed="${name === category}">${escapeText(name)}</button>`).join('')}
      </div>
      ${catalog.items.length === 0
        ? '<p class="muted calc-picker-empty">The catalog has no items yet. BananaSMP staff manage catalog values from the admin workspace.</p>'
        : visible.length === 0
          ? '<p class="muted calc-picker-empty">No items match this search. Try another name or category.</p>'
          : `<div class="calc-picker-grid" role="grid" aria-label="Matching catalog items">
              ${visible.map((item, index) => `<button type="button" class="calc-picker-item" role="gridcell" data-picker-item="${item.id}" tabindex="${index === picker.focusIndex ? 0 : -1}">
                <svg aria-hidden="true" viewBox="0 0 32 32"><use href="/items.svg#${item.icon || 'book'}"></use></svg>
                <strong>${escapeText(item.name)}</strong>
                <small>${item.priced ? formatValue(item.value, catalog.unit) + ' each' : 'Unpriced'}</small>
                <span>${escapeText(item.category)}</span>
              </button>`).join('')}
            </div>
            <div class="calc-picker-pages">
              <button type="button" data-picker-page="-1" ${page === 0 ? 'disabled' : ''}>‹ Previous</button>
              <span>${matches.length === 0 ? 0 : page + 1}/${pageCount || 1}</span>
              <button type="button" data-picker-page="1" ${page >= pageCount - 1 ? 'disabled' : ''}>Next ›</button>
            </div>`}
      <p class="calc-picker-hint">Pick an item to add it to your side; picking the same item again stacks its quantity. Use arrow keys, Enter to add, Esc to close.</p>`;
    const search = dialog.querySelector('#picker-search');
    search.addEventListener('input', () => {
      picker.query = search.value;
      picker.focusIndex = 0;
      renderPicker();
      dialog.querySelector('#picker-search').focus();
      dialog.querySelector('#picker-search').setSelectionRange(search.value.length, search.value.length);
    });
    dialog.querySelectorAll('[data-picker-category]').forEach(tab => tab.addEventListener('click', () => {
      picker.category = tab.dataset.pickerCategory;
      picker.focusIndex = 0;
      renderPicker();
    }));
    dialog.querySelectorAll('[data-picker-item]').forEach((button, index) => {
      button.addEventListener('click', () => {
        const itemId = button.dataset.pickerItem;
        if (side === 'give') give = stackEntries(give, itemId);
        else get = stackEntries(get, itemId);
        renderPicker(); // refresh so a stacked quantity could be reflected on close
        closePicker();
        render();
        notify(`Added ${itemOf(catalog, itemId)?.name || itemId}.`);
      });
      button.addEventListener('focus', () => { picker.focusIndex = index; });
    });
    dialog.querySelectorAll('[data-picker-page]').forEach(button => button.addEventListener('click', () => {
      picker.page = (picker.page || 0) + Number(button.dataset.pickerPage);
      picker.focusIndex = 0;
      renderPicker();
    }));
    dialog.querySelector('[data-picker-close]').addEventListener('click', closePicker);
    // Keyboard navigation across the visible grid.
    if (visible.length) {
      dialog.querySelector('.calc-picker-grid')?.addEventListener('keydown', event => {
        const columns = Math.max(1, Math.round(dialog.querySelector('.calc-picker-grid').clientWidth / 200));
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0;
        if (step === 0) return;
        event.preventDefault();
        picker.focusIndex = Math.min(visible.length - 1, Math.max(0, picker.focusIndex + step));
        const target = dialog.querySelectorAll('[data-picker-item]')[picker.focusIndex];
        target?.focus();
      });
    }
  }

  // --- Events --------------------------------------------------------------
  container.addEventListener('click', event => {
    const qtyButton = event.target.closest('[data-qty]');
    const sideOf = target => target.dataset.side;
    if (qtyButton) {
      const itemId = qtyButton.dataset.item;
      const side = sideOf(qtyButton);
      const current = (side === 'give' ? give : get).find(entry => entry.itemId === itemId);
      if (!current) return;
      const next = qtyButton.dataset.qty === 'inc' ? current.qty + 1 : current.qty - 1;
      if (side === 'give') give = setEntryQuantity(give, itemId, next);
      else get = setEntryQuantity(get, itemId, next);
      return render();
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const itemId = remove.dataset.remove;
      if (remove.dataset.side === 'give') give = removeEntry(give, itemId);
      else get = removeEntry(get, itemId);
      return render();
    }
    const add = event.target.closest('[data-add]');
    if (add) return openPicker(add.dataset.add);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') {
      ({ give, get } = swapSides(give, get));
      return render();
    }
    if (action === 'clear') {
      if (give.length || get.length) {
        if (!window.confirm('Clear both sides of the trade? This removes every selected item.')) return;
      }
      give = []; get = [];
      return render();
    }
    if (action === 'share') return copyShareLink();
    if (action === 'save') return saveCurrent();
    if (action === 'summary') { summaryOpen = !summaryOpen; return render(); }
    if (action === 'history') { historyOpen = !historyOpen; return render(); }
    const historyRestore = event.target.closest('[data-history-restore]');
    if (historyRestore) {
      const entry = history.find(item => item.id === historyRestore.dataset.historyRestore);
      if (!entry) return;
      give = entry.give.map(copy => ({ ...copy }));
      get = entry.get.map(copy => ({ ...copy }));
      historyOpen = false;
      render();
      return notify('Trade restored — totals reprice against the current catalog.');
    }
    const historyDelete = event.target.closest('[data-history-delete]');
    if (historyDelete) {
      history = history.filter(item => item.id !== historyDelete.dataset.historyDelete);
      persistHistory();
      return render();
    }
    if (event.target.closest('[data-history-clear]')) {
      if (!window.confirm('Delete every saved calculation from this device? This cannot be undone.')) return;
      history = [];
      persistHistory();
      return render();
    }
  });

  container.addEventListener('change', event => {
    const input = event.target.closest('[data-qty-input]');
    if (input) {
      const itemId = input.dataset.qtyInput;
      if (input.dataset.side === 'give') give = setEntryQuantity(give, itemId, clampQuantity(input.value));
      else get = setEntryQuantity(get, itemId, clampQuantity(input.value));
      render();
    }
    if (event.target.id === 'tolerance-input') {
      tolerance = clampTolerance(event.target.value);
      persistTolerance();
      render();
    }
  });

  async function copyShareLink() {
    const url = `${window.location.origin}/#calc?${buildShareQuery(give, get)}`;
    try {
      await window.navigator.clipboard.writeText(url);
      notify('Trade link copied to your clipboard.');
    } catch {
      // Clipboard API refused (permissions, non-secure context): fall back to
      // a selectable field so the link is still copyable by hand.
      const field = document.createElement('input');
      field.type = 'text';
      field.value = url;
      field.setAttribute('readonly', '');
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
      notify('Trade link copied.');
    }
    window.history.replaceState(null, '', '/#calc?' + buildShareQuery(give, get));
  }

  function saveCurrent() {
    const result = outcome();
    if (!result.verdict) return notify('Save a trade once both sides are complete and priced.');
    history = pruneHistory([makeHistoryEntry({ give, get, outcome: result, unit: catalog.unit }), ...history]);
    persistHistory();
    historyOpen = true;
    render();
    notify('Trade saved to history on this device.');
  }

  render();
  activeInstance = instance;
  return instance;
}
