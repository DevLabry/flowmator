import * as Icons from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store/app';

export function Modal({ title, onClose, children, footer, width }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">
            <Icons.X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <div className="title">{t.title}</div>
          {t.message && <div className="muted" style={{ marginTop: 2, wordBreak: 'break-word' }}>{t.message}</div>}
        </div>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** Closes when clicking outside. */
export function Popover({ open, onClose, children, style }: { open: boolean; onClose: () => void; children: ReactNode; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', onDown));
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="menu" style={style}>
      {children}
    </div>
  );
}

/** Node icons are declared as "fa:<name>"; map the ones we use onto lucide icons. */
const ICON_MAP: Record<string, keyof typeof Icons> = {
  'mouse-pointer': 'MousePointerClick',
  'arrow-right': 'ArrowRight',
  'exclamation-triangle': 'TriangleAlert',
  'map-signs': 'Split',
  filter: 'Filter',
  'code-branch': 'GitMerge',
  sync: 'Repeat',
  'pause-circle': 'CirclePause',
  pen: 'PenLine',
  code: 'Code',
  'hand-paper': 'Hand',
  'sort-amount-down': 'ArrowDownWideNarrow',
  'object-group': 'Group',
  'th-large': 'LayoutGrid',
  clone: 'CopyMinus',
  'sign-out-alt': 'LogIn',
  'sign-in-alt': 'Workflow',
  bolt: 'Zap',
  reply: 'Reply',
  clock: 'Clock',
  globe: 'Globe',
  bug: 'Bug',
  calendar: 'Calendar',
  key: 'KeyRound',
  edit: 'TextCursorInput',
  table: 'Sigma',
  equals: 'GitCompare',
  'file-code': 'FileCode',
  markdown: 'FileText',
  file: 'File',
  'file-export': 'FileOutput',
  'file-import': 'FileInput',
  envelope: 'Mail',
  terminal: 'Terminal',
  'list-alt': 'ClipboardList',
};

export function NodeIcon({ icon, color, size = 18, label }: { icon?: string; color?: string; size?: number; label?: string }) {
  const name = icon?.startsWith('fa:') ? ICON_MAP[icon.slice(3)] : undefined;
  const Cmp = name ? (Icons[name] as Icons.LucideIcon) : undefined;
  // blend the node colour with the text colour so dark brand colours stay visible on dark themes
  if (Cmp) return <Cmp size={size} color="currentColor" strokeWidth={1.8} style={{ color: color ? `color-mix(in srgb, ${color} 60%, var(--text))` : undefined }} />;
  return (
    <span style={{ width: size, height: size, borderRadius: 4, background: color ?? 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: size * 0.55, fontWeight: 700 }}>
      {(label ?? '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export function timeAgo(iso?: string | null) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(start?: string | null, stop?: string | null) {
  if (!start || !stop) return '';
  const ms = new Date(stop).getTime() - new Date(start).getTime();
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function StatusBadge({ status }: { status: string }) {
  const kind = status === 'success' ? 'success' : status === 'error' || status === 'crashed' ? 'error' : status === 'waiting' ? 'warning' : status === 'running' ? 'accent' : '';
  const label = { success: 'Succeeded', error: 'Error', crashed: 'Crashed', waiting: 'Waiting', running: 'Running', canceled: 'Canceled', new: 'Queued' }[status] ?? status;
  return <span className={`badge ${kind}`}>{status === 'running' && <Icons.LoaderCircle size={11} className="spin" />}{label}</span>;
}
