// Application emoji catalog adapted from the user-provided Yookie catalog.
//
// Change any value below to an application/custom emoji mention from Discord's
// Developer Portal, for example: '<:ticket:123456789012345678>'.
// Animated emojis use: '<a:loading:123456789012345678>'.
// Keep the key names unchanged. Unicode defaults continue to work everywhere.

const UNICODE_EMOJIS = {
  wave: '👋', gift: '🎁', celebration: '🎉', party: '🎊', globe: '🌐', mobile: '📱', cart: '🛒',
  ticket: '🎫', invite: '🎟️', link: '🔗', star: '⭐', inbox: '📥', hammer: '🔨', announce: '📣',
  lock: '🔒', transcript: '📄', attachment: '📎', user: '👤', claim: '✋', error: '❌', loading: '⏳',
  success: '✅', warning: '⚠️', trash: '🗑️', edit: '✏️', transfer: '🔁', remove: '➖', add: '➕',
  folder: '📁', palette: '🎨', image: '🖼️', send: '📨', cancel: '✖️', clock: '⌛', settings: '⚙️',
  question: '❓', shield: '🛡️', list: '📋', trophy: '🏆', stop: '⏹️', finish: '🏁', users: '👥',
  sad: '😔', reroll: '🔄', yookielogo: '🍪', timer: '⏱️', ballot: '🗳️', chart: '📊', roles: '🎭', sparkle: '✨',
  brick: '🧱', note: '📝', megaphone: '📢', swords: '⚔️', island: '🏝️', heart: '❤️',
  medalGold: '🥇', medalSilver: '🥈', medalBronze: '🥉', pc: '🖥️', lightbulb: '💡',
  xp: '✨', level: '⭐', rank: '🏆', progress: '📊',
  controller: '🎮', gameTicTacToe: '❌', gameConnectFour: '🟡', gameRps: '✊', gameChess: '♟️',
  gamePawn: '♟️', gameKnight: '🐴', gameBishop: '⛪', gameRook: '🏰', gameQueen: '👑', gameKing: '🤴',
  gameMinesweeper: '💣', gameGuess: '🔢', gameTrivia: '🧠', gameWord: '🔤',
  gameCards: '🃏', gameBlackjack: '🃏', gameHighCard: '🎴',
  gameBattleship: '🚢', gameDots: '🟦', gameCoinFlip: '🪙', coinHeads: '🙂', coinTails: '🦅',
  target: '🎯', gameOthello: '⚫', gameUno: '🃏',
  unoRed: '🔴', unoYellow: '🟡', unoGreen: '🟢', unoBlue: '🔵', unoWild: '🌈',
  coin: '🪙', wallet: '👛', daily: '🎁', streak: '🔥', work: '⛏️', pay: '💸',
  shop: '🛍️', inventory: '🎒', achievement: '🏅',
  leaderboardMessages: '💬', leaderboardVoice: '🎙️', leaderboardInvites: '🎟️',
  leaderboardLevels: '⭐', leaderboardEconomy: '🪙', leaderboardGames: '🎮',
  leaderboardCasino: '🎰',
  leaderboardAchievements: '🏅', leaderboardGiveaways: '🎁',
  casino: '🎰', casinoMine: '💣', casinoSafe: '💎', casinoCashout: '💰',
  casinoMultiplier: '📈', casinoBet: '🎟️',
  casinoHidden: '❔',
  rock: '🪨', paper: '📄', scissors: '✂️', handshake: '🤝', resign: '🏳️', rematch: '🔄',
  statusYellow: '🟡', statusGreen: '🟢', statusRed: '🔴',
};

const EMOJI_NAME_ALIASES = Object.freeze({
  diamondshine: 'sparkle',
  pc: 'pc',
});

// Catalog keys do not always have the same name as the emoji uploaded in the
// Developer Portal. Candidates are ordered by the closest visual meaning.
const APPLICATION_EMOJI_CANDIDATES = Object.freeze({
  wave: ['wave2'],
  celebration: ['tada', 'party'],
  party: ['party', 'tada'],
  invite: ['ticket'],
  star: ['yellowstar', 'starg'],
  inbox: ['mail'],
  transcript: ['article'],
  attachment: ['article', 'mail'],
  claim: ['user', 'Tick'],
  error: ['cross'],
  loading: ['ClockAnimated', 'Hourglass'],
  success: ['Tick'],
  warning: ['codex_warn'],
  transfer: ['Compass'],
  remove: ['minus'],
  add: ['plus'],
  folder: ['chest'],
  send: ['Rocket', 'mail'],
  cancel: ['cross'],
  clock: ['ClockAnimated', 'Hourglass'],
  question: ['questionmark'],
  list: ['article', 'note'],
  finish: ['flag'],
  users: ['Discord', 'user'],
  reroll: ['Compass'],
  timer: ['ClockAnimated', 'Hourglass'],
  ballot: ['article'],
  roles: ['ranked'],
  sparkle: ['DiamondShine'],
  brick: ['grass_block'],
  megaphone: ['announce'],
  swords: ['Sword'],
  island: ['palmtree'],
  medalGold: ['1st_place'],
  medalSilver: ['2nd_place'],
  medalBronze: ['3rd_place'],
  xp: ['Upgrade', 'DiamondShine'],
  level: ['ranked', 'Upgrade'],
  rank: ['ranked'],
  progress: ['chart'],
  controller: ['controller', 'Joystick'],
  gameTicTacToe: ['cross'],
  gameConnectFour: ['yellowstar'],
  gameRps: ['strength'],
  gameChess: ['chess'],
  gamePawn: ['7224whitepawn'],
  gameKnight: ['1130whiteknight'],
  gameBishop: ['1887whitebishop'],
  gameRook: ['1130whiterook'],
  gameQueen: ['7121whitequeen'],
  gameKing: ['2215whiteking'],
  gameMinesweeper: ['bomb'],
  gameGuess: ['questionmark'],
  gameTrivia: ['lightbulb'],
  gameWord: ['article'],
  gameCards: ['968564cards'],
  gameBlackjack: ['369595blackjack'],
  gameHighCard: ['675510high_cards'],
  gameDots: ['Purple'],
  gameCoinFlip: ['coins'],
  target: ['Magnet'],
  gameOthello: ['Purple'],
  gameUno: ['968564cards'],
  unoRed: ['starr'],
  unoYellow: ['stargo', 'yellowstar'],
  unoGreen: ['starg'],
  unoBlue: ['starb'],
  unoWild: ['DiamondShine'],
  coin: ['coins'],
  daily: ['gift'],
  streak: ['fire'],
  work: ['hammer'],
  pay: ['money'],
  shop: ['cart'],
  inventory: ['chest'],
  achievement: ['100', 'Upgrade'],
  leaderboardMessages: ['chat', 'Chat'],
  leaderboardVoice: ['Discord'],
  leaderboardInvites: ['ticket'],
  leaderboardLevels: ['ranked'],
  leaderboardEconomy: ['coins'],
  leaderboardGames: ['controller'],
  leaderboardCasino: ['369595blackjack'],
  leaderboardAchievements: ['100'],
  leaderboardGiveaways: ['gift'],
  casino: ['369595blackjack'],
  casinoMine: ['bomb'],
  casinoSafe: ['emerald'],
  casinoCashout: ['money'],
  casinoMultiplier: ['chart'],
  casinoBet: ['coins'],
  casinoHidden: ['questionmark'],
  paper: ['article'],
  scissors: ['scissors', 'scissorsicon'],
  resign: ['flag'],
  rematch: ['Compass'],
});

