// Scroll and section reveals for the homepage. Uses one IntersectionObserver
// and CSS transitions, matching the project's existing WAAPI/CSS approach.
// Content stays fully visible when JavaScript fails or motion is reduced:
// elements are only hidden after the script arms the reveal class.
const ARMED = 'reveal-armed';

let armed = false;

function armedDocument() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  document.documentElement.classList.add(ARMED);
}

export function revealScope(scope = document) {
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return { dispose() {} };
  armedDocument();
  const items = [...scope.querySelectorAll('[data-reveal]')];
  if (!items.length) return { dispose() {} };
  const reveal = item => {
    item.classList.add('reveal-shown');
    item.style.transitionDelay = '';
    observer.unobserve(item);
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
  // Geometric fallback: IntersectionObserver callbacks can be withheld by the
  // host (background/embedded renderers). Content must never stay invisible
  // because a notification never arrived, so geometry decides as well.
  const check = () => {
    const limit = window.innerHeight * 0.9;
    for (const item of items) {
      if (item.classList.contains('reveal-shown')) continue;
      const rect = item.getBoundingClientRect();
      if (rect.top < limit && rect.bottom > 0) reveal(item);
    }
  };
  for (const item of items) {
    const delay = Number(item.dataset.revealDelay || 0);
    if (delay) item.style.transitionDelay = `${delay}ms`;
    observer.observe(item);
  }
  check();
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  return {
    dispose() {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      for (const item of items) { item.classList.remove('reveal-shown'); item.style.transitionDelay = ''; }
      observer.disconnect();
    },
  };
}
