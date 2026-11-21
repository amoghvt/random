/** Display helpers. Formatting only: no sizes, no calls are computed in the client. */
const ET = 'America/New_York';
const MINUS = '−';

export const fmtNum = (x: number, dp = 0): string =>
  x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** 27062 -> "27,062"; 27062.25 -> "27,062.25"; 142.3 -> "142.30". */
export const fmtPrice = (x: number): string =>
  Math.abs(x) >= 1000
    ? x.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (x: number, dp = 2): string => `${x >= 0 ? '+' : MINUS}${Math.abs(x).toFixed(dp)}%`;
export const fmtUsd = (x: number): string => `${x < 0 ? MINUS : ''}$${fmtNum(Math.abs(Math.round(x)))}`;
export const fmtSignedUsd = (x: number): string => `${x < 0 ? MINUS : '+'}$${fmtNum(Math.abs(Math.round(x)))}`;
export const fmtBp = (x: number): string => `${x >= 0 ? '+' : MINUS}${Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0)} bp`;
export const fmtProb = (p: number): string => p.toFixed(2);
export const fmtShare = (p: number): string => `${Math.round(p * 100)}%`;
/** Compact USD for notionals: 1,082,480 -> "$1.08M". */
export const fmtUsdCompact = (x: number): string => {
  const a = Math.abs(x);
  const s = x < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${fmtNum(Math.round(a))}`;
};
/** Contracts print as a count; notional-sized units print as USD. */
export const fmtUnits = (u: number): string => (Number.isInteger(u) && u < 1000 ? String(u) : fmtUsdCompact(u));

const dtf = (opts: Intl.DateTimeFormatOptions, tz?: string) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz });
const fTimeET = dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, ET);
const fDayET = dtf({ weekday: 'short', month: 'short', day: 'numeric' }, ET);
const fKeyET = dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }, ET);
const fLocal = dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

type T = string | number | null | undefined;
const valid = (iso: T): iso is string | number => iso != null && !Number.isNaN(typeof iso === 'number' ? iso : Date.parse(iso));
export const timeET = (iso: T): string => (valid(iso) ? `${fTimeET.format(new Date(iso))} ET` : '—');
export const dayET = (iso: T): string => (valid(iso) ? fDayET.format(new Date(iso)) : '—');
export const dayTimeET = (iso: T): string => (valid(iso) ? `${dayET(iso)} ${timeET(iso)}` : '—');
export const dayKeyET = (iso: string | number): string => fKeyET.format(new Date(iso));
export const localHHMM = (t: number): string => fLocal.format(new Date(t));

/** "2d 4h", "3h 12m", "12:05". The sign is the caller's to word. */
export function countdown(msLeft: number): string {
  const s = Math.floor(Math.abs(msLeft) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
export function ago(iso: T, now: number): string {
  if (!valid(iso)) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
/** datetime-local value <-> ISO. */
export const toLocalInput = (iso: string | undefined): string => {
  if (!valid(iso)) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): string | undefined => {
  const t = Date.parse(v);
  return v && !Number.isNaN(t) ? new Date(t).toISOString() : undefined;
};
export const num = (v: string): number | undefined => {
  const n = Number(v.replace(/,/g, ''));
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
};

const CALL_TEXT: Record<string, string> = { strong_long: 'Strong long', lean_long: 'Lean long', no_edge: 'No edge', lean_short: 'Lean short', strong_short: 'Strong short' };
export const callText = (c: string): string => CALL_TEXT[c] ?? c;
export const callTone = (c: string): 'up' | 'down' | 'flat' => (c.endsWith('long') ? 'up' : c.endsWith('short') ? 'down' : 'flat');
export const pretty = (s: string): string => s.replace(/_/g, ' ');
/** The price series a tradable instrument tracks, for chart lookups (NQ-PERP and MNQ chart as NQ). */
export const chartSymbol = (instrument: string): string => (instrument === 'NQ-PERP' || instrument === 'MNQ' ? 'NQ' : instrument);
