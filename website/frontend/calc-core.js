// Pure logic for the trade calculator: quantity math, side totals, verdicts,
// share links, and device history. No DOM and no state of its own — the island
// (trade-calc.js) renders whatever these functions compute, which keeps this
// fully testable.
//
// Values are the staff-managed estimated catalog values (in the catalog unit,
// diamonds). An item with no value is "unpriced": any unpriced item on either
// side withholds the verdict instead of inventing a price. The verdict is an
// estimate aid, never a trade outcome — no money moves through the calculator.

export const DEFAULT_TOLERANCE = 5; // percent within which a trade counts as Fair
export const MAX_TOLERANCE = 50;
export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 10000;
export const HISTORY_LIMIT = 30;
export const HISTORY_TTL_MS = 30 * 86400000;
export const HISTORY_KEY = 'bananatrade.calc.history.v1';
export const TOLERANCE_KEY = 'bananatrade.calc.tolerance.v1';

export function clampQuantity(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return QUANTITY_MIN;
  return Math.min(QUANTITY_MAX, Math.max(QUANTITY_MIN, Math.floor(parsed)));
}

export function clampTolerance(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TOLERANCE;
  return Math.min(MAX_TOLERANCE, Math.max(0, parsed));
}

// Adds to a side, stacking onto an existing entry for the same item (the same
// item picked repeatedly grows its quantity rather than duplicating the card).
export function stackEntries(side, itemId, amount = 1) {
  const existing = side.find(entry => entry.itemId === itemId);
  if (existing) {
    return side.map(entry => entry.itemId === itemId ? { ...entry, qty: clampQuantity(entry.qty + amount) } : entry);
  }
  return [...side, { itemId, qty: clampQuantity(amount) }];
}

export function setEntryQuantity(side, itemId, qty) {
  const next = clampQuantity(qty);
  return side.map(entry => entry.itemId === itemId ? { ...entry, qty: next } : entry);
}

export function removeEntry(side, itemId) {
  return side.filter(entry => entry.itemId !== itemId);
}

export function swapSides(give, get) {
  return { give: get.map(entry => ({ ...entry })), get: give.map(entry => ({ ...entry })) };
}

export function summarize(side, items) {
  const lookup = new Map((items || []).map(item => [item.id, item]));
  return (side || []).reduce((acc, entry) => {
    const item = lookup.get(entry.itemId);
    if (!item) return acc;
    acc.quantity += entry.qty;
    if (item.priced) {
      acc.value += item.value * entry.qty;
    } else {
      acc.unpricedNames.push(item.name);
    }
    return acc;
  }, { value: 0, quantity: 0, unpricedNames: [] });
}

// The verdict. Returns always the same shape so the UI never has to guess:
// verdict is null with a human-readable reason whenever a verdict would be
// misleading (empty side, unpriced item, nothing of value to compare against).
export function compareTrade({ give = [], get = [], items = [], tolerance = DEFAULT_TOLERANCE } = {}) {
  const giveSummary = summarize(give, items);
  const getSummary = summarize(get, items);
  const giveTotal = giveSummary.value;
  const getTotal = getSummary.value;
  const outcome = {
    give: giveSummary, get: getSummary, giveTotal, getTotal,
    difference: getTotal - giveTotal,
    percentage: null, verdict: null, verdictLabel: null,
    incomplete: true, reason: '', tolerance: clampTolerance(tolerance),
  };
  if (!give.length || !get.length) {
    outcome.reason = 'Add items to both sides to see a verdict.';
    return outcome;
  }
  const unpriced = [...new Set([...giveSummary.unpricedNames, ...getSummary.unpricedNames])];
  if (unpriced.length) {
    outcome.reason = `Missing value: ${unpriced.slice(0, 3).join(', ')}${unpriced.length > 3 ? ` and ${unpriced.length - 3} more` : ''}. The verdict is withheld until every selected item has a catalog value.`;
    return outcome;
  }
  if (giveTotal <= 0) {
    outcome.reason = 'The give side has no total value to compare against.';
    return outcome;
  }
  const tolerancePercent = clampTolerance(tolerance);
  outcome.percentage = Math.round(((getTotal - giveTotal) / giveTotal) * 1000) / 10;
  outcome.incomplete = false;
  if (outcome.percentage > tolerancePercent) outcome.verdict = 'win';
  else if (outcome.percentage < -tolerancePercent) outcome.verdict = 'lose';
  else outcome.verdict = 'fair';
  outcome.verdictLabel = { win: 'You win', fair: 'Fair trade', lose: 'You lose' }[outcome.verdict];
  return outcome;
}

export function formatValue(value, unit = 'diamonds') {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  const text = Number(rounded.toFixed(2)).toLocaleString('en-US');
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${text} ${Math.abs(rounded) === 1 ? singular : unit}`;
}

// Share links: item IDs and quantities only, so a restored trade always prices
// against the CURRENT catalog — totals may have changed since the link was made.
const encodeSide = side => side.map(entry => `${entry.itemId}:${entry.qty}`).join(',');

export function buildShareQuery(give, get) {
  // Manual join, not URLSearchParams: ids and quantities are URL-safe
  // ([a-z0-9-] and digits), and unencoded separators keep links readable.
  const parts = [];
  if (give.length) parts.push('give=' + encodeSide(give));
  if (get.length) parts.push('get=' + encodeSide(get));
  return parts.join('&');
}

export function parseShareQuery(query, items) {
  const params = new URLSearchParams(query || '');
  const known = new Set((items || []).map(item => item.id));
  const dropped = { give: 0, get: 0 };
  const parseSide = key => {
    const raw = params.get(key);
    if (!raw) return [];
    const entries = [];
    for (const token of raw.split(',')) {
      const cut = token.lastIndexOf(':');
      const itemId = cut > 0 ? token.slice(0, cut) : '';
      const qty = Number(token.slice(cut + 1));
      if (!known.has(itemId) || !Number.isInteger(qty) || qty < QUANTITY_MIN) {
        dropped[key] += 1;
        continue;
      }
      entries.push({ itemId, qty: Math.min(qty, QUANTITY_MAX) });
    }
    // A hand-written link may repeat an item; stack onto one entry per side.
    return entries.reduce((side, entry) => stackEntries(side, entry.itemId, entry.qty), []);
  };
  return { give: parseSide('give'), get: parseSide('get'), dropped };
}

// Device history: capped at HISTORY_LIMIT entries, expiring after 30 days.
export function pruneHistory(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  const fresh = entries.filter(entry => Number.isFinite(entry?.at) && now - entry.at < HISTORY_TTL_MS);
  return fresh.slice(0, HISTORY_LIMIT);
}

export function makeHistoryEntry({ give, get, outcome, unit }) {
  return {
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    at: Date.now(),
    give: give.map(entry => ({ ...entry })),
    get: get.map(entry => ({ ...entry })),
    difference: outcome.difference,
    percentage: outcome.percentage,
    verdict: outcome.verdict,
    unit,
  };
}
