import {
  DAY, ET, HOUR, INSTRUMENTS, TicketReason, dayKey, fmtNum, hashId, hhmm, inWindow, ms,
  type Candle, type Catalyst, type SizingResult, type StructureEvent,
} from '@desk/contracts';
import type { GuardrailContext, TicketInput, TicketLike } from './context';
import { thresholdsOf } from './context';
import { findFlushes, type FlushState } from './flush';

export const priceSym = (instrument: string): string => INSTRUMENTS[instrument]?.priceSymbol ?? instrument;
export const isFuture = (instrument: string): boolean => (INSTRUMENTS[instrument]?.pointValue ?? 0) > 0;
export const sign = (direction: 'long' | 'short'): 1 | -1 => (direction === 'long' ? 1 : -1);
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Collects every formatted number that goes into a firing's text, so a test can prove none was invented. */
export function shownValues(): { (s: string): string; all: string[] } {
  const all: string[] = [];
  const f = (s: string): string => { all.push(s); return s; };
  return Object.assign(f, { all });
}

export const fmtPrice = (x: number): string => fmtNum(x, Number.isInteger(x) ? 0 : 2);
export const fmtPts = (x: number): string => { const r = Math.round(Math.abs(x)); return `${fmtNum(r)} ${r === 1 ? 'point' : 'points'}`; };
export const fmtPctAbs = (x: number, dp = 1): string => `${Math.abs(x).toFixed(dp)}%`;
export const fmtSignedPct = (x: number, dp = 1): string => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(dp)}%`;
/** Contracts for futures, USD notional for everything else. */
export function fmtUnits(instrument: string, units: number): string {
  return isFuture(instrument) ? `${fmtNum(units)} ${units === 1 ? 'contract' : 'contracts'}` : `$${fmtNum(Math.round(units))}`;
}
/** "19h", "40 minutes", "5 days". */
export function fmtElapsed(hours: number): string {
  if (hours < 1) { const m = Math.max(1, Math.round(hours * 60)); return `${m} ${m === 1 ? 'minute' : 'minutes'}`; }
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}
export const etClock = (t: string | number): string => `${hhmm(t, ET)} ET`;

export function sizingFor(ctx: GuardrailContext, accountId: string, instrument: string): SizingResult | undefined {
  const s = ctx.sizing;
  return s && s.accountId === accountId && priceSym(s.instrument) === priceSym(instrument) ? s : undefined;
}

/** A saved ticket or a draft, reduced to what the rules read. A draft's ref is stable across re-submits. */
export function normalizeTicket(t: TicketLike, ctx: GuardrailContext): TicketInput {
  const reason = TicketReason.safeParse(t.reason);
  const catalystId = reason.success && reason.data.kind === 'catalyst' ? reason.data.catalystId : null;
  if ('id' in t && 'size' in t) {
    return { ref: t.id, saved: true, accountId: t.accountId, instrument: t.instrument, direction: t.direction, units: t.size.units, notionalUsd: t.size.notionalUsd, engineMaxUnits: t.size.engineMaxUnits, catalystId };
  }
  const sizing = sizingFor(ctx, t.accountId, t.instrument);
  const units = t.units ?? sizing?.maxUnits ?? null;
  let notionalUsd: number | null = null;
  if (units != null) {
    if (!isFuture(t.instrument)) notionalUsd = units;
    else if (sizing && sizing.maxUnits > 0) notionalUsd = (sizing.notionalUsd * units) / sizing.maxUnits;
  }
  return {
    ref: hashId('draft', t.accountId, t.instrument, t.direction, JSON.stringify(t.reason ?? null), JSON.stringify(t.entry ?? null)),
    saved: false, accountId: t.accountId, instrument: t.instrument, direction: t.direction, units, notionalUsd, engineMaxUnits: sizing?.maxUnits ?? null, catalystId,
  };
}

export function flushesFor(ctx: GuardrailContext, sym: string): FlushState[] {
  const pre = ctx.confirmationDays?.[sym];
  if (pre) return pre;
  const d1 = ctx.candles.d1[sym];
  return d1 ? findFlushes(d1, ctx.now, thresholdsOf(ctx)) : [];
}

/** Wilder-free simple ATR over the last `n` completed 1-minute candles; null when there are too few. */
export function atr1m(m1: Candle[] | undefined, now: number, n = 14): number | null {
  const done = (m1 ?? []).filter((c) => c.t + 60_000 <= now).sort((a, b) => a.t - b.t).slice(-(n + 1));
  if (done.length < n + 1) return null;
  let sum = 0;
  for (let i = 1; i < done.length; i++) {
    const c = done[i]!, p = done[i - 1]!;
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / n;
}

/** Local calendar day of `now`, and the "night" a late-night instant belongs to (00:30 belongs to the previous evening). */
export const localDay = (ctx: GuardrailContext): string => dayKey(ctx.now, ctx.tz);
export function localNight(ctx: GuardrailContext): string {
  const { from } = ctx.profile.circuitBreakers.lateNight;
  return inWindow(ctx.now, from, '24:00', ctx.tz) ? dayKey(ctx.now, ctx.tz) : dayKey(ctx.now - DAY, ctx.tz);
}

const covers = (c: Catalyst, syms: string[]): boolean => syms.length === 0 || c.instruments.length === 0 || c.instruments.some((i) => syms.includes(priceSym(i))) || (c.symbol !== undefined && syms.includes(priceSym(c.symbol)));
/** Scheduled (not ad-hoc), unresolved catalysts ahead of `now` covering the symbols, soonest first. */
export function upcomingCatalysts(ctx: GuardrailContext, syms: string[] = []): Catalyst[] {
  return ctx.catalysts
    .filter((c) => c.code !== 'ADHOC' && c.status !== 'resolved' && ms(c.scheduledAt) >= ctx.now && covers(c, syms))
    .sort((a, b) => ms(a.scheduledAt) - ms(b.scheduledAt));
}
export const hoursUntil = (ctx: GuardrailContext, at: string): number => (ms(at) - ctx.now) / HOUR;

export function recentEvents(ctx: GuardrailContext, detector: StructureEvent['detector'], syms: string[], maxAgeMs: number): StructureEvent[] {
  return ctx.structure
    .filter((e) => e.detector === detector && (syms.length === 0 || syms.includes(priceSym(e.instrument))) && ms(e.ts) <= ctx.now && ctx.now - ms(e.ts) <= maxAgeMs)
    .sort((a, b) => ms(b.ts) - ms(a.ts));
}
/** First finite number under any of the keys; the watcher's `data` is an open record. */
export function num(data: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) { const v = data[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return null;
}
export function str(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) { const v = data[k]; if (typeof v === 'string' && v.length > 0) return v; }
  return null;
}
