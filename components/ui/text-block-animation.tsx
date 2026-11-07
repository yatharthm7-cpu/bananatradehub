'use client';

import { Children, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

interface TextBlockAnimationProps {
  children: ReactNode;
  blockColor?: string;
  animateOnScroll?: boolean;
  delay?: number;
  duration?: number;
  stagger?: number;
  className?: string;
}

export default function TextBlockAnimation({ children, blockColor = '#c97de9', animateOnScroll = true,
  delay = 0, duration = 0.8, stagger = 0.03, className = '' }: TextBlockAnimationProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element || !element.animate) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const animations: Animation[] = [];
    let observer: IntersectionObserver | undefined;
    let played = false;
    function play() {
      if (played || motion.matches || !element) return;
      played = true;
      const length = Math.max(0.1, duration) * 1000;
      element.querySelectorAll<HTMLElement>(':scope > .text-reveal-unit').forEach((unit, index) => {
        const wait = Math.max(0, delay + index * stagger) * 1000;
        const cover = unit.querySelector<HTMLElement>('.text-reveal-cover')!;
        const content = unit.querySelector<HTMLElement>('.text-reveal-content')!;
        animations.push(cover.animate([
          { transform: 'scaleX(0)', transformOrigin: 'left', offset: 0 },
          { transform: 'scaleX(1)', transformOrigin: 'left', offset: 0.42 },
          { transform: 'scaleX(1)', transformOrigin: 'right', offset: 0.52 },
          { transform: 'scaleX(0)', transformOrigin: 'right', offset: 1 },
        ], { duration: length, delay: wait, easing: 'cubic-bezier(.76,0,.24,1)', fill: 'both' }));
        animations.push(content.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 1, delay: wait + length * 0.45, fill: 'both',
        }));
      });
    }
    function stopMotion() {
      if (motion.matches) {
        observer?.disconnect();
        animations.forEach(animation => animation.cancel());
      }
    }
    if (!motion.matches) {
      if (animateOnScroll && 'IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) { play(); observer?.disconnect(); }
        }, { threshold: 0.15 });
        observer.observe(element);
      } else play();
    }
    motion.addEventListener('change', stopMotion);
    return () => { observer?.disconnect(); animations.forEach(animation => animation.cancel()); motion.removeEventListener('change', stopMotion); };
  }, [animateOnScroll, delay, duration, stagger]);

  return <div ref={root} className={`text-block-animation ${className}`} style={{ '--reveal-color': blockColor } as CSSProperties}>
    {Children.toArray(children).map((child, index) => <div className="text-reveal-unit" key={index}>
      <div className="text-reveal-content">{child}</div><span className="text-reveal-cover" aria-hidden="true" />
    </div>)}
  </div>;
}
