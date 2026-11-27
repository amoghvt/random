/**
 * Session direction call (pure).
 *
 * Rule, as tested in research/session_direction_signal.py on 731 Nasdaq cash sessions (2023-01 to 2026-10):
 * at every half hour from 10:00 to 15:30 New York time, compare the price with the "noise band" around the open:
 *   upper = max(session open, prior close) x (1 + s),  lower = min(session open, prior close) x (1 - s)
 * where s is the average absolute move from the open to that time of day over the previous 14 sessions.
 * The first time price is above the upper band the call is UP; below the lower band, DOWN. One call per day.
 *
 * Measured from the next bar's open to the close: 57% closed further in the called direction; 63% when the call
 * agrees with the 50-day trend, 49% when it does not. Price typically moved 65 to 77 points against the call first,
 * so this is a direction filter, not an entry with a tight stop.
 *
 * Input candles are 15-minute bars (any source), ascending. Bars are keyed by New York time.
 */
import { NotificationIntent, dayKey, iso, minutesOfDay, zoned, type Candle } from '@desk/contracts';

export const OPEN_MIN = 570; // 09:30
export const CLOSE_MIN = 960; // 16:00
export const CHECK_MINUTES: readonly number[] = [600, 630, 660, 690, 720, 750, 780, 810, 840, 870, 900, 930];
export const LOOKBACK = 14;
export const MIN_SESSIONS = 10;
export const TREND_DAYS = 50;

/** What the 2023-2026 test measured, quoted next to every live call so the number travels with it. */
export const RESEARCH = {
  period: '2023-01 to 2026-10', sessions: 731,
  all: { n: 414, rightPct: 57, avgPts: 19.7 },
  withTrend: { n: 218, rightPct: 63, avgPts: 19.4, heatPts: 65 },
  againstTrend: { n: 196, rightPct: 49, avgPts: 20.1, heatPts: 91 },
} as const;

export interface Session {
  day: string;
  open: number;
  openT: number;
  /** Price at each half-hour check: the close of the 15-minute bar that ends at that minute. */
  marks: Record<number, number>;
  /** Open of the 15-minute bar that starts at each check minute: where a call made at that check can be acted on. */
  nextOpen: Record<number, number>;
  /** The 16:00 close, null while the session is still running. */
  close: number | null;
  bars: Candle[];
}

const BAR = 15;

export function buildSessions(candles: readonly Candle[]): Session[] {
  const by = new Map<string, Candle[]>();
  for (const c of candles) {
    const m = minutesOfDay(c.t);
    const wd = zoned(c.t).weekday;
    if (wd === 0 || wd === 6 || m < OPEN_MIN || m >= CLOSE_MIN) continue;
    const k = dayKey(c.t);
    const list = by.get(k) ?? [];
    list.push(c);
    by.set(k, list);
  }
  const out: Session[] = [];
  for (const [day, bars] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    bars.sort((a, b) => a.t - b.t);
    const first = bars.find((b) => minutesOfDay(b.t) === OPEN_MIN);
    if (!first) continue;
    const marks: Record<number, number> = {};
    const nextOpen: Record<number, number> = {};
    let close: number | null = null;
    for (const b of bars) {
      const m = minutesOfDay(b.t);
      if (CHECK_MINUTES.includes(m + BAR)) marks[m + BAR] = b.c;
      if (CHECK_MINUTES.includes(m)) nextOpen[m] = b.o;
      if (m + BAR === CLOSE_MIN) close = b.c;
    }
    out.push({ day, open: first.o, openT: first.t, marks, nextOpen, close, bars });
  }
  return out;
}

export interface Bands { minute: number; upper: number; lower: number; sigma: number; sessionsUsed: number }

/** The band at one check minute of `session`, from the sessions before it. Null without enough history. */
export function bandsAt(prior: readonly Session[], session: Session, minute: number): Bands | null {
  const prev = [...prior].reverse().find((s) => s.close !== null);
  if (!prev || prev.close === null) return null;
  const moves: number[] = [];
  for (let i = prior.length - 1; i >= 0 && moves.length < LOOKBACK; i--) {
    const s = prior[i]!;
    const mark = s.marks[minute];
    if (mark !== undefined) moves.push(Math.abs(mark / s.open - 1));
  }
  if (moves.length < MIN_SESSIONS) return null;
  const sigma = moves.reduce((a, b) => a + b, 0) / moves.length;
  return { minute, upper: Math.max(session.open, prev.close) * (1 + sigma), lower: Math.min(session.open, prev.close) * (1 - sigma), sigma, sessionsUsed: moves.length };
}

export type Side = 'up' | 'down';

