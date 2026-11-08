// Cinematic hero background: the playback policy decides who downloads the
// footage at all. Reduced motion and data-saving clients must see only the
// poster — no <video> element, no source, no bytes. Everyone else gets the
// muted, inline, looping cinematic.
//
// The module is an ES module (bundled by esbuild) and touches `document` only
// when mounting, so the tests install a minimal DOM stub for the mount calls.
const test = require('node:test');
const assert = require('node:assert/strict');

function makeDom() {
  const all = [];
  function matches(node, selector) {
    if (selector.startsWith('.')) {
      const name = selector.slice(1);
      return node.classes.has(name) || String(node.className).split(/\s+/).includes(name);
    }
    return node.tag === selector;
  }
  function descendants(node) {
    const out = [];
    for (const child of node.children) { out.push(child); out.push(...descendants(child)); }
    return out;
  }
  function createElement(tag) {
    const node = {
      tag,
      children: [],
      attrs: {},
      className: '',
      textContent: '',
      removed: false,
      playCalls: 0,
      classes: new Set(),
      listeners: {},
      appendChild(child) {
        node.children.push(child);
        child.parent = node;
        return child;
      },
      setAttribute(key, value) { node.attrs[key] = String(value); },
      getAttribute(key) { return node.attrs[key] ?? null; },
      addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
      classList: {
        add(name) { node.classes.add(name); },
        remove(name) { node.classes.delete(name); },
        contains(name) { return node.classes.has(name); },
      },
      remove() {
        node.removed = true;
        if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
      },
      play() { node.playCalls += 1; return { catch(fn) { node.playCatch = fn; } }; },
    };
    all.push(node);
    return node;
  }
  const host = createElement('div');
  host.querySelector = selector => descendants(host).find(node => matches(node, selector)) ?? null;
  host.querySelectorAll = selector => descendants(host).filter(node => matches(node, selector));
  return { document: { createElement }, host, all };
}

const hero = import('../website/frontend/hero-video.js');

function mountOnStub(mount, options, globals = {}) {
  // `navigator` is a getter-only global in Node, so plain assignment silently
  // no-ops; redefine the descriptor instead and restore it afterwards.
  const previous = { document: globalThis.document, window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const { document, host, all } = makeDom();
  globalThis.document = document;
  if ('window' in globals) globalThis.window = globals.window;
  if ('navigator' in globals) Object.defineProperty(globalThis, 'navigator', { value: globals.navigator, configurable: true });
  try {
    return { host, all, result: mount(host, options) };
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
  }
}

const reducedMotionWindow = { matchMedia: () => ({ matches: true }) };
const saveDataNavigator = { connection: { saveData: true } };
const plainNavigator = { connection: { saveData: false } };

test('heroPlaybackAllowed allows standard clients', async () => {
  const { heroPlaybackAllowed } = await hero;
  assert.equal(heroPlaybackAllowed(), true);
  assert.equal(heroPlaybackAllowed({ reducedMotion: false, saveData: false }), true);
});

test('heroPlaybackAllowed refuses reduced motion without loading the video', async () => {
  const { heroPlaybackAllowed } = await hero;
  assert.equal(heroPlaybackAllowed({ reducedMotion: true }), false);
  assert.equal(heroPlaybackAllowed({ reducedMotion: true, saveData: false }), false);
});

test('heroPlaybackAllowed refuses data-saving connections', async () => {
  const { heroPlaybackAllowed } = await hero;
  assert.equal(heroPlaybackAllowed({ saveData: true }), false);
  assert.equal(heroPlaybackAllowed({ reducedMotion: false, saveData: true }), false);
});

test('mountHeroVideo renders only the poster when playback is disallowed', async () => {
  const { mountHeroVideo } = await hero;
  for (const globals of [{ window: reducedMotionWindow }, { navigator: saveDataNavigator }]) {
    const { host, all, result } = mountOnStub(mountHeroVideo, { videoSrc: '/hero.mp4', posterSrc: '/hero-poster.jpg' }, globals);
    assert.equal(result.playing, false, 'the mount reports no playback for disallowed clients');
    assert.equal(all.filter(node => node.tag === 'video').length, 0, 'no video element may exist (no download)');
    assert.equal(all.filter(node => node.tag === 'source').length, 0, 'no source element may exist');
    assert.equal(host.querySelector('img').src, '/hero-poster.jpg', 'the poster still renders');
    result.dispose();
    assert.equal(host.querySelectorAll('.hero-media').length, 0, 'dispose removes the poster layer');
  }
});

test('mountHeroVideo layers video above the poster with autoplay attributes', async () => {
  const { mountHeroVideo } = await hero;
  const { host, all, result } = mountOnStub(mountHeroVideo, { videoSrc: '/hero.mp4', posterSrc: '/hero-poster.jpg' });
  const video = host.querySelector('video');
  assert.ok(video, 'a video element must be mounted for allowed clients');
  assert.equal(video.muted, true, 'muted is required for autoplay');
  assert.equal(video.loop, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.playCalls, 1, 'play is attempted exactly once');
  assert.equal(video.getAttribute('aria-hidden'), 'true');
  const source = host.querySelector('source');
  assert.equal(source.src, '/hero.mp4');
  assert.equal(source.type, 'video/mp4');
  // Poster is painted first and stays underneath as the fallback layer.
  assert.equal(host.querySelector('img').src, '/hero-poster.jpg', 'the poster img must always be present');
  const media = host.querySelector('.hero-media');
  assert.ok(media, 'the media wrapper hosts both layers');
  assert.equal(media.children[0].tag, 'img', 'the poster is appended before the video');
  assert.equal(media.children[1].tag, 'video', 'the video layers above the poster');
  result.dispose();
  assert.equal(host.querySelectorAll('.hero-media').length, 0, 'dispose removes the media layer');
});

test('mountHeroVideo marks the video playing only after the playing event', async () => {
  const { mountHeroVideo } = await hero;
  const { host, result } = mountOnStub(mountHeroVideo);
  const video = host.querySelector('video');
  assert.equal(video.classes.has('is-playing'), false, 'not playing until the browser confirms');
  video.listeners.playing?.forEach(fn => fn());
  assert.equal(video.classes.has('is-playing'), true);
  // A later error drops the video and leaves the poster beneath.
  video.listeners.error?.forEach(fn => fn());
  assert.equal(video.classes.has('is-playing'), false);
  assert.equal(video.removed, true, 'a failed video is removed, not left stalled');
  result.dispose();
});

test('mountHeroVideo tolerates a missing host', async () => {
  const { mountHeroVideo } = await hero;
  const result = mountHeroVideo(null);
  assert.equal(result.playing, false);
  assert.equal(typeof result.dispose, 'function');
  result.dispose();
});
