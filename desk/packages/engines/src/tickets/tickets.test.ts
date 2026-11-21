import { describe, expect, it } from 'vitest';
import { MIN, Ticket as TicketSchema, iso, type Candle, type Catalyst, type Fill, type Ticket } from '@desk/contracts';
import { loadRecordedCalendar, loadRecordedCandles } from '@desk/feeds/recorded.ts';
import {
  allDeviations, applyFill, cancelTicket, captureComparison, capturePct, closeTicket, detectDeviations, overrideLedger, overridePrompt,
  planBreakingTradesToday, postExitExcursions, recordOverride, replayFills, rollingAdherence, scoreAdherence, settleResult, simulatePlan,
  ticketAlerts, validateDraft, ledgerSentence, TicketStateError,
} from './index';
import { NOW, at, ctx, shortDraft, syntheticCandle, syntheticCatalyst, syntheticSetup, syntheticSizing } from './fixtures.test-util';

const messages = (r: { errors: Array<{ field: string; message: string }> }, field?: string): string[] => r.errors.filter((e) => !field || e.field === field).map((e) => e.message);
const planned = (over: Parameters<typeof shortDraft>[0] = {}, c: Parameters<typeof ctx>[0] = {}): Ticket => {
  const r = validateDraft(shortDraft(over), ctx(c));
  if (!r.ticket) throw new Error(`fixture draft did not validate: ${messages(r).join(' | ')}`);
  return r.ticket;
};
const fill = (kind: Fill['kind'], ts: number, price: number, units: number): Fill => ({ kind, ts: iso(ts), price, units, source: 'manual' });
const run = (t: Ticket, fills: Fill[]): Ticket => fills.reduce((acc, f) => { const o = applyFill(acc, f, Date.parse(f.ts)); expect(o.rejected).toBeNull(); return o.ticket; }, t);

