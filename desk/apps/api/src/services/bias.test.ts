import { describe, expect, it } from 'vitest';
import { BIAS_TEXT, DEFAULT_WEIGHTS, KV, TF_MS, fromZoned } from '@desk/contracts';
import { bias } from '@desk/engines';
import { applyProposedWeights, biasPlan, calibrationTable, currentCalls, proposedWeights, runBias, runCalibration, runRefit, scoreExpiredCalls, storedWeights, type WeightProposal } from './bias';
import { profileOf } from './context';
import { desk, recorded, recordedDesk, RECORDED_SYMBOLS, RECORDED_TFS } from './recorded.testkit';
import { runWatcher } from './watcher';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);

describe('bias service on recorded data', () => {
  it('stores one call per instrument and horizon with its inputs, and nothing new when no fact changed', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at);
    await runWatcher(d.deps, at);
    const run = await runBias(d.deps, at);
    // The watchlist is wider than the recording: names with no candles in the store are named and get no call.
    const plan = biasPlan(await profileOf(d.deps));
    expect(run.skipped).toEqual(plan.map((p) => p.instrument).filter((s) => !RECORDED_SYMBOLS.includes(s)));
    expect(run.calls.map((c) => `${c.instrument}|${c.horizon}`)).toEqual(['NQ|intraday', 'NQ|swing', 'NQ|position', 'NVDA|swing', 'AMD|swing']);
    expect(run.changed).toHaveLength(run.calls.length);
    for (const c of run.calls) {
      console.log(`[bias] 2026-11-17 11:00 ET ${c.instrument} ${c.horizon}: ${BIAS_TEXT[c.call]} ${c.probability.toFixed(2)} at ${c.referencePrice}. ${c.facts.join(' | ')} Kill: ${c.killCondition.text}`);
      expect(c.probability).toBeGreaterThanOrEqual(0.5);
      expect(c.probability).toBeLessThanOrEqual(0.85);
      expect(c.facts.length).toBeGreaterThan(0);
      expect(c.facts.length).toBeLessThanOrEqual(3);
      expect(c.createdAt).toBe(new Date(at).toISOString());
      expect(bias.storedInputs(c)?.features.instrument).toBe(c.instrument);
      expect(bias.replayCall(c).id).toBe(c.id);
      if (c.call === 'no_edge') expect(c.probability).toBe(0.5);
    }
    expect(await d.store.list('bias_calls')).toHaveLength(run.calls.length);

    const again = await runBias(d.deps, at);
    expect(again.changed).toEqual([]);
    expect(again.intents).toEqual([]);
    expect(again.calls.map((c) => c.id)).toEqual(run.calls.map((c) => c.id));
    expect(await d.store.list('bias_calls')).toHaveLength(run.calls.length);
    expect((await currentCalls(d.deps, at)).map((c) => c.id).sort()).toEqual(run.calls.map((c) => c.id).sort());
  }, 60_000);

  it('skips an instrument with no candles and makes no call on an empty store', async () => {
    const empty = await desk(et(17, 11, 0));
    const none = await runBias(empty.deps, et(17, 11, 0));
    expect(none.calls).toEqual([]);
    expect(none.skipped).toEqual([...new Set(biasPlan(await profileOf(empty.deps)).map((p) => p.instrument))]);
    const d = await recordedDesk(et(17, 11, 0), { symbols: ['NQ', 'ES', 'US10Y', 'VIX'] });
    const run = await runBias(d.deps, et(17, 11, 0));
    expect(run.skipped).toEqual(expect.arrayContaining(['NVDA', 'AMD']));
    expect(run.calls.map((c) => c.instrument)).toEqual(['NQ', 'NQ', 'NQ']);
  }, 60_000);

  it('scores an expired intraday call on the recorded candles, builds the calibration table, and holds a re-fit as a proposal', async () => {
    const at = et(17, 11, 0);
    const d = await recordedDesk(at);
    await runWatcher(d.deps, at);
    const run = await runBias(d.deps, at);
    const intraday = run.calls.find((c) => c.instrument === 'NQ' && c.horizon === 'intraday')!;
    expect(await scoreExpiredCalls(d.deps, at)).toEqual([]);

    // The next recorded session arrives; the call has expired by then.
    const later = et(18, 11, 0);
    for (const symbol of RECORDED_SYMBOLS) for (const tf of RECORDED_TFS) {
      await d.store.upsertCandles(recorded(symbol, tf).filter((c) => c.t + TF_MS[tf] > at && c.t + TF_MS[tf] <= later));
    }
    d.clock.t = later;
    const scored = await scoreExpiredCalls(d.deps, later);
    const out = scored.find((c) => c.id === intraday.id)!;
    console.log(`[bias] 2026-11-17 11:00 ET NQ intraday ${BIAS_TEXT[intraday.call]} ${intraday.probability.toFixed(2)} at ${intraday.referencePrice}, expired ${intraday.expiresAt}: outcome ${JSON.stringify(out.outcome)}`);
    expect(intraday.call).toBe('lean_short');
    // The engine's rule: with a trade on the call, the invalidation trading before T1 scores it wrong whatever the close.
    expect(typeof out.outcome?.correct).toBe('boolean');
    expect(out.outcome?.resolvedAt).toBe(intraday.expiresAt);
    expect((await d.store.get('bias_calls', intraday.id))?.outcome).toEqual(out.outcome);
    expect(await scoreExpiredCalls(d.deps, later)).toEqual([]);

    const table = await runCalibration(d.deps, later);
    expect(table.updatedAt).toBe(new Date(later).toISOString());
    expect(table.source).toBe('live');
    expect(table.n).toBeGreaterThanOrEqual(1);
    expect(await calibrationTable(d.deps)).toEqual(table);
    expect(await d.store.kvGet(KV.calibration)).not.toBeNull();

    // A handful of scored calls is not a sample: the re-fit reports, proposes nothing and leaves the weights alone.
    const profile = await profileOf(d.deps);
    const before = await storedWeights(d.deps, profile);
    const proposal = await runRefit(d.deps, later);
    console.log(`[bias] re-fit on ${table.n} scored directional calls: refit=${proposal.report.refit}, ${proposal.report.reason}`);
    expect(proposal.approved).toBe(false);
    expect(proposal.report.refit).toBe(false);
    expect(await proposedWeights(d.deps)).toBeNull();
    expect(await d.store.kvGet(KV.weights)).toBeNull();
    expect(await d.store.kvGet(KV.refitReport)).toEqual(proposal.report);
    expect(await applyProposedWeights(d.deps)).toBeNull();

    // A pending proposal (weights typed in by the test) changes nothing until it is applied on approval.
    const proposed = bias.normaliseWeights({ ...DEFAULT_WEIGHTS, structure: DEFAULT_WEIGHTS.structure / 2 });
    await d.store.kvSet<WeightProposal>(KV.proposedWeights, { ...proposal, weights: proposed });
    expect(await storedWeights(d.deps, profile)).toEqual(before);
    expect(await applyProposedWeights(d.deps)).toEqual(proposed);
    expect(await storedWeights(d.deps, profile)).toEqual(proposed);
    expect((await proposedWeights(d.deps))?.approved).toBe(true);
    expect(await applyProposedWeights(d.deps)).toBeNull();
  }, 120_000);
});
