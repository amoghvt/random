'use client';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import type { GuardrailFiring } from '@desk/contracts';
import { localHHMM, pretty } from '@/lib/format';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'mute';
const TONE: Record<Tone, string> = {
  good: 'text-up border-up/40 bg-up/10', warn: 'text-warn border-warn/40 bg-warn/10', bad: 'text-down border-down/50 bg-down/10',
  info: 'text-info border-info/40 bg-info/10', mute: 'text-mute border-line bg-raise',
};

export function Chip({ tone = 'mute', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase leading-4 tracking-wide ${TONE[tone]} ${className}`}>{children}</span>;
}

export function Card({ title, right, children, className = '', id }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      {(title || right) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** Shown when the latest fetch failed and the view is rendering the last-known state. */
export function Stale({ since, error }: { since: number | null; error?: string | null }) {
  if (since == null) return null;
  return (
    <p role="status" data-testid="stale" className="mb-3 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
      Stale since {localHHMM(since)}{error ? ` · ${error}` : ''}
    </p>
  );
}
/** The age of one stale value, beside the value. */
export function Age({ stale, age }: { stale: boolean; age: string | null }) {
  return stale ? <span className="ml-1 whitespace-nowrap text-[11px] font-medium text-warn">{age ?? '?'} old</span> : null;
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-2">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="h-4 rounded bg-raise" style={{ width: `${90 - i * 18}%` }} />)}
    </div>
  );
}
export function ErrorLine({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <p role="alert" className="text-sm text-down">
      {error}{retry && <button type="button" onClick={retry} className="ml-2 underline">Retry</button>}
    </p>
  );
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-mute">{children}</p>;

type BtnKind = 'primary' | 'ghost' | 'danger' | 'quiet';
const BTN: Record<BtnKind, string> = {
  primary: 'bg-info text-bg font-semibold', ghost: 'border border-line bg-raise text-ink', danger: 'border border-down/60 bg-down/10 text-down font-semibold', quiet: 'text-info',
};
const btnCls = (kind: BtnKind, block: boolean, extra: string) =>
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm transition-opacity disabled:opacity-40 ${BTN[kind]} ${block ? 'w-full' : ''} ${extra}`;
export function Btn({ kind = 'ghost', block = false, className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; block?: boolean }) {
  return <button type="button" {...p} className={btnCls(kind, block, className)} />;
}
export function LinkBtn({ href, kind = 'ghost', block = false, className = '', children, ...rest }: { href: string; kind?: BtnKind; block?: boolean; className?: string; children: ReactNode; 'data-testid'?: string }) {
  return <Link href={href} {...rest} className={btnCls(kind, block, className)}>{children}</Link>;
}

export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium text-mute"><span>{label}</span>{hint && <span className="text-dim">{hint}</span>}</span>
      {children}
      {error && <span role="alert" className="mt-1 block text-xs text-down">{error}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-xl border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          className={`min-h-10 flex-1 rounded-[10px] px-2 text-sm ${o.value === value ? 'bg-raise font-semibold text-ink' : 'text-mute'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on desktop. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 lg:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-line bg-panel p-4 pb-[calc(16px+var(--sab))] lg:rounded-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 flex h-11 w-11 items-center justify-center text-xl text-mute">×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** A guardrail firing, worded by the server. */
export function Guardrail({ f }: { f: Pick<GuardrailFiring, 'pattern' | 'text' | 'blocks' | 'effect'> }) {
  const tone = f.blocks || f.effect === 'block' || f.effect === 'read_only' ? 'border-down/50 bg-down/10' : 'border-warn/40 bg-warn/10';
  return (
    <div data-testid="guardrail" className={`rounded-xl border px-3 py-2 ${tone}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-mute">{pretty(f.pattern)}{f.effect !== 'none' ? ` · ${pretty(f.effect)}` : ''}</p>
      <p className="mt-0.5 text-sm">{f.text}</p>
    </div>
  );
}

/** Label over value, numbers first. */
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'flat' | 'warn' }) {
  const c = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] uppercase tracking-wide text-mute">{label}</div>
      <div className={`text-base font-semibold ${c}`}>{value}</div>
      {sub && <div className="text-xs text-mute">{sub}</div>}
    </div>
  );
}
export const toneOf = (x: number | null | undefined): 'up' | 'down' | 'flat' => (x == null || x === 0 ? 'flat' : x > 0 ? 'up' : 'down');
