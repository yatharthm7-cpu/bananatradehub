const sharp = require('sharp');
const catalog = require('./catalog');

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function listingDetails(body, field) {
  if (!['Rare', 'P2W'].includes(body.category)) invalid('Only Rare and P2W items can be listed.');
  const entry = catalog.find(item => item.id === body.catalogId);
  if (!entry || (body.category === 'P2W' && entry.id !== 'server-item')) invalid('Choose an eligible item. Use Other BananaSMP item for P2W listings.');
  const item = entry.custom ? field(body.item, 'Item name', 2, 64) : entry.name;
  const customName = field(body.customName ?? '', 'Custom name', 0, 64);
  const rarityReason = field(body.rarityReason, 'Rarity or shop origin', 10, 300);
  const durability = body.durability ?? null;
  if (durability !== null && (!Number.isInteger(durability) || durability < 0 || durability > 100)) invalid('Durability must be a percentage from 0 to 100.');
  if (!Array.isArray(body.enchantments) || body.enchantments.length > 20) invalid('Enter up to 20 enchantments.');
  const names = new Set();
  const enchantments = body.enchantments.map(enchantment => {
    const name = field(enchantment?.name, 'Enchantment name', 2, 40);
    const level = enchantment.level;
    const key = name.toLowerCase();
    if (names.has(key) || !Number.isInteger(level) || level < 1 || level > 255) invalid('Use distinct enchantments with levels from 1 to 255.');
    names.add(key);
    return { name, level };
  });
  return { item, catalogId: entry.id, customName, rarityReason, durability, enchantments };
}

async function screenshot(value) {
  const match = typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > 2796204) invalid('Attach a PNG, JPEG, or WebP screenshot up to 2 MB.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 2 * 1024 * 1024) invalid('The screenshot must be at most 2 MB.');
  try {
    const image = sharp(buffer, { limitInputPixels: 16000000, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== match[1] || meta.width < 320 || meta.height < 180 || (meta.pages || 1) > 1) invalid('Upload a still screenshot at least 320 × 180 pixels.');
    return await image.rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  } catch (error) {
    if (error.status) throw error;
    invalid('This screenshot could not be decoded. Export it as PNG, JPEG, or WebP.');
  }
}
module.exports = { listingDetails, screenshot };
