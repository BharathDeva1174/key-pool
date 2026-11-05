import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { classNames, HEALTH_STYLES, type HealthLevel } from '../lib/format';
import { t } from '../lib/i18n';
import { Icon } from './Icon';

// ---------------------------------------------------------------- primitives

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classNames('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div>
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="card-pad">{children}</div>
    </section>
  );
}

/**
 * Bumped only when the displayed value actually changes.
 *
 * Feeding this to the element's `key` remounts it, which is what replays the
 * settle animation. Doing it with a class alone would not: React would see the
 * class unchanged and leave the animation already finished.
 */
function useReadoutTick(value: unknown): number {
  const [tick, setTick] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value) {
      previous.current = value;
      setTick((t) => t + 1);
    }
  }, [value]);
  return tick;
}

/**
 * One figure in the register.
 *
 * A ruled cell, not a card - a page made of equal cards gives every number the
 * same weight and therefore makes them all ignorable. The label sits above a
 * baseline-aligned value, and the whole cell can be laid into a shared ruled
 * band by the page.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'bad';
  className?: string;
}) {
  const tick = useReadoutTick(value);
  const toneClass = {
    default: 'text-fg',
    ok: 'text-ok',
    warn: 'text-warn',
    bad: 'text-bad',
  }[tone];
  return (
    <div className={classNames('min-w-0 px-4 py-3', className)}>
      <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</p>
      <p
        key={tick}
        className={classNames(
          'tnum relative mt-1.5 font-mono text-2xl leading-none font-semibold',
          tick > 0 && 'readout',
          toneClass,
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/**
 * Health as a lamp and a word, not a filled pill.
 *
 * A badge's fill competes with the figures it sits beside; a lamp reads at a
 * glance from across a desk, which is the whole point of a wall display.
 */
export function StatusBadge({ level, children }: { level: HealthLevel; children?: ReactNode }) {
  const s = HEALTH_STYLES[level];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-subtle">
      <span className={classNames('h-1.5 w-1.5 rounded-full', s.dot)} />
      {children ?? t(s.label)}
    </span>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <p className="text-sm font-medium text-subtle">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-muted">
      {/* A hairline ring with one accent segment - the same construction as the
          theme thumb and the contents bar, so a load reads as part of this
          instrument rather than as a browser widget dropped onto the page. The
          segment is a shade heavier than the rest of the ring, which is what
          makes it read as a travelling arc rather than a plain spinner. */}
      <span className="h-3.5 w-3.5 animate-spin rounded-full border border-line-strong border-t-[1.5px] border-t-accent motion-reduce:animate-none" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-bad/40 bg-bad/8 px-3 py-2 text-sm text-bad">
      {message}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={classNames(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'border border-line-strong bg-raised',
        )}
      >
        {/*
          The knob is anchored with an explicit `left` and moved by a pure
          translate, so its travel is measured from a known origin.

          Geometry: track 44px, knob 20px, inset 2px each side. That leaves
          exactly 20px of travel - `translate-x-0` rests it against the left
          inset, `translate-x-5` against the right. Deriving the resting offset
          from the static position instead made the two states asymmetric by
          2px, so the knob stopped short of the far end of the track and the
          switch looked off-centre.
        */}
        <span
          className={classNames(
            'absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform',
            checked ? 'translate-x-5 bg-accent-ink' : 'translate-x-0 bg-muted',
          )}
        />
      </button>
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // A dialog that opens without taking the keyboard leaves the tab order
    // pointing at whatever was behind it, so the first Tab walked the page
    // underneath instead of the fields just laid down.
    sheet.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="veil-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-canvas/80 p-4 backdrop-blur-[2px] sm:p-8"
      onClick={(e) => {
        // Click-away dismisses, but only a click that landed on the veil
        // itself. Without the target check, a click on any input inside the
        // dialog would close it and throw away what was typed.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={classNames('sheet-in card my-auto w-full outline-none', wide ? 'max-w-3xl' : 'max-w-lg')}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <button
            onClick={onClose}
            aria-label={t('Close')}
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-raised hover:text-fg"
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="card-pad">{children}</div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- toasts

type Toast = { id: number; kind: 'ok' | 'bad' | 'info'; text: string; leaving?: boolean };
const ToastContext = createContext<{ push: (kind: Toast['kind'], text: string) => void }>({ push: () => {} });

const TOAST_HOLD_MS = 5000;
const TOAST_OUT_MS = 140;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    // Two steps rather than one: hold, then mark the toast as leaving so the
    // stylesheet can play the exit, and only drop it from the tree once that
    // exit has run. Removing it outright is what made it disappear between
    // frames while taking 200ms to arrive.
    setTimeout(() => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_OUT_MS);
    }, TOAST_HOLD_MS);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            // role=status + polite: a toast reports an outcome that already
            // happened, so it must not interrupt whatever the operator is doing.
            role="status"
            aria-live="polite"
            className={classNames(
              'pointer-events-auto flex items-start gap-2 rounded-[var(--radius-control)] border bg-surface px-3 py-2 text-sm',
              t.leaving ? 'toast-out' : 'toast-in',
              t.kind === 'ok' && 'border-ok/45 text-ok',
              t.kind === 'bad' && 'border-bad/45 text-bad',
              t.kind === 'info' && 'border-line text-subtle',
            )}
          >
            <Icon name={t.kind === 'bad' ? 'warn' : t.kind === 'ok' ? 'check' : 'info'} size={14} className="mt-0.5" />
            <span className="tnum">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