export interface FiredCall {
  side: Side;
  minute: number;
  /** Time of the check that fired, epoch ms. */
  t: number;
  price: number;
  band: number;
  /** Open of the bar after the check, when it exists yet. */
  entry: number | null;
  agreesTrend: boolean | null;
  agreesGap: boolean;
}

function trendSide(daily: readonly Candle[], session: Session, prevClose: number): Side | null {
  const before = daily.filter((d) => d.t < session.openT - 6 * 3_600_000).slice(-TREND_DAYS);
  if (before.length < TREND_DAYS) return null;
  const avg = before.reduce((a, d) => a + d.c, 0) / before.length;
  return prevClose > avg ? 'up' : 'down';
}

/** The first call of `session`, looking only at checks at or before `uptoMinute`. */
export function firstCall(prior: readonly Session[], session: Session, daily: readonly Candle[], uptoMinute = CLOSE_MIN): { call: FiredCall | null; sessionsUsed: number; ready: boolean } {
  const prev = [...prior].reverse().find((s) => s.close !== null);
  let used = 0;
  let ready = false;
  for (const m of CHECK_MINUTES) {
    if (m > uptoMinute) break;
    const price = session.marks[m];
    const b = bandsAt(prior, session, m);
    if (b) { ready = true; used = b.sessionsUsed; }
    if (price === undefined || !b || !prev || prev.close === null) continue;
    const side: Side | null = price > b.upper ? 'up' : price < b.lower ? 'down' : null;
    if (!side) continue;
    const trend = trendSide(daily, session, prev.close);
    const gap: Side = session.open > prev.close ? 'up' : 'down';
    return {
      call: {
        side, minute: m, t: session.openT + (m - OPEN_MIN) * 60_000, price, band: side === 'up' ? b.upper : b.lower,
        entry: session.nextOpen[m] ?? null, agreesTrend: trend === null ? null : trend === side, agreesGap: gap === side,
      },
      sessionsUsed: b.sessionsUsed, ready: true,
    };
  }
  return { call: null, sessionsUsed: used, ready };
}

export type CallStatus = 'up' | 'down' | 'no_call_yet' | 'no_call_today' | 'before_first_check' | 'no_session' | 'not_enough_history';

export interface SessionCallView {
  instrument: string;
  asOf: string;
  day: string | null;
  status: CallStatus;
  call: (FiredCall & { firedAt: string; time: string; pointsSince: number | null; stillBeyondBand: boolean | null }) | null;
  /** The band at the next check (or the last one), so the trader can see how far price is from a call. */
  watch: { minute: number; time: string; upper: number; lower: number } | null;
  last: number | null;
  open: number | null;
  prevClose: number | null;
  sessionsUsed: number;
  /** One plain sentence on how much weight the call deserves, with the measured number. */
  read: string;
  research: typeof RESEARCH;
}

const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function qualityLine(call: Pick<FiredCall, 'side' | 'agreesTrend' | 'agreesGap'>): string {
  const dir = call.side === 'up' ? 'up' : 'down';
  if (call.agreesTrend === true) {
    return `With the 50-day trend${call.agreesGap ? ' and the overnight gap' : ''}: calls like this closed further ${dir} ${RESEARCH.withTrend.rightPct}% of the time (${RESEARCH.withTrend.n} cases, ${RESEARCH.period}). Typical move against it first: ${RESEARCH.withTrend.heatPts} points.`;
  }
  if (call.agreesTrend === false) {
    return `Against the 50-day trend: calls like this were right only ${RESEARCH.againstTrend.rightPct}% of the time (${RESEARCH.againstTrend.n} cases). Treat it as no edge on direction.`;
  }
  return `Trend not known (fewer than ${TREND_DAYS} daily bars): all calls together were right ${RESEARCH.all.rightPct}% of the time.`;
}

