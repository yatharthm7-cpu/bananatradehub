import type { CSSProperties, PointerEvent, ReactNode } from 'react';

const glowColors = {
  blue: '#74b8ff',
  purple: '#e4a0ff',
  green: '#a7ec89',
  red: '#ff848c',
  orange: '#ffb67c',
};
const sizes = { sm: 'w-48 h-64', md: 'w-64 h-80', lg: 'w-80 h-96' };

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glowColor?: keyof typeof glowColors;
  size?: keyof typeof sizes;
  width?: string | number;
  height?: string | number;
  customSize?: boolean;
}

export function GlowCard({
  children, className = '', glowColor = 'blue', size = 'md', width, height, customSize = false,
}: GlowCardProps) {
  function moveSpotlight(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === 'touch') return;
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty('--spot-x', `${event.clientX - bounds.left}px`);
    card.style.setProperty('--spot-y', `${event.clientY - bounds.top}px`);
  }

  const style = { '--spot-color': glowColors[glowColor], width, height } as CSSProperties;
  return (
    <article
      data-glow
      className={`spotlight-card relative isolate rounded-2xl ${customSize ? '' : sizes[size]} ${className}`}
      style={style}
      onPointerMove={moveSpotlight}
    >
      {children}
    </article>
  );
}
