require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { command } = require('./slash-command');
const { command: setupCommand } = require('./setup-command');
const { commands } = require('./community-commands');
async function register({ token = process.env.DISCORD_TOKEN, guildId = process.env.GUILD_ID, api } = {}) {
  if (!token || !/^\d{17,20}$/.test(guildId || '')) throw new Error('Set DISCORD_TOKEN and GUILD_ID locally in .env first.');
  api ||= new REST({ version: '10' }).setToken(token);
  const app = await api.get('/oauth2/applications/@me');
  const route = Routes.applicationGuildCommands(app.id, guildId);
  // POST upserts this named command without bulk-deleting unrelated commands.
  for (const item of [command, setupCommand, ...commands]) {
    const created = await api.post(route, { body: item.toJSON() });
    const saved = await api.get(`${route}/${created.id}`);
    if (saved.name !== item.name) throw new Error('Command readback did not match.');
    console.log(`Registered /${saved.name} in server ${guildId}.`);
  }
}
if (require.main === module) register().catch(error => {
  console.error(error.status ? `Command registration failed (HTTP ${error.status}). Check bot access and the applications.commands installation scope.` : 'Command registration failed. Set DISCORD_TOKEN and GUILD_ID locally and check connectivity.');
  process.exitCode = 1;
});
module.exports = { register };