/** The live view at `now`: today's call if one fired, otherwise how far price is from one. */
export function sessionCall(candles15: readonly Candle[], daily: readonly Candle[], now: number, instrument = 'NQ'): SessionCallView {
  const upto = candles15.filter((c) => c.t + BAR * 60_000 <= now);
  const sessions = buildSessions(upto);
  const today = dayKey(now);
  const base: SessionCallView = {
    instrument, asOf: iso(now), day: null, status: 'no_session', call: null, watch: null, last: upto.at(-1)?.c ?? null, open: null, prevClose: null,
    sessionsUsed: 0, read: 'No cash session is open. The call is made at each half hour from 10:00 to 15:30 New York time.', research: RESEARCH,
  };
  const idx = sessions.findIndex((s) => s.day === today);
  if (idx < 0) return base;
  const session = sessions[idx]!;
  const prior = sessions.slice(0, idx);
  const prev = [...prior].reverse().find((s) => s.close !== null);
  const nowMin = minutesOfDay(now);
  const { call, sessionsUsed, ready } = firstCall(prior, session, daily, nowMin);
  const view: SessionCallView = { ...base, day: today, open: session.open, prevClose: prev?.close ?? null, sessionsUsed, last: session.bars.at(-1)?.c ?? base.last };
  const nextCheck = CHECK_MINUTES.find((m) => m > nowMin) ?? CHECK_MINUTES[CHECK_MINUTES.length - 1]!;
  const wb = bandsAt(prior, session, nextCheck);
  view.watch = wb ? { minute: nextCheck, time: clock(nextCheck), upper: wb.upper, lower: wb.lower } : null;
  if (call) {
    const last = view.last;
    const ref = call.entry ?? call.price;
    return {
      ...view, status: call.side,
      call: {
        ...call, firedAt: iso(call.t), time: clock(call.minute),
        pointsSince: last === null ? null : (last - ref) * (call.side === 'up' ? 1 : -1),
        stillBeyondBand: last === null ? null : call.side === 'up' ? last > call.band : last < call.band,
      },
      read: qualityLine(call),
    };
  }
  if (nowMin < CHECK_MINUTES[0]!) return { ...view, status: 'before_first_check', read: 'First check is at 10:00 New York time.' };
  if (!ready) return { ...view, status: 'not_enough_history', read: `Fewer than ${MIN_SESSIONS} earlier sessions of 15-minute bars are stored, so the band cannot be computed yet.` };
  if (nowMin >= CHECK_MINUTES[CHECK_MINUTES.length - 1]!) return { ...view, status: 'no_call_today', read: 'Price stayed inside its normal range at every check today: no trend-day call.' };
  return { ...view, status: 'no_call_yet', read: `No call yet: price is inside its normal range for this time of day. Next check ${clock(nextCheck)}.` };
}

export interface ScoredCall { day: string; side: Side; time: string; entry: number; close: number; points: number; right: boolean; heat: number; agreesTrend: boolean | null; agreesGap: boolean }
export interface Tally { n: number; right: number; rightPct: number | null; avgPts: number | null }
export interface Scorecard { from: string | null; to: string | null; sessions: number; all: Tally; withTrend: Tally; againstTrend: Tally; last: ScoredCall[] }

const tally = (v: ScoredCall[]): Tally => ({
  n: v.length, right: v.filter((x) => x.right).length,
  rightPct: v.length ? Math.round((v.filter((x) => x.right).length / v.length) * 100) : null,
  avgPts: v.length ? Math.round((v.reduce((a, x) => a + x.points, 0) / v.length) * 10) / 10 : null,
});

/** The rule replayed over every finished session in the stored candles: the desk's own record of the call. */
export function scorecard(candles15: readonly Candle[], daily: readonly Candle[], keep = 20): Scorecard {
  const sessions = buildSessions(candles15);
  const scored: ScoredCall[] = [];
  let counted = 0;
  let from: string | null = null;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    if (s.close === null) continue;
    const { call, ready } = firstCall(sessions.slice(0, i), s, daily);
    if (!ready) continue;
    counted++;
    from ??= s.day;
    if (!call || call.entry === null) continue;
    const sign = call.side === 'up' ? 1 : -1;
    const after = s.bars.filter((b) => minutesOfDay(b.t) >= call.minute);
    const heat = Math.max(0, ...after.map((b) => (call.side === 'up' ? call.entry! - b.l : b.h - call.entry!)));
    const points = (s.close - call.entry) * sign;
    scored.push({ day: s.day, side: call.side, time: clock(call.minute), entry: call.entry, close: s.close, points, right: points > 0, heat, agreesTrend: call.agreesTrend, agreesGap: call.agreesGap });
  }
  return {
    from, to: sessions.filter((s) => s.close !== null).at(-1)?.day ?? null, sessions: counted,
    all: tally(scored), withTrend: tally(scored.filter((x) => x.agreesTrend === true)), againstTrend: tally(scored.filter((x) => x.agreesTrend === false)),
    last: scored.slice(-keep).reverse(),
  };
}

const fmt = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** The push for a call that just fired. One per instrument per day. */
export function callNotification(view: SessionCallView): NotificationIntent | null {
  if (!view.call || !view.day) return null;
  const c = view.call;
  const word = c.side === 'up' ? 'UP' : 'DOWN';
  return NotificationIntent.parse({
    class: c.agreesTrend === true ? 'P1' : 'P2', reason: 'session_call', instrument: view.instrument, ts: c.firedAt,
    lines: [
      `${view.instrument} session call ${word} at ${c.time} New York: ${fmt(c.price)} is ${c.side === 'up' ? 'above' : 'below'} the ${fmt(c.band)} band.`,
      qualityLine(c).slice(0, 240),
    ],
    deepLink: '/?panel=session', dedupeKey: `session_call:${view.instrument}:${view.day}`,
  });
}
