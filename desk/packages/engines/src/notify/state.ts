/** Serializable notification policy state. Lives in kv `notify.state`; plain JSON, no Dates or Maps. */
import { DAY, ET, HOUR, INSTRUMENTS, MIN, dayKey, hashId, zoned } from '@desk/contracts';
import type { Notification, NotifyClass } from '@desk/contracts';

export const P0_REPEAT_MS = 5 * MIN;
export const P1_AFTER_P0_MS = 10 * MIN;
export const TAP_WINDOW_MS = 15 * MIN;
export const P0_ONLY_MS = 2 * HOUR;
export const IGNORED_P1_LIMIT = 3;
/** Hard ceilings from spec section 10. The profile may lower them, never raise them. */
export const P1_SESSION_MAX = 8;
export const P2_DAY_MAX = 6;

export interface NotifyLogEntry {
  id: string; class: NotifyClass; reason: string; instrument: string | null; dedupeKey: string;
  /** Epoch ms of the decision. */
  at: number;
  decision: 'sent' | 'suppressed'; suppressedBy: string | null;
  tappedAt: number | null;
  /** Sent P1s only: whether the trader tapped within 15 minutes. */
  attention: 'pending' | 'tapped' | 'ignored' | null;
}

export interface NotifyState {
  version: 1;
  /** Every decision of the last 48 hours, oldest first. */
  log: NotifyLogEntry[];
  /** First decision per dedupe key (14 days). `held` = suppressed by quiet hours and listed in the morning brief. */
  keys: Record<string, { at: number; decision: 'sent' | 'held' | 'suppressed' }>;
  p1: { session: string; count: number };
  p2: { day: string; count: number };
  /** Normalized hash of the last notification actually sent. */
  lastContentHash: string | null;
  ignoredP1Streak: number;
  /** P1s decided at or before this instant no longer count toward the ignored streak. */
  streakFloor: number;
  p0OnlyUntil: number | null;
  lastP0ByKey: Record<string, { at: number; hash: string }>;
  /** Keyed by the underlying price symbol, so NQ, MNQ and NQ-PERP share one clock. */
  lastP0ByInstrument: Record<string, number>;
  held: Notification[];
}

export function emptyNotifyState(): NotifyState {
  return {
    version: 1, log: [], keys: {}, p1: { session: '', count: 0 }, p2: { day: '', count: 0 }, lastContentHash: null,
    ignoredP1Streak: 0, streakFloor: 0, p0OnlyUntil: null, lastP0ByKey: {}, lastP0ByInstrument: {}, held: [],
  };
}

/**
 * The P1 budget's "US session" is the CME Globex trade date: 18:00 ET to 18:00 ET, labelled with the
 * ET date it closes on. Sunday 18:00 ET opens Monday's session; an 03:00 ET alert and the 15:00 ET
 * alert that follows share one budget; the count resets at 18:00 ET. Wall-clock based, so DST-safe.
 */
export function usSessionKey(now: number): string {
  const z = zoned(now, ET);
  return new Date(Date.UTC(z.year, z.month - 1, z.day + (z.hour >= 18 ? 1 : 0))).toISOString().slice(0, 10);
}

/** NQ, MNQ and NQ-PERP are one instrument for the P0-then-P1 rule. */
export const instrumentKey = (symbol: string): string => INSTRUMENTS[symbol]?.priceSymbol ?? symbol;

/** Hash of the normalized text: case, spacing and trailing punctuation do not make content new; a number does. */
export function contentHash(lines: readonly string[]): string {
  return hashId('nc', lines.map((l) => l.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!…]+$/, '')).join('\n'));
}

/** Deterministic id, so a builder can put it in the `/ticket?prefill=<id>` deep link before `decide` runs. */
export const notificationId = (intent: { dedupeKey: string; ts: string }): string => hashId('ntf', intent.dedupeKey, intent.ts);

const prune = <T>(rec: Record<string, T>, keep: (v: T) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([, v]) => keep(v)));

/** Resets the session and day counters when their boundary has passed and drops expired history. */
export function rollState(state: NotifyState, now: number, tz: string): NotifyState {
  const session = usSessionKey(now);
  const day = dayKey(now, tz);
  return {
    ...state,
    p1: state.p1.session === session ? state.p1 : { session, count: 0 },
    p2: state.p2.day === day ? state.p2 : { day, count: 0 },
    log: state.log.filter((e) => now - e.at < 2 * DAY).slice(-500),
    keys: prune(state.keys, (k) => now - k.at < 14 * DAY),
    lastP0ByKey: prune(state.lastP0ByKey, (k) => now - k.at < DAY),
    lastP0ByInstrument: prune(state.lastP0ByInstrument, (at) => now - at < DAY),
    held: state.held.slice(-100),
  };
}

/** What quiet hours held back, oldest first, for the morning brief. */
export const heldForMorning = (state: NotifyState): Notification[] => state.held;
/** Call once the morning brief has listed the held items. */
export const clearHeld = (state: NotifyState): NotifyState => ({ ...state, held: [] });
