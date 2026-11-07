import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, Check, CheckCheck } from 'lucide-react';

interface InboxItem {
  id: number; event_type: string; title: string; body: string; link: string | null;
  read: boolean; created: number;
}
interface NotificationBellProps {
  onNavigate: (link: string) => void;
  registerCount?: (setter: (count: number) => void) => void;
}

const TYPE_LABELS: Record<string, string> = {
  offer: 'New offer', counteroffer: 'Counteroffer', acceptance: 'Acceptance', decline: 'Decline',
  cancellation: 'Cancellation', cancellation_request: 'Cancellation request', cancellation_decision: 'Cancellation decision',
  cancellation_withdrawal: 'Cancellation withdrawn', receipt: 'Receipt', completion: 'Completion',
  dispute: 'Dispute', dispute_evidence: 'Dispute evidence', dispute_decision: 'Staff decision',
  listing_approved: 'Listing approved', listing_rejected: 'Listing rejected', arrangement: 'Arrangement',
};

function NotificationBell({ onNavigate, registerCount }: NotificationBellProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (reset = false) => {
    setLoading(true); setError('');
    try {
      const after = reset ? 0 : (items[items.length - 1]?.id || 0);
      const response = await fetch(`/api/notifications?after=${after}&limit=20`, { headers: { Accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load notifications.');
      setItems(current => reset ? result.items : [...current, ...result.items]);
      setHasMore(result.items.length === 20);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load notifications.');
    } finally { setLoading(false); }
  }, [items]);

  const refreshCount = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications/count');
      const result = await response.json();
      if (response.ok) setUnread(Number(result.unread) || 0);
    } catch { /* count polling is best-effort */ }
  }, []);

  const markRead = useCallback(async (id: number) => {
    const response = await fetch(`/api/notifications/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (response.ok) {
      setItems(current => current.map(item => item.id === id ? { ...item, read: true } : item));
      setUnread(count => Math.max(0, count - 1));
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const response = await fetch('/api/notifications/read-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (response.ok) {
      setItems(current => current.map(item => ({ ...item, read: true })));
      setUnread(0);
    }
  }, []);

  function open() {
    load(true);
    refreshCount();
    dialog.current?.showModal();
  }
  function close() { dialog.current?.close(); }

  useEffect(() => { refreshCount(); registerCount?.(setUnread); }, [refreshCount, registerCount]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClose = () => { if (!document.querySelector('dialog[open]')) trigger.current?.focus(); };
    element.addEventListener('close', onClose);
    return () => element.removeEventListener('close', onClose);
  }, []);

  return <>
    <button type="button" ref={trigger} className="notification-bell" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
      aria-haspopup="dialog" onClick={open}>
      <Bell size={18} aria-hidden="true" />
      {unread ? <span className="notification-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
    <dialog ref={dialog} className="notification-dialog" aria-label="Notifications">
      <div className="notification-head">
        <strong>Notifications</strong>
        {unread ? <button type="button" className="quiet notification-mark-all" onClick={markAllRead}><CheckCheck size={14} aria-hidden="true" /> Mark all read</button> : null}
      </div>
      <ul className="notification-list">
        {items.length ? items.map(item => (
          <li key={item.id} className={item.read ? 'notification-item is-read' : 'notification-item'}>
            <div className="notification-item-head">
              <span className="tag">{TYPE_LABELS[item.event_type] || item.event_type}</span>
              <time>{new Date(item.created).toLocaleString()}</time>
              {item.read ? null : <button type="button" className="quiet notification-mark" aria-label={`Mark "${item.title}" as read`} onClick={() => markRead(item.id)}><Check size={14} aria-hidden="true" /></button>}
            </div>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            {item.link ? <button type="button" className="quiet notification-open" onClick={() => { close(); onNavigate(item.link as string); }}>Open ↗</button> : null}
          </li>
        )) : error ? <li className="notification-empty">{error}</li> : <li className="notification-empty">No notifications yet.</li>}
      </ul>
      {hasMore ? <button type="button" className="outline notification-more" disabled={loading} onClick={() => load(false)}>{loading ? 'Loading…' : 'Show more'}</button> : null}
      <div className="notification-foot"><button type="button" className="quiet" onClick={close}>Close</button></div>
    </dialog>
  </>;
}

export function mountNotificationBell(host: HTMLElement, onNavigate: (link: string) => void) {
  let setter: ((count: number) => void) | undefined;
  const root = createRoot(host);
  root.render(<NotificationBell onNavigate={onNavigate} registerCount={fn => { setter = fn; }} />);
  return {
    setUnread(count: number) { setter?.(count); },
    dispose() { root.unmount(); },
  };
}
