const sharp = require('sharp');

const skinError = (status, message) => Object.assign(new Error(message), { status });
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);

// Public appearance only. A public profile lookup does not establish ownership.
function createMinecraftSkins({ request = fetch, now = Date.now } = {}) {
  const cache = new Map();
  function cached(key, work) {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.promise;
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    const entry = { expires: now() + 20 * 60 * 1000 };
    entry.promise = Promise.resolve().then(work).catch(error => {
      entry.expires = now() + 60 * 1000;
      throw error;
    });
    cache.set(key, entry);
    return entry.promise;
  }
  async function limitedBody(response, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw skinError(503, 'Minecraft appearance is temporarily unavailable.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return {
    async image(name, kind) {
      if (!validName(name) || !['avatar', 'body'].includes(kind)) throw skinError(400, 'Invalid Minecraft appearance request.');
      const key = name.toLowerCase();
      try {
        const profile = await cached('profile:' + key, async () => {
          const response = await request('https://api.minecraftservices.com/minecraft/profile/lookup/name/' + key, {
            redirect: 'error', signal: AbortSignal.timeout(4000),
          });
          if ([204, 404].includes(response.status)) throw skinError(404, 'No public Java profile was found for this IGN.');
          if (!response.ok) throw skinError(503, 'Minecraft appearance is temporarily unavailable.');
          const result = JSON.parse((await limitedBody(response, 8192)).toString('utf8'));
          if (!/^[a-f0-9]{32}$/i.test(result.id) || result.name?.toLowerCase() !== key) throw skinError(503, 'Minecraft appearance is temporarily unavailable.');
          return result;
        });
        return await cached(kind + ':' + profile.id, async () => {
          const route = kind === 'body' ? 'renders/body/' : 'avatars/';
          const response = await request('https://crafatar.com/' + route + profile.id + '?overlay&' + (kind === 'body' ? 'scale=4' : 'size=64'), {
            redirect: 'error', signal: AbortSignal.timeout(5000),
          });
          if (!response.ok || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) throw skinError(503, 'Minecraft appearance is temporarily unavailable.');
          const input = await limitedBody(response, 512 * 1024);
          return await sharp(input, { limitInputPixels: 512 * 512 }).png().toBuffer();
        });
      } catch (error) {
        if (error.status) throw error;
        throw skinError(503, 'Minecraft appearance is temporarily unavailable.');
      }
    },
  };
}

module.exports = { createMinecraftSkins };
