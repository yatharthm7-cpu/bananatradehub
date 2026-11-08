// The trade calculator. BananaSMP's marketplace is a barter economy: a
// listing's value lives in free text ("Looking for"), with no currency, price,
// or unit anywhere in the schema. So this module does the arithmetic players
// already do in their heads — converting between a per-unit rate ("2 netherite
// ingots each") and a total for the lot ("64 coal for the lot") — and only
// when the wording is unambiguous enough to compute honestly.
//
// What this is not: it is not an appraisal. It never invents a currency, never
// compares against other listings, and never estimates what an item is "worth"
// — that data does not exist, and the site's trust boundary is about
// authenticity (screenshot evidence, staff review), never about value. The
// seller's written terms stay the binding record; every number here is a
// preview recomputed on demand and never persisted.

// Per-unit wording: the number is the rate for ONE item.
const PER_UNIT = /\b(?:each|apiece|ea\b|per\s+(?:item|piece|pc)|\/ea)\b/i;
// Whole-lot wording: the number is the total for the entire quantity.
const PER_LOT = /\b(?:for\s+the\s+(?:whole\s+)?(?:lot|set|stack|pile)|for\s+all|in\s+total|as\s+(?:a\s+)?total|total)\b/i;
// Filler words that are not part of the traded thing's name.
const STOP_WORDS = new Set(['for', 'the', 'a', 'an', 'of', 'in', 'all', 'and', 'is']);

function firstNumber(text) {
  // "1,000" reads as one thousand; strip digit-group commas first so the rate
  // parses instead of becoming two numbers.
  const compact = text.replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
  const match = compact.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return { raw: match[1], value: Number(match[1]) };
}

function formatAmount(number) {
  const rounded = Math.round(number * 100) / 100;
  return Number(rounded.toFixed(2)).toLocaleString('en-US');
}

// Extracts the traded thing's name from the wording around the number and the
// marker, so the calculator echoes the seller's own words instead of a
// generic "items": "2 netherite ingots each" -> "netherite ingots".
export function parseAsk(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value.length < 2) return null;
  const number = firstNumber(value);
  if (!number || !(number.value > 0) || !Number.isFinite(number.value)) return null;
  const markers = PER_LOT.test(value) ? PER_LOT : PER_UNIT.test(value) ? PER_UNIT : null;
  if (!markers) return null; // plain barter with no rate wording: nothing to calculate
  const rest = value.replace(number.raw, ' ').replace(markers, ' ').toLowerCase();
  const unit = rest.split(/[^a-z\s]+|\s+/).filter(Boolean).filter(word => !STOP_WORDS.has(word)).slice(0, 4).join(' ');
  return { kind: markers === PER_UNIT ? 'each' : 'lot', amount: number.value, unit };
}

// Computes the derived side of the ask for a given quantity: a per-unit rate
// yields the total for the lot, a lot total yields the per-unit rate. Returns
// null whenever the wording or quantity cannot support an honest calculation.
export function summarize(wants, quantity) {
  const ask = parseAsk(wants);
  if (!ask) return null;
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) return null;
  if (ask.kind === 'each') {
    const total = ask.amount * qty;
    if (total === ask.amount) return null; // quantity 1: the total says nothing the ask did not
    return { ...ask, quantity: qty, total, text: `${formatAmount(ask.amount)} ${ask.unit} each → ${formatAmount(total)} total` };
  }
  const each = ask.amount / qty;
  if (each === ask.amount) return null;
  const exact = Number(each.toFixed(2)) === each; // ≈ only when the display rounds
  return { ...ask, quantity: qty, each, exact, text: `${formatAmount(ask.amount)} ${ask.unit} total → ${exact ? '' : '≈ '}${formatAmount(each)} each` };
}
