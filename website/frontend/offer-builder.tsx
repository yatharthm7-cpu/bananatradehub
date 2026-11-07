import { useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2 } from 'lucide-react';
import catalog from '../catalog';

interface OfferedItem {
  catalogId: string; item?: string; customName?: string; category: string; quantity: number;
  enchantments: { name: string; level: number }[]; durability: number | null; rarityReason: string; notes?: string;
  screenshot?: string; position?: number; version?: number;
}
type EditorItem = Omit<OfferedItem, 'enchantments' | 'durability' | 'screenshot'> & {
  key: number; enchantmentText: string; durabilityText: string; file?: File; previousScreenshot?: string;
};
interface OfferBuilderProps {
  initialItems: OfferedItem[];
  sellerDescription: string;
  onSubmit: (payload: { items: Record<string, unknown>[] }) => Promise<void>;
}
function editor(item: OfferedItem | undefined, key: number): EditorItem {
  return { catalogId: item?.catalogId || 'dragon-egg', item: item?.item || '', customName: item?.customName || '',
    category: item?.category || 'Rare', quantity: item?.quantity || 1, rarityReason: item?.rarityReason || '', notes: item?.notes || '',
    enchantmentText: (item?.enchantments || []).map(entry => entry.name + ':' + entry.level).join('\n'),
    durabilityText: item?.durability == null ? '' : String(item.durability), previousScreenshot: item?.screenshot,
    version: item?.version, position: item?.position, key };
}

function OfferBuilder({ initialItems, sellerDescription, onSubmit }: OfferBuilderProps) {
  const sequence = useRef(initialItems.length || 1);
  const [items, setItems] = useState<EditorItem[]>(() => initialItems.length ? initialItems.map(editor) : [editor(undefined, 0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function update(key: number, patch: Partial<EditorItem>) { setItems(current => current.map(item => item.key === key ? { ...item, ...patch } : item)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setBusy(true);
    try {
      if (items.reduce((total, item) => total + (item.file?.size || 0), 0) > 2 * 1024 * 1024) throw new Error('Selected screenshots together must be at most 2 MB.');
      const payload = [];
      for (const entry of items) {
        const enchantments = entry.enchantmentText.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
          const match = /^(.+):\s*(\d+)$/.exec(line);
          if (!match) throw new Error('Use Name:Level for each enchantment.');
          return { name: match[1].trim(), level: Number(match[2]) };
        });
        let screenshot;
        if (entry.file) screenshot = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('The screenshot could not be read.')); reader.readAsDataURL(entry.file!);
        });
        payload.push({ catalogId: entry.catalogId, item: entry.item, customName: entry.customName, category: entry.category,
          quantity: entry.quantity, rarityReason: entry.rarityReason, notes: entry.notes, enchantments,
          durability: entry.durabilityText === '' ? null : Number(entry.durabilityText),
          ...(screenshot ? { screenshot } : { proofRef: { version: entry.version, position: entry.position } }) });
      }
      await onSubmit({ items: payload });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send this proposal.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="offer-builder">
    <p className="offer-fixed-side"><strong>Seller gives:</strong> {sellerDescription}. The full listing quantity stays fixed.</p>
    <p className="muted">Build the buyer’s side of the exchange. Offer 1–3 Rare/P2W items. Screenshots together must be at most 2 MB. Evidence stays private to participants and staff.</p>
    <fieldset disabled={busy} className="offer-fields">
      {items.map((entry, index) => <section className="offer-editor-item" key={entry.key} aria-label={`Offered item ${index + 1}`}>
        <div className="section-head"><h3>Buyer item {index + 1}</h3>{items.length > 1 ? <button type="button" className="quiet" aria-label={`Remove item ${index + 1}`} onClick={() => setItems(current => current.filter(item => item.key !== entry.key))}><Trash2 size={16} aria-hidden="true" /></button> : null}</div>
        <div className="offer-input-grid">
          <label>Category<select value={entry.category} onChange={e => update(entry.key, { category: e.target.value, ...(e.target.value === 'P2W' ? { catalogId: 'server-item' } : {}) })}><option>Rare</option><option>P2W</option></select></label>
          <label>Item<select value={entry.catalogId} onChange={e => update(entry.key, { catalogId: e.target.value })}>{catalog.filter(item => entry.category !== 'P2W' || item.id === 'server-item').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {catalog.find(item => item.id === entry.catalogId)?.custom ? <label>Exact item name<input value={entry.item} required minLength={2} maxLength={64} onChange={e => update(entry.key, { item: e.target.value })} /></label> : null}
        <div className="offer-input-grid"><label>Quantity<input type="number" min={1} max={100000} required value={entry.quantity} onChange={e => update(entry.key, { quantity: Number(e.target.value) })} /></label>
          <label>Custom name (optional)<input maxLength={64} value={entry.customName} onChange={e => update(entry.key, { customName: e.target.value })} /></label></div>
        <label>Enchantments<textarea maxLength={1200} placeholder="Mending:1" value={entry.enchantmentText} onChange={e => update(entry.key, { enchantmentText: e.target.value })} /></label>
        <label>Durability remaining (%)<input type="number" min={0} max={100} value={entry.durabilityText} onChange={e => update(entry.key, { durabilityText: e.target.value })} /></label>
        <label>Rarity or shop origin<textarea required minLength={10} maxLength={300} value={entry.rarityReason} onChange={e => update(entry.key, { rarityReason: e.target.value })} /></label>
        <label>Notes (optional)<textarea maxLength={500} value={entry.notes} onChange={e => update(entry.key, { notes: e.target.value })} /></label>
        {entry.previousScreenshot ? <><img className="item-screenshot" src={entry.previousScreenshot} alt={`Previously submitted evidence for item ${index + 1}`} /><p className="muted">Existing evidence may be reused for unchanged details and the same or a lower quantity. Upload a replacement for other changes.</p></> : null}
        <label>{entry.previousScreenshot ? 'Replacement screenshot' : 'Item screenshot'}<input type="file" accept="image/png,image/jpeg,image/webp" required={!entry.previousScreenshot} onChange={e => update(entry.key, { file: e.target.files?.[0] })} /></label>
      </section>)}
      {items.length < 3 ? <button type="button" className="outline offer-add" onClick={() => setItems(current => [...current, editor(undefined, sequence.current++)])}><Plus size={16} aria-hidden="true" /> Add another item</button> : null}
      <p className="muted">Show item tooltips, quantities, and enchantments clearly. Each image must be at least 320 × 180 pixels. Submitted evidence is not staff approval or proof of ownership.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="primary" type="submit">{busy ? 'Sending proposal…' : 'Send proposal'}</button>
    </fieldset>
  </form>;
}

export function mountOfferBuilder(host: HTMLElement, options: OfferBuilderProps) {
  const root = createRoot(host); root.render(<OfferBuilder {...options} />);
  return { dispose() { root.unmount(); } };
}
