import { describe, expect, it } from 'vitest';
import { loadRecordedCandles } from '@desk/feeds';
import type { GuardrailFiring, HedgeViolation } from '@desk/contracts';
import { checkChat, checkTicket, combineEffects } from './entry';
import { findFlushes } from './flush';
import { lintVoice } from './voice';
import { et, inventedNumbers, makeCtx, syntheticCatalyst, syntheticDraft, syntheticHeld, syntheticSizing, syntheticState, syntheticTicket } from './testkit';

const NQ_D1 = loadRecordedCandles('NQ', '1d');
const fired = (fs: GuardrailFiring[], pattern: string): GuardrailFiring[] => fs.filter((f) => f.pattern === pattern);

describe('guardrails acceptance', () => {
  it('recorded NQ daily candles: the flush and confirmation days the scenarios rely on', () => {
    const flushes = findFlushes(NQ_D1, et(2026, 11, 21, 12, 0));
    const byDate = Object.fromEntries(flushes.map((f) => [f.flushDate, f]));
    // Week of 2026-11-16: three real 2%+ down days.
    expect(byDate['2026-11-16']!.dropPct).toBeCloseTo(-2.68, 2);
    expect(byDate['2026-11-19']!.dropPct).toBeCloseTo(-2.16, 2);
    expect(byDate['2026-11-20']!.dropPct).toBeCloseTo(-5.54, 2);
    expect(byDate['2026-11-17']).toBeUndefined();
    // Nov 16 flush: low undercut the next session, no confirmation day since.
    expect(byDate['2026-11-16']!.confirmation).toBeNull();
    expect(byDate['2026-11-16']!.lowUndercut?.date).toBe('2026-11-17');
    // Nov 5 flush (-6.35%): Nov 6 closed green but under the midpoint; Nov 9 closed up through it.
    expect(byDate['2026-11-05']!.dropPct).toBeCloseTo(-6.35, 2);
    expect(byDate['2026-11-05']!.midpoint).toBeCloseTo(27619.25, 2);
    expect(byDate['2026-11-05']!.lowUndercut?.date).toBe('2026-11-06');
    expect(byDate['2026-11-05']!.confirmation).toEqual({ date: '2026-11-09', close: 28014.5 });
  });

  it('bottom-call, size-creep, hold-the-winner, cross-account and late-night rules each fire on a scripted scenario and not on a control', () => {
    /* 1. Bottom call. Real recorded NQ daily candles.
       Scenario: long NQ ticket Tue 2026-11-17 11:00 ET, 19h after the Nov 16 close (-2.68%), no confirmation day.
       Control A: the same ticket Wed 2026-11-18 11:00 ET, 19h after the Nov 17 close (-0.77%, not a flush); the Nov 16 flush is 43h back. */
    const draft = syntheticDraft();
    const candles = { d1: { NQ: NQ_D1 } };
    const bcScenario = fired(checkTicket(draft, makeCtx(et(2026, 11, 17, 11, 0), { candles, sizing: syntheticSizing() })), 'bottom_call');
    const bcControl = fired(checkTicket(draft, makeCtx(et(2026, 11, 18, 11, 0), { candles, sizing: syntheticSizing() })), 'bottom_call');
    expect(bcScenario).toHaveLength(1);
    expect(bcScenario[0]!.text).toBe("Long NQ 19h after the Nov 16 flush (−2.7%). Confirmation day hasn't printed; the Oct 30 and Nov 5 flush lows were both undercut before one did. Quarter size until it does: 2 contracts max.");
    expect(bcScenario[0]!.effect).toBe('cap_size');
    expect(bcScenario[0]!.capUnits).toBe(2);
    expect(bcScenario[0]!.episodeKey).toBe('NQ:2026-11-16');
    expect(bcControl).toHaveLength(0);
    /* Control B, with vs. without a confirmation day (real candles, phrase path):
       "bottom is in" on Fri Nov 6 11:00 ET, 19h after the Nov 5 flush, fires; the same words on Tue Nov 10 11:00 ET,
       after the Nov 9 confirmation day (close 28,014.5 above the 27,619.25 midpoint), do not. */
    const said = 'I feel like the bottom is in';
    const phraseScenario = fired(checkChat(said, makeCtx(et(2026, 11, 6, 11, 0), { candles })), 'bottom_call');
    const phraseControl = fired(checkChat(said, makeCtx(et(2026, 11, 10, 11, 0), { candles })), 'bottom_call');
    expect(phraseScenario).toHaveLength(1);
    expect(phraseScenario[0]!.text).toContain('19h after the Nov 5 flush (−6.4%)');
    expect(phraseControl).toHaveLength(0);

    /* 2. Size creep (synthetic account state). 2.1x the 20-trade median, 2h after a +45% day; control is a +10% day. */
    const now = et(2026, 11, 18, 14, 0);
    const perp = syntheticDraft({ accountId: 'vest-instant', instrument: 'NQ-PERP', units: 21_000 });
    const perpSizing = syntheticSizing({ accountId: 'vest-instant', instrument: 'NQ-PERP', maxUnits: 12_000, notionalUsd: 12_000 });
    const scCtx = (dayPnl: number) => makeCtx(now, { sizing: perpSizing, medianNotional20: 10_000, accountStates: [syntheticState(now, { dayPnl })] });
    const scScenario = fired(checkTicket(perp, scCtx(2250)), 'size_creep');
    const scControl = fired(checkTicket(perp, scCtx(500)), 'size_creep');
    expect(scScenario).toHaveLength(1);
    expect(scScenario[0]!.text).toBe("Size is 2.1x your 20-trade median after a +45% day. The engine's survivable size is $12,000. Confirm $12,000 or lower.");
    expect(scScenario[0]!.capUnits).toBe(12_000);
    expect(scControl).toHaveLength(0);
    // Second control: same +45% day, size at 1.4x the median.
    expect(fired(checkTicket({ ...perp, units: 14_000 }, scCtx(2250)), 'size_creep')).toHaveLength(0);

    /* 3. Hold the winner (synthetic position). Above T1 with one scale-out done; control is the same question below T1. */
    const ticket = syntheticTicket(now, { fills: [{ ts: '2026-11-18T18:00:00.000Z', price: 27050, units: 1, kind: 'scale_out', source: 'manual' }] });
    const question = 'Should I keep holding it fully?';
    const hwCtx = (mark: number) => makeCtx(now, { tickets: [ticket], positions: [syntheticHeld(now, {}, { mark, pnlUsd: (mark - 27000) * 20 * 2 })] });
    const hwScenario = fired(checkChat(question, hwCtx(27090)), 'hold_the_winner');
    const hwControl = fired(checkChat(question, hwCtx(27020)), 'hold_the_winner');
    expect(hwScenario).toHaveLength(1);
    expect(hwScenario[0]!.text).toBe('Exits were written before the entry: one-third off at 27,130, 40 points away. P&L is +$3,600 now; overrides are −$6,400 MTD across 7. Scale there.');
    expect(hwControl).toHaveLength(0);

    /* 4. Cross-account offset. The hedging detector's violation is passed in; control is the same ticket with none. */
    const violation: HedgeViolation = { accountA: 'vest-eval', accountB: 'vest-instant', instrumentA: 'NQ-PERP', instrumentB: 'NQ-PERP', correlation: -1, clause: 'Vest: coordinating accounts incl. opposite positions is prohibited.', text: 'synthetic' };
    const short = syntheticDraft({ accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short' });
    const caScenario = checkTicket(short, makeCtx(now, { hedgeViolations: [violation] }));
    const caControl = checkTicket(short, makeCtx(now, { hedgeViolations: [] }));
    expect(fired(caScenario, 'cross_account_offset')).toHaveLength(1);
    expect(fired(caScenario, 'cross_account_offset')[0]!.text).toBe('Blocked: short NQ-PERP on vest-eval is opposite exposure to NQ-PERP on vest-instant. Clause: "Vest: coordinating accounts incl. opposite positions is prohibited". One direction across accounts, or one account flat.');
    expect(combineEffects(caScenario).blocks).toBe(true);
    expect(fired(caControl, 'cross_account_offset')).toHaveLength(0);

    /* 5. Late night. SNDK long at 01:14 local with the next scheduled catalyst 20h out; control has one 8h out. */
    const night = et(2026, 11, 18, 1, 14);
    const sndk = syntheticDraft({ accountId: 'vest-instant', instrument: 'SNDK', units: 2_000 });
    const far = syntheticCatalyst(night + 20 * 3_600_000, { instruments: [] });
    const near = syntheticCatalyst(night + 8 * 3_600_000, { instruments: [] });
    const lnScenario = fired(checkTicket(sndk, makeCtx(night, { catalysts: [far] })), 'late_night_idea');
    const lnControl = fired(checkTicket(sndk, makeCtx(night, { catalysts: [near] })), 'late_night_idea');
    expect(lnScenario).toHaveLength(1);
    expect(lnScenario[0]!.text).toBe("It's 01:14 and this SNDK long has no scheduled catalyst inside 12 hours. Next on the calendar is CPI, 20h out. Name the catalyst, or it saves as a watch.");
    expect(lnScenario[0]!.effect).toBe('block');
    expect(lnControl).toHaveLength(0);
    // Second control: the same ticket and calendar at 14:00 local.
    expect(fired(checkTicket(sndk, makeCtx(et(2026, 11, 18, 14, 0), { catalysts: [syntheticCatalyst(et(2026, 11, 19, 10, 0), { instruments: [] })] })), 'late_night_idea')).toHaveLength(0);
    // Second miss the same night: saved as a watch, not a trade.
    const second = fired(checkTicket(sndk, makeCtx(night + 10 * 60_000, { catalysts: [far], priorFirings: lnScenario })), 'late_night_idea');
    expect(second[0]!.effect).toBe('downgrade_to_watch');
    expect(second[0]!.text).toBe('Two asks tonight and still no scheduled catalyst inside 12 hours. Saved as a watch, not a trade. It keeps until 06:00.');

    for (const f of [...bcScenario, ...phraseScenario, ...scScenario, ...hwScenario, ...fired(caScenario, 'cross_account_offset'), ...lnScenario, ...second]) {
      expect(lintVoice(f.text, makeCtx(now).profile.voice.banned)).toEqual([]);
      expect(inventedNumbers(f)).toEqual([]);
    }
  });
});
