/**
 * The replay on the real recording. One run over 2026-11-09 to 2026-11-13 (the real Nov 10 CPI and Nov 13 PPI) feeds
 * most assertions; nothing here is synthetic market data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY, KV, TF_MS, type BiasCall, type Timeframe } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { bias } from '@desk/engines';
import { isReplayCall, type CalibrationTable } from '../services/bias';
import { REPLAY_KV, formatSummary, isReplayCatalyst, isReplayEvent, recordedEnd, replay, replayWindow, resolutionAt, type ReplaySummary } from './index';
import { ViewStore } from './viewStore';

const T = (s: string): number => Date.parse(s);
const FROM = T('2026-11-09T12:00:00Z'), TO = T('2026-11-13T21:00:00Z');
const TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

/** Every time-of-observation stamp inside a call's stored inputs (not schedules or expiries, which lie ahead by design). */
function observedStamps(v: unknown, out: Array<{ path: string; t: number }> = [], path = 'inputs'): Array<{ path: string; t: number }> {
  if (Array.isArray(v)) v.forEach((x, i) => observedStamps(x, out, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ['now', 'asOf', 'ts', 'resolvedAt', 'createdAt', 'generatedAt'].includes(k)) out.push({ path: `${path}.${k}`, t: Date.parse(x) });
      else observedStamps(x, out, `${path}.${k}`);
    }
  }
  return out;
}