describe('validateDraft', () => {
  it('saves a complete ticket with defaults filled in', () => {
    const r = validateDraft(shortDraft(), ctx());
    expect(r.errors).toEqual([]);
    const t = TicketSchema.parse(r.ticket);
    expect(t.status).toBe('planned');
    expect(t.size).toMatchObject({ engineMaxUnits: 3, units: 3, notionalUsd: 3 * 20 * 27338 });
    expect(t.targets.map((x) => x.fraction).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(t.targets[0].fraction).toBeCloseTo(1 / 3, 6);
    expect(r.riskRewardT1).toBe(0.86); // 88 pts to T1 over 102 pts to invalidation
    expect(r.asOf).toBe(iso(NOW));
    expect(validateDraft(shortDraft(), ctx()).ticket?.id).toBe(t.id); // deterministic id
  });

  it('a ticket cannot save without targets and invalidation', () => {
    const r = validateDraft(shortDraft({ targets: undefined, invalidation: undefined }), ctx());
    expect(r.ticket).toBeNull();
    expect(messages(r, 'targets')).toEqual(['No targets, no ticket. Three exits before the entry.']);
    expect(messages(r, 'invalidation')).toEqual(['No invalidation, no ticket. One price that proves the idea wrong.']);

    const onlyTargetsMissing = validateDraft(shortDraft({ targets: [] }), ctx());
    expect(onlyTargetsMissing.ticket).toBeNull();
    expect(onlyTargetsMissing.errors.map((e) => e.field)).toEqual(['targets']);
    const onlyInvalidationMissing = validateDraft(shortDraft({ invalidation: null }), ctx());
    expect(onlyInvalidationMissing.ticket).toBeNull();
    expect(onlyInvalidationMissing.errors.map((e) => e.field)).toEqual(['invalidation']);
    const two = validateDraft(shortDraft({ targets: [{ price: 27250 }, { price: 27150 }] }), ctx());
    expect(two.ticket).toBeNull();
    expect(messages(two)[0]).toMatch(/^2 targets\. The plan is three/);
    const noTimeStop = validateDraft(shortDraft({ timeStop: undefined }), ctx());
    expect(noTimeStop.ticket).toBeNull();
    expect(messages(noTimeStop)).toEqual(['No time stop, no ticket. Name the latest time the thesis is still alive.']);
  });

  it('free-text reason rejected', () => {
    for (const reason of ['it dropped a lot, feels like the bottom', '', null, { kind: 'vibes' }, { kind: 'catalyst' }]) {
      const r = validateDraft(shortDraft({ reason }), ctx());
      expect(r.ticket).toBeNull();
      expect(messages(r, 'reason')).toEqual(['No catalyst, no trade. Free text is not a reason; pick a catalyst or a confirmed setup.']);
    }
  });

  it('reason must point at a live or just-resolved catalyst, or a fresh confirmed setup on the instrument', () => {
    expect(messages(validateDraft(shortDraft({ reason: { kind: 'catalyst', catalystId: 'nope' } }), ctx()))[0]).toMatch(/not on the calendar/);
    const stale = syntheticCatalyst({ resolution: { actual: null, branchId: null, resolvedAt: iso(NOW - 121 * MIN) } });
    expect(messages(validateDraft(shortDraft(), ctx({ catalysts: [stale] })))).toEqual(['CPI (synthetic) resolved 121 min ago. 120 min is the limit; that trade has left.']);
    const edge = syntheticCatalyst({ resolution: { actual: null, branchId: null, resolvedAt: iso(NOW - 120 * MIN) } });
    expect(validateDraft(shortDraft(), ctx({ catalysts: [edge] })).ticket).not.toBeNull();
    expect(validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst({ status: 'upcoming', resolution: null, tier: 2, scheduledAt: iso(NOW + 60 * MIN) })] })).ticket).not.toBeNull();

    const structure = { kind: 'structure', setupEventId: 'se_synthetic_1' };
    expect(validateDraft(shortDraft({ reason: structure }), ctx()).ticket?.watcherEventIds).toEqual(['se_synthetic_1']);
    expect(messages(validateDraft(shortDraft({ reason: structure }), ctx({ setups: [syntheticSetup({ confirmedSetup: false })] })))[0]).toMatch(/not on the confirmed list/);
    expect(messages(validateDraft(shortDraft({ reason: structure }), ctx({ setups: [syntheticSetup({ instrument: 'ES' })] })))).toEqual(['That setup is on ES. This ticket is NQ.']);
    expect(messages(validateDraft(shortDraft({ reason: structure }), ctx({ setups: [syntheticSetup({ ts: iso(NOW - 481 * MIN) })] })))).toEqual(['Setup is 481 min old. 480 min is the limit on a 15m setup; wait for a fresh one.']);
    expect(messages(validateDraft(shortDraft({ reason: structure }), ctx({ setups: [syntheticSetup({ bias: 1 })] })))).toEqual(['That setup is bullish. The ticket is short.']);
  });

  it('entry "now" rejected', () => {
    for (const entry of ['now', 'NOW!', '', 'market', 'asap', 'at market', { kind: 'condition', text: 'now' }, { kind: 'condition', text: '' }, { kind: 'price', price: 27338, text: 'market' }, { text: 'now' }]) {
      const r = validateDraft(shortDraft({ entry }), ctx());
      expect(r.ticket).toBeNull();
      expect(messages(r, 'entry')).toEqual(['"Now" is not a trigger. A price, a time, or a condition.']);
    }
    expect(messages(validateDraft(shortDraft({ entry: undefined }), ctx()))).toEqual(['No entry trigger, no ticket. A price, a time, or a condition.']);
    expect(messages(validateDraft(shortDraft({ entry: { kind: 'condition', text: 'when ready' } }), ctx()))[0]).toMatch(/three words minimum/);
    expect(messages(validateDraft(shortDraft({ entry: { kind: 'time', at: iso(NOW - MIN), text: 'the open' } }), ctx()))[0]).toMatch(/^Entry time 09:24 ET is already gone/);
    // a condition, a time and a price each pass
    expect(validateDraft(shortDraft({ entry: { kind: 'condition', text: 'second move after 09:45 if the 10Y confirms' } }), ctx({ price: 27338 })).ticket).not.toBeNull();
    expect(validateDraft(shortDraft({ entry: 'second move after 09:45 if the 10Y confirms' }), ctx({ price: 27338 })).ticket?.entry.kind).toBe('condition');
    expect(validateDraft(shortDraft({ entry: { kind: 'time', at: '2026-11-17T14:30:00Z' } }), ctx({ price: 27338 })).ticket?.entry.text).toBe('at 09:30 ET');
  });

  it('size above engine max clamped', () => {
    const r = validateDraft(shortDraft({ units: 10 }), ctx());
    expect(r.errors).toEqual([]);
    expect(r.ticket?.size.units).toBe(3);
    expect(r.ticket?.size.engineMaxUnits).toBe(3);
    expect(r.notes).toEqual(['Size cut to 3 from 10. Engine max is 3; down only, never up.']);
    // sizing down is allowed and silent
    const down = validateDraft(shortDraft({ units: 2 }), ctx());
    expect(down.ticket?.size.units).toBe(2);
    expect(down.notes).toEqual([]);
    expect(down.ticket?.size.notionalUsd).toBe(2 * 20 * 27338);
  });

  it('a blocked or missing sizing result stops the save, with the engine\'s reason as the error', () => {
    const why = 'CPI in 40 min: implied move 1.2% reaches the fail price 0.6% away. Flat through the print.';
    const blocked = validateDraft(shortDraft(), ctx({ sizing: syntheticSizing({ blocked: true, blockReason: why, maxUnits: 0 }) }));
    expect(blocked.ticket).toBeNull();
    expect(messages(blocked, 'size')).toEqual([why]);
    expect(messages(validateDraft(shortDraft(), ctx({ sizing: null })), 'size')).toEqual(['No size from the sizing engine, no ticket. Size is computed, never typed.']);
    expect(messages(validateDraft(shortDraft(), ctx({ sizing: syntheticSizing({ direction: 'long' }) })), 'size')[0]).toMatch(/Re-run it\.$/);
    expect(messages(validateDraft(shortDraft(), ctx({ sizing: syntheticSizing({ maxUnits: 0.4 }) })), 'size')[0]).toMatch(/^Engine max is 0/);
  });

  it('targets must be on the right side, in order, with fractions summing to 1', () => {
    expect(messages(validateDraft(shortDraft({ targets: [{ price: 27400 }, { price: 27150 }, { price: 26900 }] }), ctx()))).toContain('T1 27,400 is on the wrong side of a short from 27,338. Targets go below.');
    expect(messages(validateDraft(shortDraft({ targets: [{ price: 27150 }, { price: 27250 }, { price: 26900 }] }), ctx()))).toEqual(['Targets out of order. T1 nearest, T3 farthest.']);
    expect(messages(validateDraft(shortDraft({ targets: [{ price: 27250, fraction: 0.5 }, { price: 27150, fraction: 0.2 }, { price: 26900, fraction: 0.1 }] }), ctx()))).toEqual(['Scale-out fractions sum to 0.80. They sum to 1.']);
    const custom = validateDraft(shortDraft({ targets: [{ price: 27250, fraction: 0.5 }, { price: 27150, fraction: 0.3 }, { price: 26900, fraction: 0.2 }] }), ctx());
    expect(custom.ticket?.targets.map((t) => t.fraction)).toEqual([0.5, 0.3, 0.2]);
    const long = validateDraft(shortDraft({ direction: 'long', entry: { kind: 'price', price: 27000, text: 'buy 27,000' }, targets: [{ price: 27100 }, { price: 27200 }, { price: 27300 }], invalidation: { price: 27050, reason: 'loses the overnight low' } }), ctx({ sizing: syntheticSizing({ direction: 'long' }), setups: [] }));
    expect(messages(long)).toEqual(['Invalidation 27,050 is on the winning side of a long from 27,000. It goes below.']);
  });

  it('invalidation needs a reason of a few words; time stop must be ISO and in the future', () => {
    expect(messages(validateDraft(shortDraft({ invalidation: { price: 27440, reason: 'because' } }), ctx()))[0]).toMatch(/^Invalidation needs its reason/);
    expect(messages(validateDraft(shortDraft({ timeStop: '15:30 ET' }), ctx()))[0]).toMatch(/^Time stop is not a time/);
    expect(messages(validateDraft(shortDraft({ timeStop: '2026-11-17T14:00:00Z' }), ctx()))).toEqual(['Time stop 09:00 ET is already behind us. It goes in the future.']);
  });

  it('hold-through-catalyst flag is set automatically from Tier-1 catalysts between entry and time stop', () => {
    const fomc = syntheticCatalyst({ id: 'cat_synthetic_fomc', code: 'FOMC', name: 'FOMC (synthetic)', status: 'upcoming', resolution: null, scheduledAt: '2026-11-17T19:00:00Z' });
    const r = validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst(), fomc] }));
    expect(r.ticket?.holdThroughCatalyst).toEqual({ flag: true, catalystId: 'cat_synthetic_fomc' });
    expect(validateDraft(shortDraft({ timeStop: '2026-11-17T18:30:00Z' }), ctx({ catalysts: [syntheticCatalyst(), fomc] })).ticket?.holdThroughCatalyst.flag).toBe(false);
    expect(validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst(), { ...fomc, tier: 2 }] })).ticket?.holdThroughCatalyst.flag).toBe(false);
    // the sizing engine decides the block; its reason is the error
    const blocked = validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst(), fomc], sizing: syntheticSizing({ blocked: true, blockReason: 'FOMC 14:00 ET: implied 1.1% reaches the fail price.' }) }));
    expect(blocked.ticket).toBeNull();
    expect(blocked.holdThroughCatalyst.flag).toBe(true);
    expect(messages(blocked)).toEqual(['FOMC 14:00 ET: implied 1.1% reaches the fail price.']);
    // someone else's earnings do not flag an NQ ticket; the index's own top weight does
    const amd = syntheticCatalyst({ id: 'e1', code: 'EARNINGS', symbol: 'AMD', instruments: ['AMD'], status: 'upcoming', resolution: null, scheduledAt: '2026-11-17T19:00:00Z' });
    expect(validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst(), amd] })).ticket?.holdThroughCatalyst.flag).toBe(false);
    expect(validateDraft(shortDraft(), ctx({ catalysts: [syntheticCatalyst(), { ...amd, symbol: 'NVDA', instruments: ['NVDA', 'NQ'] }] })).ticket?.holdThroughCatalyst.flag).toBe(true);
  });

  it('re-entry inside 15 minutes rejected, allowed with a new catalyst', () => {
    const first = run(planned(), [fill('entry', at('14:30:00'), 27338, 3), fill('stop', at('14:40:00'), 27440, 3)]);
    const now = at('14:46:00');
    const base = { now, recentTickets: [first], price: 27338 };
    const again = validateDraft(shortDraft(), ctx(base));
    expect(again.ticket).toBeNull();
    expect(messages(again, 'reentry')).toEqual(['Stopped out 6 min ago. 15 min cooldown, 9 left. New catalyst or new structure, or wait until 09:55 ET.']);
    expect(again.reentryCooldownUntil).toBe('2026-11-17T14:55:00.000Z');

    const fresh = syntheticCatalyst({ id: 'cat_synthetic_headline', code: 'ADHOC', name: 'Tariff headline (synthetic)', tier: 2, resolution: { actual: null, branchId: null, resolvedAt: iso(now - MIN) } });
    const withNew = validateDraft(shortDraft({ reason: { kind: 'catalyst', catalystId: fresh.id } }), ctx({ ...base, catalysts: [syntheticCatalyst(), fresh] }));
    expect(withNew.errors).toEqual([]);
    expect(withNew.ticket).not.toBeNull();
    expect(withNew.reentryCooldownUntil).toBeNull();

    // a structure setup counts only when it formed after the stop-out
    const structure = { kind: 'structure', setupEventId: 'se_synthetic_1' };
    expect(validateDraft(shortDraft({ reason: structure }), ctx(base)).ticket).toBeNull();
    expect(validateDraft(shortDraft({ reason: structure }), ctx({ ...base, setups: [syntheticSetup({ ts: iso(at('14:44:00')) })] })).ticket).not.toBeNull();
    // the other direction, another underlying, or minute 15 are all clear; MNQ is the same underlying
    expect(validateDraft(shortDraft(), ctx({ ...base, now: at('14:55:00') })).ticket).not.toBeNull();
    expect(messages(validateDraft(shortDraft({ instrument: 'MNQ' }), ctx({ ...base, sizing: syntheticSizing({ instrument: 'MNQ' }) })), 'reentry')).toHaveLength(1);
    const long = shortDraft({ direction: 'long', targets: [{ price: 27400 }, { price: 27450 }, { price: 27500 }], invalidation: { price: 27300, reason: 'loses the opening low' } });
    expect(validateDraft(long, ctx({ ...base, sizing: syntheticSizing({ direction: 'long' }) })).errors.filter((e) => e.field === 'reentry')).toEqual([]);
    // a 5-minute cooldown from the profile has already expired
    expect(validateDraft(shortDraft(), ctx({ ...base, reentryCooldownMin: 5 })).ticket).not.toBeNull();
  });

  it('never uses the banned register', () => {
    const all = [
      ...messages(validateDraft(shortDraft({ reason: 'x', entry: 'now', targets: [], invalidation: null, timeStop: 'later', accountId: 'nope', instrument: 'QQQ' }), ctx({ sizing: null }))),
    ];
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const m of all) expect(m).not.toMatch(/consider|you may want to|might want to|perhaps|it could be argued/i);
  });
});

