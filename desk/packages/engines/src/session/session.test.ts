import { describe, expect, it } from 'vitest';
import { fromZoned, type Candle } from '@desk/contracts';
import { loadRecordedCandles } from '@desk/feeds';
import { CHECK_MINUTES, buildSessions, callNotification, firstCall, scorecard, sessionCall } from './index';

const bar = (t: number, o: number, c: number): Candle => ({ symbol: 'NQ', tf: '15m', t, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 1, source: 'test' });

/** A session whose price walks linearly from `open` to `open * (1 + move)` by 16:00. */
function day(y: number, m: number, d: number, open: number, move: number): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < 26; k++) {
    const t = fromZoned(y, m, d, 9, 30) + k * 15 * 60_000;
    out.push(bar(t, open * (1 + (move * k) / 26), open * (1 + (move * (k + 1)) / 26)));
  }
  return out;
}
const daily = (n: number, close: number, endT: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ symbol: 'NQ', tf: '1d' as const, t: endT - (n - i) * 86_400_000, o: close, h: close, l: close, c: close, v: 1, source: 'test' }));

// 15 quiet weekdays in June 2025 (each drifts 0.2% by the close), then a test day.
const quietDays = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20];
const history = quietDays.flatMap((d, i) => day(2025, 6, d, 20_000, i % 2 ? 0.002 : -0.002));

describe('session direction call', () => {
  it('groups 15-minute bars into cash sessions with half-hour marks', () => {
    const s = buildSessions(history);
    expect(s).toHaveLength(15);
    expect(Object.keys(s[0]!.marks)).toHaveLength(CHECK_MINUTES.length);
    expect(s[0]!.close).not.toBeNull();
  });

  it('calls UP at the first check where price is above the band, and says whether trend and gap agree', () => {
    const today = day(2025, 6, 23, 20_100, 0.02); // strong up day opening above the prior close
    const sessions = buildSessions([...history, ...today]);
    const t0 = fromZoned(2025, 6, 23, 9, 30);
    const { call } = firstCall(sessions.slice(0, 15), sessions[15]!, daily(60, 19_000, t0));
    expect(call?.side).toBe('up');
    expect(call?.minute).toBe(600);
    expect(call?.agreesTrend).toBe(true);
    expect(call?.agreesGap).toBe(true);
    expect(call?.entry).toBeCloseTo(sessions[15]!.nextOpen[600]!, 6);
  });

  it('never uses bars that have not closed yet', () => {
    const today = day(2025, 6, 23, 20_100, 0.02);
    const all = [...history, ...today];
    const before = sessionCall(all, [], fromZoned(2025, 6, 23, 9, 50));
    expect(before.status).toBe('before_first_check');
    expect(before.call).toBeNull();
    const at = sessionCall(all, [], fromZoned(2025, 6, 23, 10, 0) + 1000);
    expect(at.status).toBe('up');
    expect(at.call?.time).toBe('10:00');
    expect(at.call?.agreesTrend).toBeNull();
  });

  it('gives no call on a day that stays inside its normal range', () => {
    const today = day(2025, 6, 23, 20_000, 0.0005);
    const v = sessionCall([...history, ...today], [], fromZoned(2025, 6, 23, 16, 5));
    expect(v.status).toBe('no_call_today');
    expect(callNotification(v)).toBeNull();
  });

  it('reports not enough history instead of guessing', () => {
    const v = sessionCall([...history.slice(0, 26 * 4), ...day(2025, 6, 23, 20_100, 0.02)], [], fromZoned(2025, 6, 23, 11, 0));
    expect(v.status).toBe('not_enough_history');
  });

  it('builds one push per day, P1 only when the call agrees with the trend', () => {
    const t0 = fromZoned(2025, 6, 23, 9, 30);
    const all = [...history, ...day(2025, 6, 23, 20_100, 0.02)];
    const up = callNotification(sessionCall(all, daily(60, 19_000, t0), t0 + 45 * 60_000));
    expect(up?.class).toBe('P1');
    expect(up?.dedupeKey).toBe('session_call:NQ:2025-06-23');
    expect(up?.lines[0]).toMatch(/session call UP at 10:00/);
    const against = callNotification(sessionCall(all, daily(60, 25_000, t0), t0 + 45 * 60_000));
    expect(against?.class).toBe('P2');
    expect(against?.lines[1]).toMatch(/Against the 50-day trend/);
  });

  it('scores itself on recorded Nasdaq candles', () => {
    const sc = scorecard(loadRecordedCandles('NQ', '15m'), loadRecordedCandles('NQ', '1d'));
    expect(sc.sessions).toBeGreaterThan(15);
    expect(sc.all.n).toBeGreaterThan(5);
    expect(sc.withTrend.n + sc.againstTrend.n).toBeLessThanOrEqual(sc.all.n);
    for (const c of sc.last) expect(c.right).toBe(c.points > 0);
  });
});