describe('replay over the recorded week of 2026-11-09', () => {
  const store = new MemoryStore();
  let summary: ReplaySummary;
  let calls: BiasCall[] = [];
  const lookAhead: string[] = [];
  let stepsSeen = 0;

  beforeAll(async () => {
    summary = await replay(store, {
      from: FROM, to: TO, stepMin: 60, instruments: ['NQ'],
      onStep: async (now, view) => {
        stepsSeen++;
        for (const symbol of ['NQ', 'ES', 'US10Y', 'VIX']) for (const tf of TFS) {
          const last = (await view.getCandles(symbol, tf)).at(-1);
          if (last && last.t + TF_MS[tf] > now) lookAhead.push(`${symbol} ${tf} bar closing ${new Date(last.t + TF_MS[tf]).toISOString()} visible at ${new Date(now).toISOString()}`);
        }
        const ahead = (await view.list('calendar', { since: new Date(now + 1).toISOString() })).filter((e) => e.actual !== null);
        if (ahead.length) lookAhead.push(`${ahead[0]!.name} actual visible at ${new Date(now).toISOString()}, released ${ahead[0]!.time}`);
        const y10 = await view.latestDatum('rate.US10Y');
        if (y10 && Date.parse(y10.asOf) > now) lookAhead.push(`10Y reading ${y10.asOf} visible at ${new Date(now).toISOString()}`);
      },
    });
    calls = await store.list('bias_calls', { order: 'asc' });
  }, 240_000);

  it('no look-ahead: the view never holds a bar that had not closed, a reading from the future or an actual before its release', () => {
    expect(stepsSeen).toBe(summary.steps.run);
    expect(stepsSeen).toBeGreaterThan(80);
    expect(lookAhead).toEqual([]);
  });

  it('no look-ahead: no stored input of a call is stamped after the call was made', () => {
    expect(calls.length).toBeGreaterThan(20);
    for (const c of calls) {
      const made = Date.parse(c.createdAt);
      const stamps = observedStamps(c.inputs);
      expect(stamps.length).toBeGreaterThan(5);
      const late = stamps.filter((s) => s.t > made);
      expect(late, `${c.id} made ${c.createdAt}`).toEqual([]);
      expect((c.inputs.features as { now: string }).now).toBe(c.createdAt);
    }
    // The stored inputs still replay to the same call.
    const sample = calls.find((c) => c.call !== 'no_edge')!;
    const again = bias.replayCall(sample);
    expect(again.id).toBe(sample.id);
    expect(again.call).toBe(sample.call);
    expect(again.probability).toBe(sample.probability);
  });

  it('a matrix is generated before its release and matched only on the real actual', async () => {
    const cats = await store.list('catalysts', { order: 'asc' });
    const cpi = cats.find((c) => c.code === 'CPI' && c.scheduledAt === '2026-11-10T13:30:00.000Z')!;
    const ppi = cats.find((c) => c.code === 'PPI' && c.scheduledAt === '2026-11-13T13:30:00.000Z')!;
    for (const c of [cpi, ppi]) {
      expect(c.status).toBe('resolved');
      expect(Date.parse(c.matrix!.generatedAt)).toBeLessThan(Date.parse(c.scheduledAt));
      expect(c.resolution!.resolvedAt).toBe(c.scheduledAt);
      expect(c.history.length).toBe(8);
      for (const h of c.history) expect(Date.parse(h.time!)).toBeLessThan(Date.parse(c.scheduledAt));
    }
    // Recorded prints: core CPI 0.3% against a 0.2% consensus, PPI 0.3% against 0.4%.
    expect(cpi.resolution).toMatchObject({ actual: 0.3, branchId: 'C' });
    expect(cpi.consensus).toBe(0.2);
    expect(ppi.resolution).toMatchObject({ actual: 0.3, branchId: 'B' });
    expect(ppi.consensus).toBe(0.4);
    // The PPI matrix on file at the release is the 06:00 ET run of the day (11:00Z), built before the print.
    expect(ppi.matrix!.generatedAt).toBe('2026-11-13T11:00:00.000Z');
    expect(summary.catalysts.tier1.map((t) => `${t.code}:${t.branchId}`)).toEqual(['CPI:C', 'PPI:B']);
    expect(summary.catalysts.resolved).toBeGreaterThanOrEqual(2);
  });

  it('calls are scored on the recorded candles and feed the calibration table', async () => {
    const scored = calls.filter(bias.isResolvedDirectional);
    expect(scored.length).toBeGreaterThan(10);
    expect(summary.calls.resolvedDirectional).toBe(scored.length);
    for (const c of scored) expect(Date.parse(c.outcome!.resolvedAt)).toBeLessThanOrEqual(TO);
    const table = await store.kvGet<CalibrationTable>(KV.calibrationTable);
    expect(table!.source).toBe('replay');
    expect(table!.n).toBe(scored.length);
    expect(table!.buckets.reduce((a, b) => a + b.n, 0)).toBe(scored.length);
    const right = scored.filter((c) => c.outcome!.correct).length;
    expect(summary.calls.correct).toBe(right);
    const map = await store.kvGet<bias.CalibrationMap & { n: number; source: string }>(KV.calibration);
    expect(map).toMatchObject({ n: scored.length, source: 'replay' });
    expect(map!.buckets).toHaveLength(table!.buckets.length);
    // Calls were made on raw probabilities: no map was applied during the walk.
    for (const c of calls) expect((c.inputs as { calibration: unknown }).calibration).toBeNull();
  });

  it('every replayed doc carries the replay tag, and nothing a trader does is invented', async () => {
    expect(calls.every(isReplayCall)).toBe(true);
    expect(calls.every((c) => c.inputs.replayResolution === '5m' || c.inputs.replayResolution === '1m')).toBe(true);
    const cats = await store.list('catalysts');
    expect(cats.length).toBeGreaterThan(0);
    expect(cats.every(isReplayCatalyst)).toBe(true);
    expect(cats.filter((c) => c.matrix).every((c) => c.matrix!.inputs.replay === true)).toBe(true);
    const events = await store.list('structure_events');
    expect(events.length).toBe(summary.structureEvents);
    expect(events.length).toBeGreaterThan(1000);
    expect(events.every(isReplayEvent)).toBe(true);
    for (const e of events) { const t = Date.parse(e.ts); expect(t >= FROM && t <= TO).toBe(true); }
    for (const c of ['tickets', 'positions', 'guardrail_firings', 'notifications', 'briefs', 'watcher_updates', 'notes', 'account_states'] as const) {
      expect(await store.list(c), c).toEqual([]);
    }
    // No account balance in the view: every branch trade is unsized.
    for (const c of cats) for (const b of c.matrix?.branches ?? []) expect(b.trade?.size).toBeUndefined();
  });

  it('base rates and reaction tables are stored with their sample counts', async () => {
    const rates = await store.list('base_rates');
    expect(rates.length).toBe(summary.baseRates.length);
    const nq = rates.find((r) => r.instrument === 'NQ' && r.tf === '1h' && r.pattern.includes('sweep'));
    expect(nq).toBeDefined();
    expect(nq!.n).toBeGreaterThan(50);
    expect(nq!.hitRate).toBeGreaterThan(0);
    expect(nq!.hitRate).toBeLessThan(1);
    expect(Date.parse(nq!.asOf)).toBeLessThanOrEqual(TO);
    const tables = await store.kvGet<{ source: string; asOf: string; tables: Record<string, Array<{ time?: string }>> }>(REPLAY_KV.reactionTables);
    expect(tables!.source).toBe('replay');
    expect(Object.keys(tables!.tables)).toEqual(expect.arrayContaining(['CORE_CPI', 'PPI']));
    for (const rows of Object.values(tables!.tables)) for (const r of rows) expect(Date.parse(r.time!)).toBeLessThanOrEqual(TO);
    expect(summary.reactionTables.find((t) => t.code === 'CORE_CPI')!.rows).toBe(8);
  });

  it('the summary names the resolution used and prints the numbers it stored', async () => {
    expect(summary.periods.length).toBeGreaterThan(0);
    expect(summary.periods[0]).toMatchObject({ resolution: '5m', stepMin: 60 });
    expect(summary.periods.at(-1)!.resolution).toBe('1m');
    expect(summary.steps.failureCount).toBe(0);
    expect(await store.kvGet<ReplaySummary>(REPLAY_KV.summary)).toEqual(JSON.parse(JSON.stringify(summary)));
    const text = formatSummary(summary).join('\n');
    expect(text).toContain(`Calls: ${summary.calls.total}.`);
    expect(text).toContain('CPI (core MoM): 0.3% vs 0.2%, branch C');
    expect(text).toContain('5m candles, 60-min steps');
    expect(text).toContain(`source: replay, n=${summary.calibration.n}`);
    expect(text).toContain('Trades: none.');
  });
});

