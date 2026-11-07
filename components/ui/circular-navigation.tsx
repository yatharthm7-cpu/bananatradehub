'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeftRight, BookOpen, Compass, Plus, Search, ShieldCheck, Store, X } from 'lucide-react';

interface CircularNavigationProps {
  isAdmin?: boolean;
  currentRoute?: string;
  onPostListing: () => void;
}

export function CircularNavigation({ isAdmin = false, currentRoute = 'market', onPostListing }: CircularNavigationProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const dialogId = useId();
  const links = [
    { label: 'Marketplace', href: '/#market', route: 'market', icon: Store },
    { label: 'Browse', href: '/#browse', route: 'browse', icon: Search },
    { label: 'My trades', href: '/#desk', route: 'desk', icon: ArrowLeftRight },
    { label: 'Trading guide', href: '/#guide', route: 'guide', icon: BookOpen },
    { label: 'Post a listing', href: null, route: 'post', icon: Plus },
    ...(isAdmin ? [{ label: 'Admin', href: '/admin', route: 'admin', icon: ShieldCheck }] : []),
  ];
  function close() { dialog.current?.close(); }
  useEffect(() => { dialog.current?.close(); }, [currentRoute, isAdmin]);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  function arrowNavigation(event: KeyboardEvent<HTMLElement>) {
    const directions = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!directions.includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('a, button')];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }
  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button')];
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <>
    <button type="button" ref={trigger} className="circular-nav-trigger" aria-label="Open navigation"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
      onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
      <Compass size={20} aria-hidden="true" /><span>Explore</span>
    </button>
    <dialog ref={dialog} id={dialogId} className="circular-nav-dialog" aria-labelledby={titleId}
      onKeyDown={containFocus}
      onClose={() => { setOpen(false); if (!document.querySelector('dialog[open]')) trigger.current?.focus(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="circular-nav-disc">
        <h2 className="sr-only" id={titleId}>BananaSMP navigation</h2>
        <nav className="circular-nav-links" aria-label="Main navigation" onKeyDown={arrowNavigation}>
          {links.map((item, index) => {
            const angle = (-90 + index * 360 / links.length) * Math.PI / 180;
            const position = { '--nav-x': `${50 + 35 * Math.cos(angle)}%`, '--nav-y': `${50 + 35 * Math.sin(angle)}%`, '--nav-order': index } as CSSProperties;
            const content = <><item.icon size={25} strokeWidth={1.6} aria-hidden="true" /><span>{item.label}</span></>;
            return item.href ? <a key={item.route} className="circular-nav-item" style={position} href={item.href}
              aria-current={currentRoute === item.route ? 'page' : undefined} onClick={close}>{content}</a> :
              <button key={item.route} type="button" className="circular-nav-item" style={position}
                onClick={() => { close(); onPostListing(); }}>{content}</button>;
          })}
        </nav>
        <div className="circular-nav-center"><button type="button" className="circular-nav-close" aria-label="Close navigation" onClick={close}><X size={26} aria-hidden="true" /></button><span>BANANASMP</span></div>
      </div>
    </dialog>
  </>;
}
