import { createRoot } from 'react-dom/client';
import TextBlockAnimation from '@/components/ui/text-block-animation';
import { CircularNavigation } from '@/components/ui/circular-navigation';

export function mountHeadingAnimations(scope: HTMLElement) {
  const roots = [...scope.querySelectorAll<HTMLElement>('[data-reveal-heading],[data-reveal-section]')].map(host => {
    const root = createRoot(host);
    const hero = host.dataset.revealHeading === 'hero';
    const browse = host.dataset.revealHeading === 'Browse listings';
    const section = host.dataset.revealSection;
    root.render(<TextBlockAnimation blockColor={hero ? '#d88ce9' : '#9862ca'} animateOnScroll={!hero}
      delay={hero ? 0.15 : 0} duration={hero ? 0.8 : 0.65}>
      {hero ? <h1>Find rare items.<br /><span>Agree on terms. Trade in Minecraft.</span></h1>
        : browse ? <h2>Browse listings</h2>
        : section ? <h2 className="reveal-section-title">{section}</h2>
        : <h1 className="page-title">{host.dataset.revealHeading}</h1>}
    </TextBlockAnimation>);
    return root;
  });
  return { dispose() { roots.forEach(root => root.unmount()); } };
}

export function mountCircularNavigation(host: HTMLElement, onPostListing: () => void) {
  const root = createRoot(host);
  const show = (isAdmin: boolean, currentRoute: string) => root.render(<CircularNavigation isAdmin={isAdmin} currentRoute={currentRoute} onPostListing={onPostListing} />);
  show(false, 'market');
  return { show };
}