describe('lifecycle reducers (synthetic fills)', () => {
  it('entry opens, scale-outs match targets, P&L sums across fills', () => {
    let t = planned();
    const e = applyFill(t, fill('entry', at('14:30:00'), 27338, 3), at('14:30:00'));
    expect(e.ticket.status).toBe('open');
    expect(e.candidates).toEqual([]);
    const s1 = applyFill(e.ticket, fill('scale_out', at('14:35:00'), 27250, 1), at('14:35:00'));
    expect(s1.matchedTarget).toBe(1);
    const s2 = applyFill(s1.ticket, fill('scale_out', at('15:05:00'), 27149.5, 1), at('15:05:00'));
    expect(s2.matchedTarget).toBe(2);
    const s3 = applyFill(s2.ticket, fill('scale_out', at('15:40:00'), 26900, 5), at('15:40:00'));
    expect(s3.matchedTarget).toBe(3);
    expect(s3.flat).toBe(true);
    expect(s3.ticket.fills.at(-1)?.units).toBe(1); // clamped to what was open
    t = closeTicket(s3.ticket, { price: 26900, ts: iso(at('15:40:00')) }, []);
    expect(t.status).toBe('closed');
    expect(t.result?.pnlUsd).toBe((88 + 188.5 + 438) * 20);
    expect(t.result).toMatchObject({ adherence: 100, deductions: [], followedPlan: true, exitPrice: 26900, mfeAfterExitPct: null });
    expect(applyFill(t, fill('add', at('15:50:00'), 26900, 1), at('15:50:00')).rejected).toMatch(/closed/);
    expect(closeTicket(t, { price: 1, ts: iso(at('16:00:00')) }, [])).toBe(t);
  });

  it('an add under water is added_to_loser; any add beyond the ticket size is size_up', () => {
    const open = run(planned({ units: 2 }), [fill('entry', at('14:30:00'), 27338, 2)]);
    const add = applyFill(open, fill('add', at('14:33:00'), 27380, 1), at('14:33:00'));
    expect(add.candidates.map((c) => c.kind).sort()).toEqual(['added_to_loser', 'size_up']);
    expect(add.candidates.find((c) => c.kind === 'added_to_loser')?.reason).toBe('Added at 27,380 with the position 42 pts under water from 27,338.');
    expect(add.candidates.find((c) => c.kind === 'size_up')?.reason).toBe('Size 3 against a ticket of 2.');
    expect(scoreAdherence(add.ticket)).toEqual({ score: 20, deductions: [{ kind: 'size_up', points: 40 }, { kind: 'added_to_loser', points: 40 }] });

    // an add in the money, inside the ticket size, is neither
    const partial = run(planned(), [fill('entry', at('14:30:00'), 27338, 2)]);
    const good = applyFill(partial, fill('add', at('14:33:00'), 27300, 1), at('14:33:00'));
    expect(good.candidates).toEqual([]);
    expect(scoreAdherence(good.ticket).score).toBe(100);
    expect(replayFills(good.ticket).avgEntry).toBeCloseTo((27338 * 2 + 27300) / 3, 6);
    // a second add past the size is reported once
    const more = applyFill(add.ticket, fill('add', at('14:34:00'), 27390, 1), at('14:34:00'));
    expect(more.candidates).toEqual([]);
  });

  it('recordOverride logs once per kind, cancel only before fills, early exits are flagged without points', () => {
    const open = run(planned(), [fill('entry', at('14:30:00'), 27338, 3)]);
    const o1 = recordOverride(open, 'held_through_invalidation', 'it will come back', at('14:50:00'));
    expect(o1.overrides).toEqual([{ ts: iso(at('14:50:00')), kind: 'held_through_invalidation', reason: 'it will come back', pnlImpactUsd: null }]);
    expect(recordOverride(o1, 'held_through_invalidation', 'again', at('14:51:00'))).toBe(o1);
    expect(recordOverride(recordOverride(o1, 'skipped_scale_out', 'a', 1), 'skipped_scale_out', 'b', 2).overrides).toHaveLength(3);
    expect(() => cancelTicket(open, NOW)).toThrow(TicketStateError);
    expect(cancelTicket(planned(), NOW)).toMatchObject({ status: 'cancelled', closedAt: iso(NOW) });
    expect(() => closeTicket(planned(), { price: 27000, ts: iso(NOW) }, [])).toThrow(/never filled/);

    const early = applyFill(open, fill('exit', at('14:32:00'), 27300, 3), at('14:32:00'));
    expect(early.candidates).toEqual([{ kind: 'early_exit', ts: iso(at('14:32:00')), price: 27300, reason: 'Out at 27,300, 50 pts short of T1 27,250.' }]);
    const closed = closeTicket(recordOverride(early.ticket, 'early_exit', 'did not like the tape', at('14:32:00')), { price: 27300, ts: iso(at('14:32:00')) }, []);
    expect(closed.result).toMatchObject({ adherence: 100, followedPlan: false, pnlUsd: 38 * 3 * 20 });
  });

  it('notional instruments realize percent P&L on USD units', () => {
    const t = planned({ instrument: 'NQ-PERP', accountId: 'vest-instant', units: 30000 }, { sizing: syntheticSizing({ accountId: 'vest-instant', instrument: 'NQ-PERP', maxUnits: 50000, leverage: 10 }) });
    expect(t.size).toMatchObject({ units: 30000, notionalUsd: 30000, leverage: 6 });
    const closed = closeTicket(run(t, [fill('entry', at('14:30:00'), 27338, 30000), fill('scale_out', at('14:35:00'), 27250, 10000)]), { price: 27150, ts: iso(at('15:05:00')) }, []);
    expect(closed.result?.pnlUsd).toBeCloseTo((88 / 27338) * 10000 + (188 / 27338) * 20000, 1);
  });
});

