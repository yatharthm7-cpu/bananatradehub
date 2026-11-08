import { createRoot } from 'react-dom/client';
import { GlowCard } from '@/components/ui/spotlight-card';
import { FlowButton } from '@/components/ui/flow-button';
import { PlayerSkin } from './player-skin';
import { summarize } from './ask-math';

interface Listing {
  item: string;
  category: string;
  quantity: number;
  wants: string;
  seller?: string;
  icon?: string;
}

export function mountListingGrid(container: HTMLElement, onSelect: (listing: Listing) => void) {
  const root = createRoot(container);
  return {
    show(records: { entry: Listing; index: number }[]) {
      root.render(records.length ? (
        <div className="grid">
          {records.map(({ entry, index }) => {
            // The trade calculator: derived from the seller's own ask wording,
            // shown only when that wording states a rate or a lot total. The
            // written ask above stays the binding term.
            const calc = summarize(entry.wants, entry.quantity);
            return (
              <GlowCard key={index} customSize glowColor="purple" className="card">
                <div className={`item-art art-${entry.category.split(' ')[0]}`}>
                  <span className="tag">{entry.category}</span>
                  <svg aria-hidden="true" viewBox="0 0 32 32">
                    <use href={`/items.svg#${entry.icon || 'block'}`} />
                  </svg>
                </div>
                <div className="card-body">
                  <h3>{entry.item}</h3>
                  <p className="meta seller-identity">{entry.seller ? <PlayerSkin key={entry.seller} ign={entry.seller} /> : null}<span>{entry.quantity.toLocaleString()} available · {entry.seller}</span></p>
                  <div className="want"><small>Looking for</small>{entry.wants}</div>
                  {calc ? <div className="ask-math"><small>Calculated from the ask</small>{calc.text}</div> : null}
                  <FlowButton className="flow-button-dark" text="View listing" onClick={() => onSelect(entry)} />
                </div>
              </GlowCard>
            );
          })}
        </div>
      ) : <div className="empty">No matching items. Try another search or category.</div>);
    },
    dispose() { root.unmount(); },
  };
}
