// Cinematic hero background. The poster is always rendered (it is the loading
// state and the fallback); the <video> is only ever created and given a source
// when playback is allowed, so reduced-motion and data-saving clients never
// download the footage at all. Plain DOM on purpose: no framework needed for a
// background, so nothing extra is bundled.
//
// Assets live in website/public: hero.mp4 (the cinematic) and hero-poster.jpg
// (the frame this background fades in from). The poster must match the footage
// so the crossfade is invisible; regenerate it with the first real frame.
export function heroPlaybackAllowed({ reducedMotion = false, saveData = false } = {}) {
  // Reduced motion shows the poster (no loading or playing); data saver does
  // the same. Muted, inline autoplay is otherwise acceptable, including phones.
  return !reducedMotion && !saveData;
}

export function mountHeroVideo(host, { videoSrc = '/hero.mp4', posterSrc = '/hero-poster.jpg' } = {}) {
  if (!host) return { playing: false, dispose() {} };
  host.textContent = '';
  const media = document.createElement('div');
  media.className = 'hero-media';
  // Poster first: painted immediately, stays as the fallback, and occupies the
  // layer the video crossfades over — so a playback failure or a stalled
  // download never leaves a blank or flashing area.
  const poster = document.createElement('img');
  poster.className = 'hero-poster';
  poster.src = posterSrc;
  poster.alt = '';
  poster.decoding = 'async';
  poster.fetchPriority = 'high';
  media.appendChild(poster);
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = typeof navigator !== 'undefined' && Boolean(navigator.connection?.saveData);
  if (!heroPlaybackAllowed({ reducedMotion, saveData })) {
    host.appendChild(media);
    return { playing: false, dispose() { media.remove(); } };
  }
  const video = document.createElement('video');
  video.className = 'hero-video';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('tabindex', '-1');
  // The source is attached only in this branch: disallowed clients keep an
  // empty <video> out of the tree entirely, so nothing is fetched.
  const source = document.createElement('source');
  source.src = videoSrc;
  source.type = 'video/mp4';
  video.appendChild(source);
  video.addEventListener('playing', () => video.classList.add('is-playing'));
  const dropVideo = () => { video.classList.remove('is-playing'); video.remove(); };
  video.addEventListener('error', dropVideo);
  media.appendChild(video);
  host.appendChild(media);
  // Autoplay can still be refused by the browser (policy, low power): the
  // poster is already visible underneath, so this is a graceful fallback, not
  // a failure state.
  const playAttempt = video.play();
  if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(dropVideo);
  return { playing: true, dispose() { media.remove(); } };
}