describe('detectDeviations and ticketAlerts (synthetic path)', () => {
  const open = (): Ticket => run(planned(), [fill('entry', at('14:30:00'), 27338, 3)]);
  const flatPath = (from: string, n: number, h: number, l: number): Candle[] => Array.from({ length: n }, (_, i) => syntheticCandle(at(from) + i * MIN, h, l));

  it('flags a hold through invalidation only after the grace, and not when the stop was honored', () => {
    const path = [...flatPath('14:30:00', 5, 27345, 27320), syntheticCandle(at('14:35:00'), 27441, 27400), ...flatPath('14:36:00', 5, 27430, 27410)];
    expect(detectDeviations(open(), path, at('14:36:00'))).toEqual([]);
    const d = detectDeviations(open(), path, at('14:38:00'));
    expect(d).toEqual([{ kind: 'held_through_invalidation', ts: iso(at('14:35:00')), price: 27440, reason: '27,440 traded at 09:35 ET; still in 2 min later.' }]);
    const honored = run(open(), [fill('stop', at('14:35:40'), 27440, 3)]);
    expect(detectDeviations(honored, path, at('14:40:00'))).toEqual([]);
    const declared = recordOverride(open(), 'held_through_invalidation', 'wick', at('14:36:00'));
    expect(detectDeviations(declared, path, at('14:40:00'))).toEqual([]);
  });

  it('flags a hold through the time stop', () => {
    expect(detectDeviations(open(), [], at('20:00:30'))).toEqual([]);
    expect(detectDeviations(open(), [], at('20:02:00')).map((d) => d.kind)).toEqual(['held_through_time_stop']);
    const flat = run(open(), [fill('exit', at('19:59:00'), 27300, 3)]);
    expect(allDeviations(flat, [], at('20:30:00'))).toEqual([]);
  });

  it('flags a skipped scale-out per target, once each, and credits the ones taken', () => {
    const path = [...flatPath('14:30:00', 4, 27340, 27300), syntheticCandle(at('14:34:00'), 27300, 27240), ...flatPath('14:35:00', 10, 27260, 27200), syntheticCandle(at('14:45:00'), 27200, 27140), ...flatPath('14:46:00', 10, 27180, 27145)];
    expect(detectDeviations(open(), path, at('14:38:00'))).toEqual([]); // inside the 5 minutes
    const d = detectDeviations(open(), path, at('14:39:00'));
    expect(d).toEqual([{ kind: 'skipped_scale_out', ts: iso(at('14:34:00')), targetIndex: 1, price: 27250, reason: 'T1 27,250 traded at 09:34 ET; no scale-out within 5 min.' }]);
    // touching the target is not trading through it
    expect(detectDeviations(open(), [syntheticCandle(at('14:34:00'), 27300, 27250)], at('14:50:00'))).toEqual([]);
    // skipped T1, then scaled a third at T2: only T1 is a miss
    const tookT2 = run(open(), [fill('scale_out', at('14:45:30'), 27150, 1)]);
    expect(allDeviations(tookT2, path, at('14:55:00')).map((x) => x.targetIndex)).toEqual([1]);
    expect(allDeviations(open(), path, at('14:55:00')).map((x) => x.targetIndex)).toEqual([1, 2]);
    // already declared by the trader: the first skip is not reported twice
    const declared = recordOverride(open(), 'skipped_scale_out', 'letting it run', at('14:35:00'));
    expect(detectDeviations(declared, path, at('14:55:00')).map((x) => x.targetIndex)).toEqual([2]);
    const took = run(open(), [fill('scale_out', at('14:34:30'), 27250, 1)]);
    expect(detectDeviations(took, path, at('14:44:00'))).toEqual([]);
  });

  it('ticketAlerts names what was just hit', () => {
    const t = open();
    expect(ticketAlerts(t, 27300, at('14:31:00'))).toEqual([]);
    const inv = ticketAlerts(t, 27441, at('14:35:00'));
    expect(inv.map((a) => a.kind)).toEqual(['invalidation']);
    expect(inv[0]).toMatchObject({ level: 27440, text: 'NQ 27,441: invalidation 27,440 hit on the short.', action: 'Plan says out. reclaims the pre-market high.', dedupeKey: `ticket:${t.id}:invalidation` });
    expect(ticketAlerts(t, 27249, at('14:35:00')).map((a) => [a.kind, a.targetIndex, a.action])).toEqual([['target', 1, 'Plan says 33% off here.']]);
    expect(ticketAlerts(t, 27140, at('14:35:00')).map((a) => a.targetIndex)).toEqual([1, 2]);
    const scaled = run(t, [fill('scale_out', at('14:34:30'), 27250, 1)]);
    expect(ticketAlerts(scaled, 27249, at('14:35:00'))).toEqual([]);
    expect(ticketAlerts(t, 27300, at('20:00:00')).map((a) => a.kind)).toEqual(['time_stop']);
    // crossings only, when the previous price is supplied
    expect(ticketAlerts(t, 27249, at('14:35:00'), { prevPrice: 27245 })).toEqual([]);
    expect(ticketAlerts(t, 27249, at('14:35:00'), { prevPrice: 27260 })).toHaveLength(1);
    expect(ticketAlerts(planned(), 27500, at('14:35:00'))).toEqual([]);
  });
});

