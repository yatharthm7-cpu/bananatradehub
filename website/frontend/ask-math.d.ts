// Type surface for ask-math.js (types-only; the module itself is plain JS so
// node --test can import it directly, mirroring hero-video.js).
export interface Ask {
  kind: 'each' | 'lot';
  amount: number;
  unit: string;
}

export interface AskSummary extends Ask {
  quantity: number;
  total?: number;
  each?: number;
  exact?: boolean;
  text: string;
}

export function parseAsk(text: string): Ask | null;
export function summarize(wants: string, quantity: number | string): AskSummary | null;
