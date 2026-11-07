import { createRoot } from 'react-dom/client';
import { FlowButton } from '@/components/ui/flow-button';
import { PlayerSkin } from './player-skin';

type Player = { id: number; ign: string };

export function mountAccountControls(container: HTMLElement, onLogin: () => void, onLogout: () => void) {
  const root = createRoot(container);
  return {
    show(user: Player | null, username?: string) {
      root.render(user ? <div className="account-signed-in">
        {user.ign ? <PlayerSkin key={user.ign} ign={user.ign} /> : <img className="player-avatar" src="/logo.png" alt="" width={36} height={36} />}
        <a href="/#desk" className="account-name">{user.ign || username || 'My account'}</a>
        <button type="button" className="quiet" onClick={() => { onLogout(); }}>Sign out</button>
      </div> : <FlowButton text="Sign in with Discord" className="flow-button-dark" onClick={() => { onLogin(); }} />);
    },
  };
}

export function mountPlayerProfile(container: HTMLElement, ign: string) {
  const root = createRoot(container);
  root.render(<section className="player-profile" aria-label="Minecraft appearance">
    <div className="player-skin-stage"><PlayerSkin ign={ign} full /></div>
    <div><div className="eyebrow">Minecraft Java</div><h2>{ign}</h2>
      <p>Your public Java skin appears here when available. Otherwise, we show the BananaSMP logo.</p>
      <p className="muted">IGN is self-reported. Displaying a skin does not verify account ownership.</p>
    </div>
  </section>);
  return { dispose() { root.unmount(); } };
}