describe('replay idempotency and options', () => {
  const from = T('2026-11-10T06:00:00Z'), to = T('2026-11-10T20:00:00Z');
  const ids = async (s: MemoryStore): Promise<Record<string, string[]>> => ({
    calls: (await s.list('bias_calls')).map((c) => c.id).sort(),
    catalysts: (await s.list('catalysts')).map((c) => c.id).sort(),
    events: (await s.list('structure_events')).map((e) => e.id).sort(),
    rates: (await s.list('base_rates')).map((r) => `${r.pattern}_${r.instrument}_${r.tf}`).sort(),
  });

  it('two runs write identical documents under identical ids, and a narrower re-run leaves no orphans', async () => {
    const store = new MemoryStore();
    const first = await replay(store, { from, to, stepMin: 60, instruments: ['NQ'] });
    const docs1 = { calls: await store.list('bias_calls', { order: 'asc' }), catalysts: await store.list('catalysts', { order: 'asc' }), n: await ids(store) };
    const second = await replay(store, { from, to, stepMin: 60, instruments: ['NQ'] });
    expect(second).toEqual(first);
    expect(second.removedStale).toBe(0);
    expect(await ids(store)).toEqual(docs1.n);
    expect(await store.list('bias_calls', { order: 'asc' })).toEqual(docs1.calls);
    expect(await store.list('catalysts', { order: 'asc' })).toEqual(docs1.catalysts);
    expect(docs1.n.calls!.length).toBe(first.calls.total);
    expect(first.calls.total).toBeGreaterThan(3);

    // A trader's own records and a live call are never touched by a re-run.
    const live: BiasCall = { ...docs1.calls[0]!, id: 'bias_live_one', inputs: { ...docs1.calls[0]!.inputs, replay: false } };
    await store.put('bias_calls', [live]);
    const narrow = await replay(store, { from, to, stepMin: 60, instruments: ['NQ'], horizons: ['intraday'] });
    expect(narrow.horizons).toEqual(['intraday']);
    expect(narrow.removedStale).toBeGreaterThan(0);
    const left = await store.list('bias_calls');
    expect(left.filter(isReplayCall).every((c) => c.horizon === 'intraday')).toBe(true);
    expect(left.filter(isReplayCall).length).toBe(narrow.calls.total);
    expect(left.some((c) => c.id === 'bias_live_one')).toBe(true);
  }, 240_000);

  it('rejects an empty window and caps the window at the end of the recording', async () => {
    const end = recordedEnd('NQ')!;
    await expect(replay(new MemoryStore(), { from: end + DAY, to: end + 2 * DAY })).rejects.toThrow(/window is empty/);
    expect(replayWindow(90, end + 30 * DAY)).toEqual({ from: end - 90 * DAY, to: end });
    expect(replayWindow(90, end - DAY).to).toBe(end - DAY);
  });

  it('resolution by date: 1h before the 15m and 5m recordings start, finer after', () => {
    expect(resolutionAt('NQ', T('2026-08-25T15:00:00Z'))).toBe('1h');
    expect(resolutionAt('NQ', T('2026-10-01T15:00:00Z'))).toBe('5m');
    expect(resolutionAt('NQ', T('2026-11-17T15:00:00Z'))).toBe('1m');
    expect(resolutionAt('NQ', T('2020-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('ViewStore', () => {
  const datum = (ms: number, value: number): { key: string; value: number; source: string; asOf: string; cadenceSec: number } =>
    ({ key: 'rate.US10Y', value, source: 'synthetic:test', asOf: new Date(ms).toISOString(), cadenceSec: 300 });

  it('long data reads keep what the bias snapshot keeps: all of the last days, then the last reading of each UTC day', async () => {
    const view = new ViewStore(), plain = new MemoryStore();
    const start = T('2026-10-01T00:00:00Z'), now = T('2026-10-20T13:35:00Z');
    const synthetic = Array.from({ length: 20 * 288 }, (_, i) => datum(start + i * 300_000, 4 + (i % 97) / 1000));
    await view.putData(synthetic);
    await plain.putData(synthetic);
    const thinned = await view.dataHistory('rate.US10Y', now - 400 * DAY, now), full = await plain.dataHistory('rate.US10Y', now - 400 * DAY, now);
    expect(thinned.length).toBeLessThan(full.length / 3);
    // The engine's own rule applied to the full series: everything in 3 days, then the last reading of each UTC day.
    const engineKeeps = full.filter((d, i) => Date.parse(d.asOf) >= now - 3 * DAY || full[i + 1]!.asOf.slice(0, 10) !== d.asOf.slice(0, 10));
    const viewKeeps = thinned.filter((d, i) => Date.parse(d.asOf) >= now - 3 * DAY || thinned[i + 1]!.asOf.slice(0, 10) !== d.asOf.slice(0, 10));
    expect(viewKeeps).toEqual(engineKeeps);
    expect(thinned.at(-1)).toEqual(full.at(-1));
    expect(await view.dataHistory('rate.US10Y', now - 2 * 3_600_000, now)).toEqual(await plain.dataHistory('rate.US10Y', now - 2 * 3_600_000, now));
    expect(await view.latestDatum('rate.US10Y')).toEqual(await plain.latestDatum('rate.US10Y'));
  });

  it('shared collections list like a MemoryStore and cannot be changed through a read', async () => {
    const view = new ViewStore(), plain = new MemoryStore();
    const store = new MemoryStore();
    await replay(store, { from: T('2026-11-10T12:00:00Z'), to: T('2026-11-10T15:00:00Z'), stepMin: 60, instruments: ['NQ'] });
    const calls = await store.list('bias_calls');
    await view.put('bias_calls', calls);
    await plain.put('bias_calls', calls);
    for (const opts of [{}, { order: 'asc' as const }, { instrument: 'NQ', status: 'intraday', limit: 1 }, { since: '2026-11-10T13:00:00.000Z', until: '2026-11-10T14:00:00.001Z' }, { status: ['swing', 'position'] }]) {
      expect(await view.list('bias_calls', opts)).toEqual(await plain.list('bias_calls', opts));
    }
    const one = (await view.list('bias_calls', { limit: 1 }))[0]!;
    expect(() => { one.probability = 0.85; }).toThrow(TypeError);
    expect(await view.get('bias_calls', one.id)).toEqual(await plain.get('bias_calls', one.id));
    await view.remove('bias_calls', one.id);
    expect(await view.get('bias_calls', one.id)).toBeNull();
  }, 120_000);
});