describe('scoreAdherence', () => {
  it('applies the spec deductions exactly, floors at 0', () => {
    const t = run(planned(), [fill('entry', at('14:30:00'), 27338, 3)]);
    const withKinds = (...kinds: Array<Parameters<typeof recordOverride>[1]>): Ticket => kinds.reduce((acc, k, i) => recordOverride(acc, k, 'r', at('14:31:00') + i), t);
    expect(scoreAdherence(t)).toEqual({ score: 100, deductions: [] });
    expect(scoreAdherence(withKinds('size_up')).score).toBe(60);
    expect(scoreAdherence(withKinds('held_through_invalidation')).score).toBe(70);
    expect(scoreAdherence(withKinds('held_through_time_stop')).score).toBe(80);
    expect(scoreAdherence(withKinds('skipped_scale_out')).score).toBe(90);
    expect(scoreAdherence(withKinds('skipped_scale_out', 'skipped_scale_out')).score).toBe(80);
    expect(scoreAdherence(withKinds('added_to_loser')).score).toBe(60);
    expect(scoreAdherence(withKinds('early_exit', 'moved_stop', 'other'))).toEqual({ score: 100, deductions: [] });
    expect(scoreAdherence(withKinds('size_up', 'added_to_loser', 'held_through_invalidation')).score).toBe(0);
    expect(scoreAdherence(withKinds('held_through_invalidation', 'held_through_time_stop', 'skipped_scale_out')).deductions).toEqual([
      { kind: 'held_through_invalidation', points: 30 }, { kind: 'held_through_time_stop', points: 20 }, { kind: 'skipped_scale_out', points: 10 },
    ]);
  });
});

/* ───────────────────────── Real recorded path: NQ 1m, 2026-11-17 ───────────────────────── */

