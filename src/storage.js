const fs = require('node:fs');
const path = require('node:path');
class Store {
  constructor(root, guildId) {
    this.file = path.join(root, 'data', `community-${guildId}.json`);
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, greet: { enabled: true, template: '👋 Welcome {user} to **{server}**!' }, verified: {}, inviteMembers: {}, inviteSnapshot: null, giveaways: {} };
    if (this.data.greet?.template === 'Welcome {user} to {server}! Read the rules and verify to unlock the hub. You are member #{count}.') this.data.greet.template = '👋 Welcome {user} to **{server}**!';
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
function setupState(root, guildId, botId) {
  const file = path.join(root, 'data', `guild-${guildId}.json`);
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.guildId !== guildId || (botId && state.botId !== botId)) throw new Error('Setup state belongs to another server or bot.');
  return state;
}
module.exports = { Store, setupState };
