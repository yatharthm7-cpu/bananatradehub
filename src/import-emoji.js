require('dotenv').config({ quiet: true });
const { REST } = require('discord.js');
const LIMIT = 256 * 1024;
function parseSource(input, requestedName) {
  const mention = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/.exec(input || '');
  let id, extension, name;
  if (mention) {
    [, , name, id] = mention;
    extension = mention[1] ? 'gif' : 'png';
  } else {
    let url;
    try { url = new URL(input); } catch { throw new Error('Provide a custom emoji mention or a Discord CDN emoji link.'); }
    const match = /^\/emojis\/(\d{17,20})\.(png|gif|webp)$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port || url.username || url.password || !match) throw new Error('Only https://cdn.discordapp.com/emojis/ID.png, .gif, or .webp links are supported.');
    [, id, extension] = match;
    name = `emoji_${id}`;
  }
  name = requestedName || name;
  if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) throw new Error('Emoji name must contain 2–32 letters, numbers, or underscores.');
  return { name, url: `https://cdn.discordapp.com/emojis/${id}.${extension}?size=128&quality=lossless` };
}
function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('The downloaded file is not a supported emoji image.');
}
async function download(url, fetcher = fetch) {
  // No bot credentials are sent to the CDN. Redirects are deliberately rejected.
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Emoji image unavailable (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw new Error('Emoji exceeds Discord’s 256 KiB limit.'); }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > LIMIT) throw new Error('Emoji exceeds Discord’s 256 KiB limit.');
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  return `data:${imageType(buffer)};base64,${buffer.toString('base64')}`;
}
async function importEmoji({ source, name, server = false, token = process.env.DISCORD_TOKEN, guildId = process.env.GUILD_ID, api, fetcher }) {
  const parsed = parseSource(source, name);
  if (!token && !api) throw new Error('Set DISCORD_TOKEN locally in .env first.');
  if (server && !/^\d{17,20}$/.test(guildId || '')) throw new Error('Set the explicit destination GUILD_ID in .env for --server.');
  api ||= new REST({ version: '10', retries: 3, timeout: 15000 }).setToken(token);
  const base = server ? `/guilds/${guildId}/emojis` : `/applications/${(await api.get('/oauth2/applications/@me')).id}/emojis`;
  const list = await api.get(base);
  const existing = (Array.isArray(list) ? list : list.items || []).find(e => e.name.toLowerCase() === parsed.name.toLowerCase());
  if (existing) throw new Error('That destination emoji name already exists. Choose another name; nothing was overwritten.');
  const image = await download(parsed.url, fetcher);
  const created = await api.post(base, { body: { name: parsed.name, image }, ...(server ? { reason: 'Owner-requested emoji import' } : {}) });
  const saved = await api.get(`${base}/${created.id}`);
  if (saved.id !== created.id || saved.name !== parsed.name) throw new Error('Emoji was uploaded, but readback did not match. Inspect the destination before retrying.');
  return { destination: server ? 'server' : 'application', mention: `<${saved.animated ? 'a' : ''}:${saved.name}:${saved.id}>` };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const server = args.includes('--server');
  const positional = args.filter(x => x !== '--server');
  if (args.includes('--help') || !positional.length) {
    console.log('Usage: npm run emoji:add -- "<:name:ID>" [new_name] [--server]\nAlso accepts a Discord CDN emoji .png/.gif/.webp link. Default destination: bot application; --server: configured GUILD_ID.');
  } else if (positional.length > 2) {
    console.error('Provide one emoji source and an optional name.'); process.exitCode = 1;
  } else importEmoji({ source: positional[0], name: positional[1], server }).then(result => console.log(`Imported to ${result.destination}: ${result.mention}`)).catch(error => {
    console.error(error.status ? `Discord import failed (HTTP ${error.status}, code ${error.code || 'unknown'}). Server imports require Create Expressions permission and a free emoji slot.` : String(error.message).replaceAll(process.env.DISCORD_TOKEN || '\0', '[REDACTED]'));
    process.exitCode = 1;
  });
}
module.exports = { parseSource, download, importEmoji };
