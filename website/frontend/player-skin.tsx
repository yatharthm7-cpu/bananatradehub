import { useState } from 'react';

export function PlayerSkin({ ign, full = false }: { ign: string; full?: boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  return <img
    className={full && !unavailable ? 'player-skin-body' : 'player-avatar'}
    src={unavailable ? '/logo.png' : `/api/minecraft/${encodeURIComponent(ign.toLowerCase())}/${full ? 'body' : 'avatar'}`}
    alt={unavailable ? 'BananaSMP' : `${ign}'s public Java ${full ? 'skin' : 'avatar'}`}
    width={full && !unavailable ? 150 : 36} height={full && !unavailable ? 260 : 36}
    loading="lazy" decoding="async" onError={() => { if (!unavailable) setUnavailable(true); }}
  />;
}
