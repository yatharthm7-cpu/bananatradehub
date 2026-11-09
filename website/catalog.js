// The shared item catalog. `category` follows the marketplace's own Rare / P2W
// split so the calculator's filters reflect the real catalog, and `custom`
// marks entries where the seller supplies the exact item name at posting time.
// Values are NOT stored here: an item's unit value is staff-managed (see the
// catalog_values table and the admin workspace) so estimates stay centralized
// and the calculator never invents a price for an unpriced item.
module.exports = [
  { id: 'elytra', name: 'Elytra', icon: 'elytra', category: 'Rare' },
  { id: 'enchanted-golden-apple', name: 'Enchanted golden apple', icon: 'apple', category: 'Rare' },
  { id: 'nether-star', name: 'Nether star', icon: 'star', category: 'Rare' },
  { id: 'dragon-egg', name: 'Dragon egg', icon: 'pearl', category: 'Rare' },
  { id: 'heavy-core', name: 'Heavy core', icon: 'block', category: 'Rare' },
  { id: 'rare-enchanted-gear', name: 'Rare enchanted gear', icon: 'sword', category: 'Rare', custom: true },
  { id: 'server-item', name: 'Other BananaSMP item', icon: 'book', category: 'P2W', custom: true },
];
// The unit every estimated catalog value is expressed in. BananaSMP has no
// server currency, so the value list uses diamonds — the Minecraft-wide common
// denominator — as its accounting unit. This is a unit label only: there is no
// conversion between items, and values are staff estimates, not exchange rates.
module.exports.UNIT = 'diamonds';
