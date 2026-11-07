'use client';

import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

// Lazy boundary: the Three.js scene is a separate bundle chunk so the trading
// application never downloads or parses ~600 KB of WebGL code unless the hero
// actually renders. Everything in the canvas is decorative; listings, terms,
// and all trading data stay plain, reachable HTML outside the canvas.
const HeroCanvas = lazy(() => import('./hero-scene-canvas'));

export interface HeroSceneOptions {
  /** Shared scroll progress (0 at top), updated by the page without re-renders. */
  scrollProgress: { current: number };
  /** Called once after the first frame is committed, to hide the static art. */
  onReady?: () => void;
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch { return false; }
}

// Reduced motion and unsupported WebGL keep the static official-brand art.
// The caller renders the fallback element and nothing here in those cases.
export function mountHeroScene(host: HTMLElement, options: HeroSceneOptions) {
  const root = createRoot(host);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const capable = reducedMotion ? false : supportsWebGL();
  const request = (active: boolean) => root.render(capable ? (
    <Suspense fallback={null}>
      <HeroCanvas active={active} scrollProgress={options.scrollProgress} onReady={options.onReady} />
    </Suspense>
  ) : null);
  return {
    capable,
    render: request,
    // Unmount first, then detach: React 19 owns the host subtree, but the host
    // itself belongs to the page and must not survive route changes.
    dispose() { root.unmount(); host.remove(); },
  };
}