describe('full lifecycle on recorded NQ 1m candles', () => {
  const all = loadRecordedCandles('NQ', '1m');
  const ENTRY_T = Date.parse('2026-11-17T14:30:00Z');
  const TIME_STOP = Date.parse('2026-11-17T20:00:00Z');
  const WINDOW_END = TIME_STOP + 24 * 60 * MIN;
  const candle = (t: number): Candle => { const c = all.find((x) => x.t === t); if (!c) throw new Error(`no recorded candle at ${iso(t)}`); return c; };
  const firstThrough = (level: number, from: number): Candle => { const c = all.find((x) => x.t >= from && x.l < level); if (!c) throw new Error(`never traded through ${level}`); return c; };

  /** The reason is the real 08:30 ET retail-sales print from the recorded calendar. */
  const row = loadRecordedCalendar().find((r) => r.date.startsWith('2026-11-17T13:30') && r.title === 'Retail Sales MoM');
  if (!row) throw new Error('recorded calendar has no Retail Sales MoM on 2026-11-17');
  const retailSales: Catalyst = {
    id: `cal_${row.id}`, code: 'RETAIL_SALES', name: row.title, tier: 2, scheduledAt: row.date, instruments: ['NQ', 'ES'],
    consensus: row.forecast, prior: row.previous, whisper: null, unit: row.unit, impliedMovePct: null, impliedMoveSource: null, history: [], predictionOdds: [], matrix: null,
    status: 'resolved', resolution: { actual: row.actual, branchId: null, resolvedAt: row.date }, source: 'tradingview:recorded', asOf: row.date,
  };
  const entryPrice = candle(ENTRY_T).o;
  const makeTicket = (): Ticket => {
    const r = validateDraft({
      accountId: 'mffu-pro-50k', instrument: 'NQ', direction: 'short', reason: { kind: 'catalyst', catalystId: retailSales.id },
      entry: { kind: 'time', at: iso(ENTRY_T), text: 'short the cash open after the 08:30 retail sales print' },
      targets: [{ price: 27250 }, { price: 27150 }, { price: 26900 }], invalidation: { price: 27440, reason: 'reclaims the pre-market high 27,432' }, timeStop: iso(TIME_STOP),
    }, { now: NOW, catalysts: [retailSales], setups: [], sizing: syntheticSizing(), accountIds: ['mffu-pro-50k'], recentTickets: [], price: candle(NOW - MIN).c, reentryCooldownMin: 15 });
    expect(r.errors).toEqual([]);
    return r.ticket!;
  };
  const during = (to: number): Candle[] => all.filter((c) => c.t >= ENTRY_T - 5 * MIN && c.t <= to);
  const throughWindow = all.filter((c) => c.t >= ENTRY_T - 5 * MIN && c.t < WINDOW_END);

  it('a closed trade shows adherence and MFE/MAE', () => {
    expect(row.actual).toBe(0.2);
    expect(entryPrice).toBe(27338);
    let t = makeTicket();
    expect(t.entry.kind).toBe('time');

    // Fills at the plan's levels, each in the first recorded minute that traded through the level.
    const h1 = firstThrough(27250, ENTRY_T), h2 = firstThrough(27150, ENTRY_T), h3 = firstThrough(26900, ENTRY_T);
    expect([h1.t, h2.t, h3.t].map((x) => iso(x).slice(11, 16))).toEqual(['14:34', '15:02', '15:38']);
    t = applyFill(t, { kind: 'entry', ts: iso(ENTRY_T), price: entryPrice, units: 3, source: 'manual' }, ENTRY_T).ticket;
    for (const [hit, price] of [[h1, 27250], [h2, 27150]] as const) {
      const now = hit.t + 30_000;
      expect(ticketAlerts(t, hit.l, now).some((a) => a.kind === 'target')).toBe(true);
      const o = applyFill(t, { kind: 'scale_out', ts: iso(now), price, units: 1, source: 'manual' }, now);
      expect(o.candidates).toEqual([]);
      t = o.ticket;
      expect(detectDeviations(t, during(now + 10 * MIN), now + 10 * MIN)).toEqual([]);
    }
    const exitTs = h3.t + 30_000;
    t = closeTicket(t, { price: 26900, ts: iso(exitTs) }, during(exitTs));

    expect(t.status).toBe('closed');
    expect(t.result).toMatchObject({ adherence: 100, deductions: [], followedPlan: true, exitPrice: 26900 });
    // (27,338-27,250) + (27,338-27,150) + (27,338-26,900) = 714 pts x $20
    expect(t.result?.pnlUsd).toBe(14280);
    expect(t.result?.mfeAfterExitPct).toBeNull(); // nothing after the exit has been seen yet
    expect(t.result?.capturePct).toBeNull(); // the path to the 15:00 ET time stop is not in yet

    const settled = settleResult(t, throughWindow, WINDOW_END);
    expect(settled.complete).toBe(true);
    expect(settled.window).toEqual({ from: iso(exitTs), to: iso(WINDOW_END) });
    const res = settled.ticket.result!;

    // Recompute the excursions straight from the recorded candles.
    const after = all.filter((c) => c.t >= exitTs && c.t < WINDOW_END);
    const lo = Math.min(...after.map((c) => c.l)), hi = Math.max(...after.map((c) => c.h));
    expect(lo).toBe(26658.5);
    expect(hi).toBe(27605.25);
    expect(res.mfeAfterExitPct).toBeCloseTo(((26900 - lo) / 26900) * 100, 3);
    expect(res.maeAfterExitPct).toBeCloseTo(((hi - 26900) / 26900) * 100, 3);
    expect(res.mfeAfterExitPct).toBe(0.898);
    expect(res.maeAfterExitPct).toBe(2.622);
    const exc = postExitExcursions(settled.ticket, all);
    expect(exc).toMatchObject({ bestPrice: 26658.5, worstPrice: 27605.25, exitPrice: 26900, bars: after.length });

    // Capture: 714 pts realized of 3 x (27,338 - 26,658.5) available before the time stop.
    const cap = capturePct(settled.ticket, all);
    expect(cap).toMatchObject({ bestPrice: 26658.5, availableUsd: 40770, realizedUsd: 14280 });
    expect(res.capturePct).toBe(35);
    expect(simulatePlan(settled.ticket, all)).toMatchObject({ complete: true, pnlUsd: 14280 });
    expect(TicketSchema.parse(settled.ticket)).toEqual(settled.ticket);
    expect(rollingAdherence([settled.ticket])).toMatchObject({ score: 100, count: 1, pnlUsd: 14280 });
    console.log('[real NQ 2026-11-17] plan-follower:', JSON.stringify({ entry: entryPrice, fills: settled.ticket.fills.map((f) => `${f.kind}@${f.price} ${f.ts.slice(11, 19)}`), ...res }));
  });

  it('the same trade with the exits skipped scores lower and feeds the override ledger', () => {
    let t = makeTicket();
    t = applyFill(t, { kind: 'entry', ts: iso(ENTRY_T), price: entryPrice, units: 3, source: 'manual' }, ENTRY_T).ticket;
    const h1 = firstThrough(27250, ENTRY_T);
    t = applyFill(t, { kind: 'scale_out', ts: iso(h1.t + 30_000), price: 27250, units: 1, source: 'manual' }, h1.t + 30_000).ticket;

    // No scale-out at T2 or T3; the worker's loop finds both on the real path, and the alert fires at the time stop.
    const h2 = firstThrough(27150, ENTRY_T), h3 = firstThrough(26900, ENTRY_T);
    expect(detectDeviations(t, during(h2.t + 4 * MIN), h2.t + 4 * MIN)).toEqual([]);
    expect(detectDeviations(t, during(h2.t + 5 * MIN), h2.t + 5 * MIN)).toEqual([{ kind: 'skipped_scale_out', ts: iso(h2.t), targetIndex: 2, price: 27150, reason: 'T2 27,150 traded at 10:02 ET; no scale-out within 5 min.' }]);
    t = recordOverride(t, 'skipped_scale_out', 'it is flushing, let it run', h2.t + 5 * MIN);
    expect(detectDeviations(t, during(h3.t + 6 * MIN), h3.t + 6 * MIN).map((d) => d.targetIndex)).toEqual([3]);
    const lateTs = Date.parse('2026-11-17T20:10:00Z');
    expect(ticketAlerts(t, candle(TIME_STOP).o, TIME_STOP).map((a) => a.kind)).toEqual(['time_stop']);

    // Out ten minutes after the time stop, at the recorded 20:10 open.
    const late = candle(lateTs);
    t = closeTicket(t, { price: late.o, ts: iso(lateTs) }, during(lateTs));
    expect(t.overrides.map((o) => o.kind).sort()).toEqual(['held_through_time_stop', 'skipped_scale_out', 'skipped_scale_out']);
    expect(t.overrides.filter((o) => o.reason.startsWith('Undeclared: '))).toHaveLength(2);
    expect(t.result).toMatchObject({ adherence: 60, followedPlan: false, exitPrice: late.o });
    expect(t.result?.deductions).toEqual([{ kind: 'skipped_scale_out', points: 10 }, { kind: 'skipped_scale_out', points: 10 }, { kind: 'held_through_time_stop', points: 20 }]);
    const expectedPnl = ((27338 - 27250) + 2 * (27338 - late.o)) * 20;
    expect(t.result?.pnlUsd).toBe(expectedPnl);

    // Plan impact: realized minus the 14,280 the ticket as written made on the same candles.
    const impact = t.overrides.reduce((a, o) => a + (o.pnlImpactUsd ?? 0), 0);
    expect(impact).toBeCloseTo(expectedPnl - 14280, 1);
    const settled = settleResult(t, throughWindow, WINDOW_END).ticket;
    const ledger = overrideLedger([settled], WINDOW_END);
    expect(ledger).toMatchObject({ month: '2026-11', instances: 3, pendingInstances: 0, lastPaidAt: null });
    expect(ledger.monthToDateUsd).toBeCloseTo(expectedPnl - 14280, 1);
    expect(planBreakingTradesToday([settled], lateTs + MIN, 'America/New_York')).toBe(1);
    expect(planBreakingTradesToday([settled], lateTs + 24 * 60 * MIN, 'America/New_York')).toBe(0);
    console.log('[real NQ 2026-11-17] override trade:', JSON.stringify({ exit: late.o, ...settled.result, impactUsd: ledger.monthToDateUsd, ledger: ledgerSentence(ledger) }));
  });

  it('a hold through invalidation on the real path is detected: long from the open, 27,300 lost at 09:31 ET', () => {
    const sizing = syntheticSizing({ direction: 'long', maxUnits: 1 });
    const r = validateDraft({
      accountId: 'mffu-pro-50k', instrument: 'NQ', direction: 'long', reason: { kind: 'catalyst', catalystId: retailSales.id },
      entry: { kind: 'time', at: iso(ENTRY_T), text: 'buy the cash open' },
      targets: [{ price: 27400 }, { price: 27450 }, { price: 27500 }], invalidation: { price: 27300, reason: 'loses the 09:29 low by 37' }, timeStop: iso(TIME_STOP),
    }, { now: NOW, catalysts: [retailSales], setups: [], sizing, accountIds: ['mffu-pro-50k'], recentTickets: [], price: candle(NOW - MIN).c });
    let t = applyFill(r.ticket!, { kind: 'entry', ts: iso(ENTRY_T), price: entryPrice, units: 1, source: 'manual' }, ENTRY_T).ticket;
    const hit = all.find((c) => c.t >= ENTRY_T && c.l <= 27300)!;
    expect(iso(hit.t).slice(11, 16)).toBe('14:30');
    expect(ticketAlerts(t, hit.l, hit.t + 30_000).map((a) => a.kind)).toEqual(['invalidation']);
    const exitTs = Date.parse('2026-11-17T15:00:00Z');
    t = closeTicket(t, { price: candle(exitTs).o, ts: iso(exitTs) }, during(exitTs));
    expect(t.fills.at(-1)?.kind).toBe('stop');
    expect(t.result).toMatchObject({ adherence: 70, deductions: [{ kind: 'held_through_invalidation', points: 30 }], followedPlan: false });
    expect(t.result?.pnlUsd).toBe((candle(exitTs).o - 27338) * 20);
    // the plan was out at 27,300 for -$760; holding cost the difference
    expect(t.overrides[0]?.pnlImpactUsd).toBe((candle(exitTs).o - 27300) * 20);
    console.log('[real NQ 2026-11-17] held-through-invalidation long:', JSON.stringify({ exit: candle(exitTs).o, pnlUsd: t.result?.pnlUsd, impactUsd: t.overrides[0]?.pnlImpactUsd, adherence: t.result?.adherence }));
  });
});