// Edit these values. Example: ticket: '<:ticket:123456789012345678>'
const EMOJIS = {
  ...UNICODE_EMOJIS,
};

function normalizedEmojiName(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function applicationEmojiMention(item) {
  return `<${item.animated ? 'a' : ''}:${item.name}:${item.id}>`;
}

/**
 * Connect every available application emoji to the central catalog. Exact name
 * matches are automatic; semantic aliases cover names such as Tick/success and
 * 1st_place/medalGold. Unicode remains only when no uploaded match exists.
 */
function configureApplicationEmojis(applicationEmojis) {
  // Each setup run must forget stale IDs from any earlier application response.
  for (const key of Object.keys(EMOJIS)) delete EMOJIS[key];
  Object.assign(EMOJIS, UNICODE_EMOJIS);
  const items = applicationEmojis?.values
    ? [...applicationEmojis.values()]
    : Array.isArray(applicationEmojis) ? applicationEmojis : [];
  const available = items.filter((item) => item?.available !== false && /^\d{17,20}$/.test(item?.id || '') && /^[A-Za-z0-9_]+$/.test(item?.name || ''));
  const byName = new Map();
  for (const item of available) {
    const normalized = normalizedEmojiName(item.name);
    if (!byName.has(normalized)) byName.set(normalized, item);
    EMOJIS[item.name] = applicationEmojiMention(item);
    EMOJIS[normalized] = applicationEmojiMention(item);
  }

  let mapped = 0;
  for (const key of Object.keys(UNICODE_EMOJIS)) {
    const candidates = [key, ...(APPLICATION_EMOJI_CANDIDATES[key] || [])];
    const match = candidates.map((name) => byName.get(normalizedEmojiName(name))).find(Boolean);
    if (!match) continue;
    EMOJIS[key] = applicationEmojiMention(match);
    mapped += 1;
  }
  return { uploaded: available.length, mapped };
}

function emoji(nameOrValue, fallback = 'ticket') {
  return EMOJIS[nameOrValue] || nameOrValue || EMOJIS[fallback] || UNICODE_EMOJIS.ticket;
}

function componentEmoji(nameOrValue, fallback = 'ticket') {
  const value = emoji(nameOrValue, fallback).trim();
  const custom = /^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/.exec(value);
  if (custom) return { animated: custom[1] === 'a', name: custom[2], id: custom[3] };
  return { name: value };
}

function applyEmojiCatalog(value) {
  let result = String(value ?? '');
  for (const [name, original] of Object.entries(UNICODE_EMOJIS)) {
    const replacement = EMOJIS[name];
    if (replacement && replacement !== original) result = result.replaceAll(original, replacement);
  }
  // Saved panels may contain an older ID for an emoji that was re-uploaded.
  // Resolve it by name so existing messages follow the current application set.
  return resolveEmojiMentions(result);
}

function resolveEmojiMentions(value) {
  const replacements = new Map();
  for (const configured of Object.values(EMOJIS)) {
    if (!configured) continue;
    const custom = /^<a?:([A-Za-z0-9_]+):(\d{17,20})>$/.exec(configured.trim());
    if (custom) replacements.set(custom[1].toLocaleLowerCase(), configured);
  }
  for (const [name, key] of Object.entries(EMOJI_NAME_ALIASES)) replacements.set(name, emoji(key));
  return String(value ?? '').replace(
    /<a?:([A-Za-z0-9_]+):(\d{17,20})>/g,
    (mention, name) => replacements.get(name.toLocaleLowerCase()) || mention,
  );
}

function renderEmojiText(value) {
  return resolveEmojiMentions(applyEmojiCatalog(value));
}

const emojiDefaults = Object.freeze({ ...UNICODE_EMOJIS });

module.exports = { EMOJIS, configureApplicationEmojis, emoji, componentEmoji, applyEmojiCatalog, resolveEmojiMentions, renderEmojiText, emojiDefaults };