describe('capture comparison, ledger and prompt', () => {
  const closedWith = (id: string, closedAt: string, capture: number | null, followed: boolean, overrides: Ticket['overrides'] = []): Ticket => ({
    ...run(planned(), [fill('entry', at('14:30:00'), 27338, 3)]), id, status: 'closed', closedAt, overrides,
    result: { pnlUsd: 0, exitPrice: 27300, adherence: followed ? 100 : 70, deductions: [], mfeAfterExitPct: null, maeAfterExitPct: null, capturePct: capture, followedPlan: followed },
  });

  it('returns nulls, not zeros, with no sample', () => {
    const none = captureComparison([], '2026-11-01T00:00:00Z');
    expect(none).toMatchObject({ planCapturePct: null, overrideCapturePct: null, planCount: 0, overrideCount: 0 });
    expect(none.text).toBe('No closed trades with a capture number yet. No sample, no verdict.');
    const planOnly = captureComparison([closedWith('a', '2026-11-10T20:00:00Z', 60, true)], '2026-11-01T00:00:00Z');
    expect(planOnly).toMatchObject({ planCapturePct: 60, planCount: 1, overrideCapturePct: null, overrideCount: 0 });
    expect(planOnly.text).toBe('Plan-following exits captured 60% of the available move (1 trade); overrides: no sample.');
    expect(rollingAdherence([])).toEqual({ score: null, count: 0, pnlUsd: null, ticketIds: [] });
  });

  it('averages plan-following and override trades separately, inside the window', () => {
    const ts = [
      closedWith('a', '2026-11-10T20:00:00Z', 70, true), closedWith('b', '2026-11-11T20:00:00Z', 52, true),
      closedWith('c', '2026-11-12T20:00:00Z', 30, false), closedWith('d', '2026-11-13T20:00:00Z', 16, false),
      closedWith('old', '2026-10-20T20:00:00Z', 5, false), closedWith('unscored', '2026-11-14T20:00:00Z', null, true),
    ];
    const c = captureComparison(ts, '2026-11-01T04:00:00Z');
    expect(c).toMatchObject({ planCapturePct: 61, planCount: 2, overrideCapturePct: 23, overrideCount: 2, unscored: 1 });
    expect(c.text).toBe('Plan-following exits captured 61% of the available move (2 trades); overrides captured 23% of the available move (2 trades).');
    expect(rollingAdherence(ts, 2)).toMatchObject({ score: 85, count: 2, ticketIds: ['unscored', 'd'] });
  });

  it('builds the ledger and the prompt from real ledger numbers only', () => {
    const ov = (ts: string, impact: number | null): Ticket['overrides'][number] => ({ ts, kind: 'skipped_scale_out', reason: 'r', pnlImpactUsd: impact });
    const ts = [
      closedWith('a', '2026-11-06T20:00:00Z', 80, false, [ov('2026-11-06T15:00:00Z', 900)]),
      closedWith('b', '2026-11-12T20:00:00Z', 10, false, [ov('2026-11-12T15:00:00Z', -2500), ov('2026-11-12T15:30:00Z', -2500)]),
      closedWith('c', '2026-11-16T20:00:00Z', 20, false, [ov('2026-11-16T15:00:00Z', -2300), ov('2026-11-16T16:00:00Z', null)]),
      closedWith('oct', '2026-10-30T20:00:00Z', 20, false, [ov('2026-10-30T15:00:00Z', -9999)]),
    ];
    const ledger = overrideLedger(ts, Date.parse('2026-11-17T18:00:00Z'));
    expect(ledger).toMatchObject({ monthToDateUsd: -6400, instances: 5, pendingInstances: 1, lastPaidAt: '2026-11-06T15:00:00.000Z', month: '2026-11', planCapturePct: null, overrideCapturePct: 36.7 });
    expect(ledger.trades).toEqual([{ ticketId: 'a', instrument: 'NQ', impactUsd: 900, overrides: 1 }, { ticketId: 'b', instrument: 'NQ', impactUsd: -5000, overrides: 2 }, { ticketId: 'c', instrument: 'NQ', impactUsd: -2300, overrides: 2 }]);
    expect(ledgerSentence(ledger)).toBe('Overrides are −$6,400 month to date across 5 instances; the last one that paid was Nov 6.');
    const open = run(planned(), [fill('entry', at('14:30:00'), 27338, 3)]);
    expect(overridePrompt(open, 1760, ledger)).toBe([
      'Plan: NQ short, 33% off at 27,250, 33% at 27,150, rest at 26,900; out at 27,440; flat by 15:00 ET.',
      'Live P&L +$1,760.',
      'Overrides are −$6,400 month to date across 5 instances; the last one that paid was Nov 6.',
      'Your call.',
    ].join('\n'));

    const empty = overrideLedger([], NOW);
    expect(empty).toMatchObject({ monthToDateUsd: 0, instances: 0, lastPaidAt: null, planCapturePct: null, overrideCapturePct: null });
    expect(overridePrompt(open, null, empty)).toContain('Live P&L: no mark.\nNo overrides on the books this month. This would be the first.');
    expect(ledgerSentence({ ...empty, instances: 2, monthToDateUsd: -300 })).toBe('Overrides are −$300 month to date across 2 instances; none has paid yet.');
    expect(ledgerSentence({ ...empty, instances: 1, pendingInstances: 1 })).toBe('1 instance of overriding this month, none settled yet; none has paid yet.');
  });
});
