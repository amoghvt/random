import { describe, expect, it } from 'vitest';
import { GuardrailPattern, iso, type Candle, type GuardrailFiring, type LaggedFact } from '@desk/contracts';
import { checkChat, checkPositions, checkSession, checkTicket, combineEffects } from './entry';
import { acknowledgeCorrectRead } from './fairness';
import type { FlushState } from './flush';
import { findFlushes } from './flush';
import { recordFollowUp, scorecard, tuneThresholds, verdict } from './learning';
import { matchBottomCall, matchCrowd, matchHoldQuestion, matchLiquidityRun, matchOppositeSide, matchRegret, matchSqueezeAsStrength, matchTradeIdea, mentionedPriceSymbols } from './phrases';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { lintVoice, sentences } from './voice';
import {
  EMPTY_LEDGER, PROFILE, et, inventedNumbers, makeCtx, syntheticCatalyst, syntheticDraft, syntheticEvent, syntheticHeld, syntheticLedger,
  syntheticSizing, syntheticState, syntheticTicket,
} from './testkit';

const HOUR = 3_600_000;
const NOW = et(2026, 11, 18, 14, 0);
/** Every non-repeat text any test produces; the voice lint and the no-invented-number check run over all of them at the end. */
const SEEN: GuardrailFiring[] = [];
const only = (fs: GuardrailFiring[], pattern: GuardrailPattern): GuardrailFiring[] => {
  const out = fs.filter((f) => f.pattern === pattern);
  SEEN.push(...out);
  return out;
};

describe('phrase matchers', () => {
  it('bottom call', () => {
    for (const s of ['I feel like the bottom is in', 'pretty sure NQ bottomed', 'that was the low', 'Capitulation is done', "bottom's in", 'the lows are in', 'is the bottom in?', 'sellers look exhausted'])
      expect(matchBottomCall(s), s).not.toBeNull();
    for (const s of ['no way the bottom is in', "I don't think that was the low", 'new low in NVDA today', 'sold the bottom in the range', 'what is the low of the day'])
      expect(matchBottomCall(s), s).toBeNull();
  });
  it('hold, squeeze, liquidity run, regret, crowd, idea', () => {
    for (const s of ['Should I keep holding it fully', 'hold?', 'let it ride', 'thinking of not selling at T2']) expect(matchHoldQuestion(s), s).not.toBeNull();
    expect(matchHoldQuestion('where is my stop')).toBeNull();
    for (const s of ['that was institutional buying', 'this is real buying', 'smart money stepped in', 'looks like accumulation']) expect(matchSqueezeAsStrength(s), s).not.toBeNull();
    expect(matchSqueezeAsStrength('that was a big candle')).toBeNull();
    expect(matchLiquidityRun('it will run the highs first')?.side).toBe('highs');
    expect(matchLiquidityRun('they take the highs first then drop')?.side).toBe('highs');
    expect(matchLiquidityRun('going to sweep the lows')?.side).toBe('lows');
    expect(matchLiquidityRun('highs of the day were 27,400')).toBeNull();
    for (const s of ['if I had held I would have doubled', 'left so much on the table', "if I hadn't sold it'd be up 3k", 'sold way too early']) expect(matchRegret(s), s).not.toBeNull();
    expect(matchRegret('I held to T2 and sold')).toBeNull();
    for (const s of ['everyone is long here', 'consensus is bullish', 'fintwit loves it']) expect(matchCrowd(s), s).not.toBeNull();
    expect(matchCrowd('CPI consensus is 3.1')).toBeNull();
    expect(matchTradeIdea('full port gold on RSI')).not.toBeNull();
    expect(matchTradeIdea('what was CPI last month')).toBeNull();
  });
  it('the other side, without tripping on "short-term" or "short squeeze"', () => {
    for (const s of ['should I add some shorts here', 'thinking of a hedge', 'maybe buy puts']) expect(matchOppositeSide(s, 'long'), s).not.toBeNull();
    for (const s of ['short-term this looks fine', 'that was a short squeeze', 'shorts are covering']) expect(matchOppositeSide(s, 'long'), s).toBeNull();
    expect(matchOppositeSide('should I flip long', 'short')).not.toBeNull();
    expect(matchOppositeSide('how long until CPI', 'short')).toBeNull();
  });
  it('instrument mentions resolve to price symbols', () => {
    expect(mentionedPriceSymbols('long nasdaq and NVDA')).toEqual(expect.arrayContaining(['NQ', 'NVDA']));
    expect(mentionedPriceSymbols('MNQ looks heavy')).toEqual(['NQ']);
    expect(mentionedPriceSymbols('es muy bueno')).toEqual([]);
  });
});

describe('bottom_call (synthetic)', () => {
  const day = (d: number, o: number, h: number, l: number, c: number): Candle => ({ symbol: 'NQ', tf: '1d', t: et(2026, 3, d, 0, 0), o, h, l, c, v: 1, source: 'synthetic' });
  const synthetic = [day(2, 100, 101, 99, 100), day(3, 100, 100.5, 96, 97), day(4, 97, 100, 96.5, 99.5), day(5, 99.5, 100, 99, 99.8)];

  it('defines flush and confirmation day on a synthetic sequence', () => {
    const before = findFlushes(synthetic, et(2026, 3, 4, 10, 0));
    expect(before).toHaveLength(1);
    expect(before[0]!.dropPct).toBeCloseTo(-3, 5);
    expect(before[0]!.midpoint).toBe(98.25);
    expect(before[0]!.confirmation).toBeNull();
    // Mar 4 closes up and above the 98.25 midpoint, but only counts once its session is complete.
    expect(findFlushes(synthetic, et(2026, 3, 4, 15, 59))[0]!.confirmation).toBeNull();
    expect(findFlushes(synthetic, et(2026, 3, 4, 16, 0))[0]!.confirmation).toEqual({ date: '2026-03-04', close: 99.5 });
  });

  it('long ticket inside 24h: fires without, not with, a confirmation-day event (pre-computed helper output)', () => {
    const now = et(2026, 3, 4, 10, 0);
    const flush: FlushState = findFlushes(synthetic, now)[0]!;
    const without = only(checkTicket(syntheticDraft(), makeCtx(now, { confirmationDays: { NQ: [flush] } })), 'bottom_call');
    const withConfirmation = only(checkTicket(syntheticDraft(), makeCtx(now, { confirmationDays: { NQ: [{ ...flush, confirmation: { date: '2026-03-04', close: 99.5 } }] } })), 'bottom_call');
    expect(without).toHaveLength(1);
    expect(without[0]!.text).toBe("Long NQ 18h after the Mar 3 flush (−3.0%). Confirmation day hasn't printed. Quarter size until it does.");
    expect(without[0]!.capUnits).toBeUndefined();
    expect(withConfirmation).toHaveLength(0);
  });

  it('does not fire on a short ticket or past the 24h window; the phrase without a flush uses the variant with no numbers', () => {
    const now = et(2026, 3, 4, 10, 0);
    expect(only(checkTicket(syntheticDraft({ direction: 'short' }), makeCtx(now, { candles: { d1: { NQ: synthetic } } })), 'bottom_call')).toHaveLength(0);
    expect(only(checkTicket(syntheticDraft(), makeCtx(et(2026, 3, 4, 15, 59) + 60_000 * 2 + 0 * HOUR + 1 * HOUR, { candles: { d1: { NQ: synthetic.slice(0, 2) } } })), 'bottom_call')).toHaveLength(0);
    const f = only(checkChat('capitulation is done', makeCtx(now, { candles: { d1: { NQ: synthetic.slice(0, 1) } } })), 'bottom_call');
    expect(f[0]!.text).toBe('Bottom call with no confirmation day on record for NQ. Quarter size until one prints.');
    expect(f[0]!.effect).toBe('none');
  });
});

describe('thin_fail_price', () => {
  it('is Critical inside 1.5x the 1-minute ATR and exposes the 5-minute cadence; silent with room', () => {
    const thin = only(checkPositions(makeCtx(NOW, { positions: [syntheticHeld(NOW, {}, { failPrice: 27072, distancePts: 18, distancePct: 0.07, atr1m: 14 })] })), 'thin_fail_price');
    expect(thin).toHaveLength(1);
    expect(thin[0]!.text).toBe('NQ long: fail price 27,072 is 18 points away, 1.3x the 1-minute ATR of 14.0. Status Critical. Cut size or close; one ordinary wick reaches it.');
    expect(thin[0]!.evidence).toMatchObject({ status: 'Critical', repeatEveryMin: 5 });
    expect(only(checkPositions(makeCtx(NOW, { positions: [syntheticHeld(NOW)] })), 'thin_fail_price')).toHaveLength(0);
  });
  it('derives the ATR from synthetic 1-minute candles when the status has none, and stays silent with no ATR at all', () => {
    const m1: Candle[] = Array.from({ length: 20 }, (_, i) => ({ symbol: 'NQ', tf: '1m' as const, t: NOW - (21 - i) * 60_000, o: 27090, h: 27095, l: 27085, c: 27090, v: 1, source: 'synthetic' }));
    const held = syntheticHeld(NOW, {}, { failPrice: 27078, distancePts: 12, distancePct: 0.04, atr1m: null });
    const f = only(checkPositions(makeCtx(NOW, { positions: [held], candles: { d1: {}, m1: { NQ: m1 } } })), 'thin_fail_price');
    expect(f[0]!.evidence.atr1m).toBe(10);
    expect(only(checkPositions(makeCtx(NOW, { positions: [held] })), 'thin_fail_price')).toHaveLength(0);
  });
});

describe('squeeze_as_strength', () => {
  const spike = syntheticEvent(NOW, { id: 'se_spike', detector: 'volume_context', kind: 'spike_rejected', level: 27130, data: { points: 110, minutesToRejection: 4, volumePctOfImpulse: 60, impulseLabel: '17:00' } });
  it('quotes the candle from the watcher event; silent without the event', () => {
    const f = only(checkChat('that candle was institutional buying', makeCtx(NOW, { structure: [spike] })), 'squeeze_as_strength');
    expect(f[0]!.text).toBe('That candle: +110 pts, rejected within 4 minutes, volume 60% of the 17:00 impulse. Covering, not accumulation. It counts after a hold above 27,130, not before.');
    expect(only(checkChat('that candle was institutional buying', makeCtx(NOW)), 'squeeze_as_strength')).toHaveLength(0);
    expect(only(checkChat('that candle was big', makeCtx(NOW, { structure: [spike] })), 'squeeze_as_strength')).toHaveLength(0);
  });
  it('drops clauses the event does not carry and falls back to the watcher sentence', () => {
    const partial = only(checkChat('smart money', makeCtx(NOW, { structure: [{ ...spike, id: 'se_partial', level: null, data: { points: 85 } }] })), 'squeeze_as_strength');
    expect(partial[0]!.text).toBe('That candle: +85 pts. Covering, not accumulation. It counts after a second push on rising volume, not before.');
    const bare = only(checkChat('smart money', makeCtx(NOW, { structure: [{ ...spike, id: 'se_bare', level: null, data: {}, text: 'spike, rejected, volume below the impulse' }] })), 'squeeze_as_strength');
    expect(bare[0]!.text).toContain('That candle, per the watcher: spike, rejected, volume below the impulse.');
  });
});

describe('liquidity_run', () => {
  const stall = (pct: number) => syntheticEvent(NOW, { id: 'se_retrace', detector: 'retrace_quality', kind: pct < 50 ? 'bounce_stalled_under_50' : 'retrace', bias: -1, data: { retracePct: pct } });
  const pools = [
    syntheticEvent(NOW, { id: 'se_hi', detector: 'liquidity_pool', kind: 'equal_highs', level: 27090 * 1.012 }),
    syntheticEvent(NOW, { id: 'se_lo', detector: 'liquidity_pool', kind: 'equal_lows', level: 27090 * (1 - 0.017) }),
  ];
  it('lists both sides and the fail price while long and stalled; silent at a 62% retrace or while short', () => {
    const said = 'it will run the highs first';
    const f = only(checkChat(said, makeCtx(NOW, { positions: [syntheticHeld(NOW)], structure: [stall(38), ...pools] })), 'liquidity_run');
    expect(f[0]!.text).toBe('Long NQ and the retrace is 38% of the leg. Liquidity sits both sides: buy stops 1.2% up, sell stops 1.7% down, fail price 1.0% down. Order of arrival decides, not the thesis.');
    expect(only(checkChat(said, makeCtx(NOW, { positions: [syntheticHeld(NOW)], structure: [stall(62), ...pools] })), 'liquidity_run')).toHaveLength(0);
    expect(only(checkChat(said, makeCtx(NOW, { positions: [syntheticHeld(NOW, { direction: 'short' })], structure: [stall(38), ...pools] })), 'liquidity_run')).toHaveLength(0);
  });
  it('drops a side that has no mapped pool', () => {
    const f = only(checkChat('sweep the highs', makeCtx(NOW, { positions: [syntheticHeld(NOW)], structure: [stall(38), pools[1]!] })), 'liquidity_run');
    expect(f[0]!.text).toBe('Long NQ and the retrace is 38% of the leg. Mapped from here: sell stops 1.7% down, fail price 1.0% down. Order of arrival decides, not the thesis.');
  });
});

describe('hedge_the_decision', () => {
  it('fires on a question about shorts while long the same instrument, not on another instrument or with no position', () => {
    const ctx = makeCtx(NOW, { positions: [syntheticHeld(NOW)] });
    const f = only(checkChat('should I add some shorts here', ctx), 'hedge_the_decision');
    expect(f[0]!.text).toBe("You're long NQ and asking about the other side. Long and short the same index is flat plus fees. Cut size or close; don't cancel the trade.");
    expect(only(checkChat('should I short NVDA', ctx), 'hedge_the_decision')).toHaveLength(0);
    expect(only(checkChat('should I add some shorts here', makeCtx(NOW)), 'hedge_the_decision')).toHaveLength(0);
  });
  it('blocks the opposite ticket on the same account, not the same-direction one', () => {
    const ctx = makeCtx(NOW, { positions: [syntheticHeld(NOW)] });
    const f = only(checkTicket(syntheticDraft({ instrument: 'MNQ', direction: 'short' }), ctx), 'hedge_the_decision');
    expect(f[0]!.effect).toBe('block');
    expect(f[0]!.text).toContain('Short MNQ ticket against your open NQ long on mffu-builder-50k.');
    expect(only(checkTicket(syntheticDraft({ instrument: 'MNQ', direction: 'long' }), ctx), 'hedge_the_decision')).toHaveLength(0);
  });
});

describe('regret_loop', () => {
  it('shows plan-capture vs override-capture in one line, and a no-numbers variant when there are no stats', () => {
    const f = only(checkChat('if I had held I would have doubled', makeCtx(NOW)), 'regret_loop');
    expect(f[0]!.text).toBe('Plan exits captured 61% of available moves this month; overrides 23%.');
    const empty = only(checkChat('if I had held I would have doubled', makeCtx(NOW, { ledger: EMPTY_LEDGER })), 'regret_loop');
    expect(empty[0]!.text).not.toMatch(/\d/);
    const half = only(checkChat('left so much on the table', makeCtx(NOW, { ledger: { ...EMPTY_LEDGER, planCapturePct: 58 } })), 'regret_loop');
    expect(half[0]!.text).toBe('Plan exits captured 58% of available moves this month; no override exits to compare yet.');
    expect(only(checkChat('sold at T2 per plan', makeCtx(NOW)), 'regret_loop')).toHaveLength(0);
  });
});

describe('research_as_permission', () => {
  const now = et(2026, 11, 21, 12, 0);
  const fact = (over: Partial<LaggedFact>): LaggedFact => ({ id: 'lf_synthetic_13f', kind: '13F', text: 'synthetic: fund added NVDA', periodEnd: '2026-09-30', publishedAt: '2026-11-14T21:00:00.000Z', source: 'synthetic', ...over });
  it('stamps the age of a 13F from the lagged fact', () => {
    const f = only(checkChat('the 13F shows they added NVDA', makeCtx(now, { laggedFacts: [fact({})] })), 'research_as_permission');
    expect(f[0]!.text).toBe("13F is as of Sep 30, 52 days stale. That's where they were, not where they are. Name the catalyst.");
  });
  it('stamps a restated buyback, skips a fresh fact, and says so when no as-of date is on file', () => {
    const restated = only(checkChat('they announced a buyback', makeCtx(now, { laggedFacts: [fact({ id: 'lf_bb', kind: 'buyback', text: 'synthetic: reiterated existing authorization', periodEnd: '2026-08-12' })] })), 'research_as_permission');
    expect(restated[0]!.text).toBe('Buyback is a restatement of the Aug 12 authorization, 101 days old. No new money in it. Name the catalyst.');
    expect(only(checkChat('the 13F shows they added', makeCtx(now, { laggedFacts: [fact({ periodEnd: '2026-11-16' })] })), 'research_as_permission')).toHaveLength(0);
    const undated = only(checkChat('the 13F shows they added', makeCtx(now)), 'research_as_permission');
    expect(undated[0]!.text).toBe("No as-of date on file for that 13F, so it isn't evidence yet. Name the catalyst.");
  });
  it('answers a crowd with the catalyst question; silent on an ordinary message', () => {
    const f = only(checkChat('everyone is long, it has to go', makeCtx(now)), 'research_as_permission');
    expect(f[0]!.text).toBe('A crowd is positioning, not a catalyst. Name the catalyst.');
    expect(only(checkChat('NQ is at 27,090', makeCtx(now)), 'research_as_permission')).toHaveLength(0);
  });
});

describe('catalyst_hold', () => {
  const cpi = syntheticCatalyst(et(2026, 11, 19, 8, 30));
  const inWindow = { id: cpi.id, name: cpi.name, at: cpi.scheduledAt, tier: 1 };
  it('blocks an open position into a Tier-1 event with implied move above room', () => {
    const ctx = makeCtx(NOW, { catalysts: [cpi], tickets: [syntheticTicket(NOW)], positions: [syntheticHeld(NOW, {}, { catalystInWindow: inWindow })] });
    const f = only(checkPositions(ctx), 'catalyst_hold');
    expect(f[0]!.text).toBe('NQ long is open into CPI at 08:30 ET: implied move ±1.8%, fail price 1.0% away. The hold is blocked. Flat before the print, or re-enter as the catalyst trade at survivable size.');
    expect(f[0]!.effect).toBe('block');
  });
  it('allows the catalyst trade at survivable size, a position with room, and a Tier-2 event', () => {
    const catalystTrade = syntheticTicket(NOW, { reason: { kind: 'catalyst', catalystId: cpi.id } });
    const held = syntheticHeld(NOW, {}, { catalystInWindow: inWindow });
    expect(only(checkPositions(makeCtx(NOW, { catalysts: [cpi], tickets: [catalystTrade], positions: [held] })), 'catalyst_hold')).toHaveLength(0);
    // The same catalyst trade above the engine size is not exempt.
    expect(only(checkPositions(makeCtx(NOW, { catalysts: [cpi], tickets: [catalystTrade], positions: [syntheticHeld(NOW, { units: 5 }, { catalystInWindow: inWindow })] })), 'catalyst_hold')).toHaveLength(1);
    expect(only(checkPositions(makeCtx(NOW, { catalysts: [cpi], tickets: [syntheticTicket(NOW)], positions: [syntheticHeld(NOW, {}, { catalystInWindow: inWindow, distancePct: 2.4 })] })), 'catalyst_hold')).toHaveLength(0);
    expect(only(checkPositions(makeCtx(NOW, { catalysts: [{ ...cpi, tier: 2 }], tickets: [syntheticTicket(NOW)], positions: [syntheticHeld(NOW, {}, { catalystInWindow: { ...inWindow, tier: 2 } })] })), 'catalyst_hold')).toHaveLength(0);
  });
  it('finds the crossing from the ticket time stop, and states an unpriced event without inventing a move', () => {
    const ticket = syntheticTicket(NOW, { timeStop: iso(et(2026, 11, 19, 15, 30)) });
    expect(only(checkPositions(makeCtx(NOW, { catalysts: [cpi], tickets: [ticket], positions: [syntheticHeld(NOW)] })), 'catalyst_hold')).toHaveLength(1);
    const f = only(checkPositions(makeCtx(NOW, { catalysts: [{ ...cpi, impliedMovePct: null, impliedMoveSource: null }], tickets: [ticket], positions: [syntheticHeld(NOW)] })), 'catalyst_hold');
    expect(f[0]!.effect).toBe('none');
    expect(f[0]!.text).toBe('NQ long is open into CPI at 08:30 ET with no implied move on file; fail price is 1.0% away. Unpriced is not safe. Flat before the print, or get the implied move first.');
  });
  it('at ticket time: blocked from the sizing result unless it is the catalyst trade at survivable size', () => {
    const sizing = syntheticSizing({ blocked: true, blockReason: 'synthetic: CPI implied move above room', failDistancePct: 0.74, catalystInWindow: { id: cpi.id, name: 'CPI', impliedMovePct: 1.8 }, worstMove: { pct: 1.8, pts: 486, basis: 'tier1_implied', text: 'synthetic' } });
    const f = only(checkTicket(syntheticDraft(), makeCtx(NOW, { catalysts: [cpi], sizing })), 'catalyst_hold');
    expect(f[0]!.text).toBe("This ticket's window crosses CPI at 08:30 ET: implied move ±1.8%, fail price 0.7% away. Blocked as a hold. Time-stop it before the print, or make it the catalyst trade at survivable size (8 contracts).");
    const asCatalystTrade = syntheticDraft({ reason: { kind: 'catalyst', catalystId: cpi.id } });
    const ok = { ...sizing, blocked: false, blockReason: null };
    expect(only(checkTicket(asCatalystTrade, makeCtx(NOW, { catalysts: [cpi], sizing: ok })), 'catalyst_hold')).toHaveLength(0);
    const over = only(checkTicket({ ...asCatalystTrade, units: 12 }, makeCtx(NOW, { catalysts: [cpi], sizing: ok })), 'catalyst_hold');
    expect(over[0]!.text).toBe("This is the CPI trade, but 12 contracts is over the survivable 8 contracts. Blocked at that size. Take the engine's number or lower.");
    expect(only(checkTicket(syntheticDraft(), makeCtx(NOW, { catalysts: [cpi], sizing: syntheticSizing() })), 'catalyst_hold')).toHaveLength(0);
  });
});

describe('circuit breakers', () => {
  const broke = (id: string, instrument: string, kind: 'size_up' | 'skipped_scale_out' | 'moved_stop', hoursAgo: number) =>
    syntheticTicket(NOW, { id, instrument, overrides: [{ ts: iso(NOW - hoursAgo * HOUR), kind, reason: 'synthetic', pnlImpactUsd: null }] });
  const three = [broke('tk_a', 'NQ', 'size_up', 4), broke('tk_b', 'NQ', 'skipped_scale_out', 2), broke('tk_c', 'NVDA', 'moved_stop', 1)];

  it('three plan-breaking trades in a day: read-only with the reason; two, or three spread over two days, do not', () => {
    const f = only(checkSession(makeCtx(NOW, { tickets: three })), 'circuit_breaker');
    expect(f[0]!.effect).toBe('read_only');
    expect(f[0]!.blocks).toBe(true);
    expect(f[0]!.text).toBe('Three plan-breaking trades today: NQ size up, NQ skipped scale-out, NVDA moved stop. Overrides are −$6,400 MTD across 7. Desk is read-only for the rest of the session; it reopens tomorrow.');
    expect(only(checkSession(makeCtx(NOW, { tickets: three.slice(0, 2) })), 'circuit_breaker')).toHaveLength(0);
    expect(only(checkSession(makeCtx(NOW, { tickets: [...three.slice(0, 2), broke('tk_c', 'NVDA', 'moved_stop', 30)] })), 'circuit_breaker')).toHaveLength(0);
    // A new ticket while read-only is stopped by the same breaker.
    expect(combineEffects(checkTicket(syntheticDraft(), makeCtx(NOW, { tickets: three }))).effect).toBe('read_only');
  });
  it('counts a trade closed today off-plan, and drops the ledger clause when the ledger is empty', () => {
    const closed = syntheticTicket(NOW, { id: 'tk_d', status: 'closed', closedAt: iso(NOW - HOUR), result: { pnlUsd: -300, exitPrice: 26940, adherence: 70, deductions: [{ kind: 'held_through_invalidation', points: 30 }], mfeAfterExitPct: null, maeAfterExitPct: null, capturePct: null, followedPlan: false } });
    const f = only(checkSession(makeCtx(NOW, { tickets: [...three.slice(0, 2), closed], ledger: EMPTY_LEDGER })), 'circuit_breaker');
    expect(f[0]!.text).toBe('Three plan-breaking trades today: NQ size up, NQ skipped scale-out, NQ held through invalidation. Desk is read-only for the rest of the session; it reopens tomorrow.');
  });
  it('claim prompt: +34% session on Vest, with the next catalyst when one is scheduled; not at +20%, not on a prop account', () => {
    const cpi = syntheticCatalyst(et(2026, 11, 19, 8, 30));
    const f = only(checkSession(makeCtx(NOW, { catalysts: [cpi], accountStates: [syntheticState(NOW, { dayPnl: 1700 })] })), 'claim_prompt');
    expect(f[0]!.text).toBe('vest-instant is up +34% this session (+$1,700). Next catalyst is CPI at 08:30 ET, 19h out. Claim before it.');
    const bare = only(checkSession(makeCtx(NOW, { accountStates: [syntheticState(NOW, { dayPnl: 1700 })] })), 'claim_prompt');
    expect(bare[0]!.text).toBe('vest-instant is up +34% this session (+$1,700). Claim before the next catalyst.');
    expect(only(checkSession(makeCtx(NOW, { accountStates: [syntheticState(NOW, { dayPnl: 1000 })] })), 'claim_prompt')).toHaveLength(0);
    expect(only(checkSession(makeCtx(NOW, { accountStates: [syntheticState(NOW, { accountId: 'apex-50k', dayPnl: 1700 })] })), 'claim_prompt')).toHaveLength(0);
  });
  it('re-entry cooldown words the timer it is given; a cleared or expired timer does not block', () => {
    const cd = { instrument: 'NQ', direction: 'long' as const, stoppedAt: iso(NOW - 6 * 60_000), until: iso(NOW + 9 * 60_000), cleared: false };
    const f = only(checkTicket(syntheticDraft(), makeCtx(NOW, { reentry: [cd] })), 'reentry_cooldown');
    expect(f[0]!.text).toBe('Stopped out of NQ long 6 minutes ago. Same instrument, same direction reopens in 9 minutes. Sooner only with a new catalyst or a new structure confirmation.');
    expect(f[0]!.effect).toBe('block');
    expect(only(checkTicket(syntheticDraft(), makeCtx(NOW, { reentry: [{ ...cd, cleared: true }] })), 'reentry_cooldown')).toHaveLength(0);
    expect(only(checkTicket(syntheticDraft(), makeCtx(NOW + 10 * 60_000, { reentry: [cd] })), 'reentry_cooldown')).toHaveLength(0);
    expect(only(checkTicket(syntheticDraft({ direction: 'short' }), makeCtx(NOW, { reentry: [cd] })), 'reentry_cooldown')).toHaveLength(0);
  });
});

describe('late_night_idea in chat', () => {
  it('asks once for a trade idea at night, ignores a lookup, and is silent by day', () => {
    const night = et(2026, 11, 18, 0, 40);
    const f = only(checkChat('full port gold on RSI?', makeCtx(night)), 'late_night_idea');
    expect(f[0]!.text).toBe("It's 00:40 and this GC idea has no scheduled catalyst inside 12 hours. Name the catalyst, or it saves as a watch.");
    expect(f[0]!.episodeKey).toBe('night:2026-11-17');
    expect(f[0]!.effect).toBe('none');
    expect(only(checkChat('what was CPI last month', makeCtx(night)), 'late_night_idea')).toHaveLength(0);
    expect(only(checkChat('full port gold on RSI?', makeCtx(NOW)), 'late_night_idea')).toHaveLength(0);
    // A chat miss counts: the first ticket that night is already the second miss.
    expect(only(checkTicket(syntheticDraft({ instrument: 'GC' }), makeCtx(night + 60_000, { priorFirings: f })), 'late_night_idea')[0]!.effect).toBe('downgrade_to_watch');
  });
});

describe('once per episode', () => {
  it('a repeat inside the episode is the override-ledger number alone, marked as a repeat, with its effect intact', () => {
    const ticket = syntheticTicket(NOW, { fills: [{ ts: iso(NOW - HOUR), price: 27050, units: 1, kind: 'scale_out', source: 'manual' }] });
    const base = { tickets: [ticket], positions: [syntheticHeld(NOW)] };
    const first = checkChat('should I keep holding it fully', makeCtx(NOW, base)).filter((f) => f.pattern === 'hold_the_winner');
    expect(first[0]!.evidence.repeat).toBe(false);
    const again = checkChat('but what if I hold just the runner', makeCtx(NOW + 5 * 60_000, { ...base, priorFirings: first })).filter((f) => f.pattern === 'hold_the_winner');
    expect(again[0]!.text).toBe('Overrides −$6,400 MTD across 7.');
    expect(again[0]!.evidence.repeat).toBe(true);
    expect(sentences(again[0]!.text)).toHaveLength(1);
    expect(again[0]!.episodeKey).toBe(first[0]!.episodeKey);
    expect(again[0]!.id).not.toBe(first[0]!.id);
    // A different position is a different episode and gets the full statement.
    const other = checkChat('hold?', makeCtx(NOW, { tickets: [ticket], positions: [syntheticHeld(NOW, { id: 'pos_other' })], priorFirings: first })).filter((f) => f.pattern === 'hold_the_winner');
    expect(other[0]!.evidence.repeat).toBe(false);
  });
  it('a repeated block still blocks, and an empty ledger says so instead of printing a number', () => {
    const violation = { accountA: 'vest-eval', accountB: 'vest-instant', instrumentA: 'NQ-PERP', instrumentB: 'NQ-PERP', correlation: -1, clause: 'synthetic clause', text: 'synthetic' };
    const draft = syntheticDraft({ accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short' });
    const first = checkTicket(draft, makeCtx(NOW, { hedgeViolations: [violation], ledger: EMPTY_LEDGER }));
    const again = checkTicket(draft, makeCtx(NOW + 60_000, { hedgeViolations: [violation], ledger: EMPTY_LEDGER, priorFirings: first }));
    expect(again[0]!.text).toBe('No overrides logged this month.');
    expect(again[0]!.effect).toBe('block');
    expect(again[0]!.blocks).toBe(true);
    expect(again[0]!.evidence.repeat).toBe(true);
  });
});

describe('combineEffects', () => {
  const f = (effect: GuardrailFiring['effect'], capUnits?: number): GuardrailFiring => ({ id: `gf_${effect}_${capUnits ?? ''}`, ts: iso(NOW), pattern: 'bottom_call', episodeKey: 'synthetic', text: 'synthetic', blocks: effect === 'block', effect, capUnits, trigger: { kind: 'ticket', ref: 'synthetic' }, evidence: {}, followUp: null });
  it('strongest effect wins: block > read_only > downgrade_to_watch > cap_size > none', () => {
    expect(combineEffects([]).effect).toBe('none');
    expect(combineEffects([f('none'), f('cap_size', 2)]).effect).toBe('cap_size');
    expect(combineEffects([f('cap_size', 2), f('downgrade_to_watch')]).effect).toBe('downgrade_to_watch');
    expect(combineEffects([f('downgrade_to_watch'), f('read_only'), f('cap_size', 2)]).effect).toBe('read_only');
    const all = combineEffects([f('none'), f('cap_size', 4), f('cap_size', 2), f('downgrade_to_watch'), f('read_only'), f('block')]);
    expect(all).toEqual({ effect: 'block', blocks: true, capUnits: 2, decidedBy: ['gf_block_'] });
    expect(combineEffects([f('read_only')]).blocks).toBe(true);
  });
});

describe('fairness', () => {
  it('acknowledges correct reads from journal entries, then plan-followed winners, and says nothing without data', () => {
    const now = et(2026, 11, 18, 14, 0);
    const reads = [
      { ts: iso(et(2026, 11, 6, 10, 0)), instrument: 'NQ', what: 'low', sourceId: 'call_synthetic_1' },
      { ts: iso(et(2026, 11, 17, 18, 0)), instrument: 'NQ', what: 'top tick', sourceId: 'call_synthetic_2' },
    ];
    expect(acknowledgeCorrectRead(makeCtx(now, { correctReads: reads }))).toMatchObject({ text: 'You called the Nov 6 low and the Nov 17 top tick.', refs: ['call_synthetic_1', 'call_synthetic_2'] });
    const winner = syntheticTicket(now, { status: 'closed', closedAt: iso(et(2026, 11, 17, 15, 0)), result: { pnlUsd: 1240, exitPrice: 27130, adherence: 100, deductions: [], mfeAfterExitPct: 0.2, maeAfterExitPct: -0.9, capturePct: 61, followedPlan: true } });
    expect(acknowledgeCorrectRead(makeCtx(now, { tickets: [winner] }))?.text).toBe('Plan followed on the Nov 17 NQ long: +$1,240, 61% of the move captured.');
    expect(acknowledgeCorrectRead(makeCtx(now, { tickets: [{ ...winner, result: { ...winner.result!, followedPlan: false } }] }))).toBeNull();
    expect(acknowledgeCorrectRead(makeCtx(now, { correctReads: [{ ...reads[0]!, ts: iso(et(2026, 9, 1, 10, 0)) }] }))).toBeNull();
    expect(acknowledgeCorrectRead(makeCtx(now))).toBeNull();
  });
});

describe('learning loop', () => {
  const firing = (pattern: GuardrailPattern, ts: number, n: number): GuardrailFiring => ({ id: `gf_${pattern}_${n}`, ts: iso(ts), pattern, episodeKey: `synthetic:${n}`, text: 'synthetic', blocks: false, effect: 'none', trigger: { kind: 'chat', ref: 'synthetic' }, evidence: { repeat: false }, followUp: null });
  const now = et(2026, 11, 21, 12, 0);

  it('recordFollowUp is pure and the verdicts follow the sign of the outcome', () => {
    const f = firing('size_creep', now, 1);
    const done = recordFollowUp(f, 'complied', 800);
    expect(f.followUp).toBeNull();
    expect(done.followUp).toEqual({ action: 'complied', outcomeUsd: 800 });
    expect(verdict(done)).toBe('saved');
    expect(verdict(recordFollowUp(f, 'overrode', -1200))).toBe('cost');
    expect(verdict(recordFollowUp(f, 'overrode', 300))).toBe('nothing');
    expect(verdict(recordFollowUp(f, 'ignored', 0))).toBe('nothing');
    expect(verdict(f)).toBe('pending');
  });

  it('scorecard: fired / complied / overrode / saved / cost per pattern, and retires a guardrail that fired on nothing three months running', () => {
    const firings = [
      recordFollowUp(firing('size_creep', et(2026, 11, 3), 1), 'complied', 800),
      recordFollowUp(firing('size_creep', et(2026, 11, 10), 2), 'overrode', -1200),
      recordFollowUp(firing('size_creep', et(2026, 11, 12), 3), 'ignored', 0),
      firing('size_creep', et(2026, 11, 20), 4),
      { ...recordFollowUp(firing('size_creep', et(2026, 11, 20), 5), 'ignored', 0), evidence: { repeat: true } },
      ...[8, 9, 10].map((m, i) => recordFollowUp(firing('squeeze_as_strength', et(2026, m, 15), i), 'ignored', 0)),
      // liquidity_run: nothing in Aug and Oct, but it saved money in Sep, so the run is broken.
      recordFollowUp(firing('liquidity_run', et(2026, 8, 15), 1), 'overrode', 200),
      recordFollowUp(firing('liquidity_run', et(2026, 9, 15), 2), 'complied', 500),
      recordFollowUp(firing('liquidity_run', et(2026, 10, 15), 3), 'ignored', 0),
    ];
    const rows = scorecard(firings, now);
    expect(rows.map((r) => r.pattern)).toEqual(GuardrailPattern.options);
    const row = (p: GuardrailPattern) => rows.find((r) => r.pattern === p)!;
    expect(row('size_creep')).toMatchObject({ fired: 4, complied: 1, overrode: 1, ignored: 1, pending: 1, savedUsd: 800, costUsd: 1200, firedOnNothing: 1, retired: false });
    expect(row('squeeze_as_strength')).toMatchObject({ fired: 3, firedOnNothing: 3, retired: true });
    expect(row('liquidity_run').retired).toBe(false);
    // Never fired is not "fired on nothing".
    expect(row('bottom_call')).toMatchObject({ fired: 0, retired: false });
    const proposals = tuneThresholds(rows);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ pattern: 'squeeze_as_strength', change: 'retire', requiresApproval: true });
    expect(proposals[0]!.reason).toContain('2026-08, 2026-09, 2026-10');
  });

  it('tuneThresholds proposes, with reasons, and never mutates the thresholds', () => {
    const noisy = [1, 2, 3, 4, 5].map((n) => recordFollowUp(firing('size_creep', et(2026, 11, n + 1), n), n === 1 ? 'complied' : 'overrode', n === 1 ? 400 : 250));
    const costly = [1, 2, 3, 4].map((n) => recordFollowUp(firing('bottom_call', et(2026, 11, n + 1), n), 'overrode', -900));
    const before = structuredClone(DEFAULT_THRESHOLDS);
    const proposals = tuneThresholds(scorecard([...noisy, ...costly], now), DEFAULT_THRESHOLDS);
    expect(DEFAULT_THRESHOLDS).toEqual(before);
    expect(proposals).toEqual([
      expect.objectContaining({ pattern: 'bottom_call', change: 'tighten', key: 'bottomCallWindowHours', from: 24, to: 29 }),
      expect.objectContaining({ pattern: 'size_creep', change: 'loosen', key: 'sizeCreepMultiple', from: 1.5, to: 1.8 }),
    ]);
    expect(proposals[0]!.reason).toBe('Overridden or ignored 4 times at a cost of $3,600 against $0 saved. Flag earlier: bottomCallWindowHours 24 to 29.');
    expect(proposals[1]!.reason).toBe('4 of 5 resolved firings fired on nothing (saved $400, cost $0). Fire less often: sizeCreepMultiple 1.5 to 1.8.');
    // Too few resolved firings: no proposal.
    expect(tuneThresholds(scorecard(costly.slice(0, 3), now))).toEqual([]);
  });
});

describe('voice lint', () => {
  it('rejects banned phrases, a fourth sentence, long text, a second paragraph and moralizing', () => {
    expect(lintVoice('Flush was 19h ago. Confirmation day has not printed. Quarter size until it does.', PROFILE.voice.banned)).toEqual([]);
    expect(lintVoice('You may want to consider a smaller size.', PROFILE.voice.banned)).toEqual(['banned phrase: "consider"', 'banned phrase: "you may want to"']);
    expect(lintVoice('Perhaps wait.', PROFILE.voice.banned)).toEqual(['banned phrase: "perhaps"']);
    expect(lintVoice('One. Two. Three. Four.')).toEqual(['4 sentences, max 3']);
    expect(lintVoice(`${'x'.repeat(321)}`)).toEqual(['321 characters, max 320']);
    expect(lintVoice('One.\n\nTwo.')).toContain('more than one paragraph');
    expect(lintVoice('You always do this.')).toEqual(['moralizing or sarcastic: "you always"']);
    expect(lintVoice('')).toContain('empty');
  });
  it('counts sentences without splitting decimals, clock times or abbreviations', () => {
    expect(sentences('Buy stops 1.2% up, fail price 1.0% down. Order of arrival decides.')).toHaveLength(2);
    expect(sentences('Clause: "Vest: coordinating accounts incl. opposite positions is prohibited". One direction.')).toHaveLength(2);
    expect(sentences('Next is CPI at 08:30 ET, 19h out. Claim before it.')).toHaveLength(2);
  });
  it('every template passes the lint, and no template carries a number that is not in its context', () => {
    const patterns = new Set(SEEN.map((f) => f.pattern));
    // The acceptance file covers size_creep and cross_account_offset; add them here so all 15 patterns are linted.
    const perp = syntheticDraft({ accountId: 'vest-instant', instrument: 'NQ-PERP', units: 21_000 });
    const creep = checkTicket(perp, makeCtx(NOW, { medianNotional20: 10_000, accountStates: [syntheticState(NOW, { dayPnl: 2250 })] }));
    const sized = checkTicket(perp, makeCtx(NOW, { medianNotional20: 10_000, accountStates: [syntheticState(NOW, { dayPnl: 2250 })], sizing: syntheticSizing({ accountId: 'vest-instant', instrument: 'NQ-PERP', maxUnits: 12_000, notionalUsd: 12_000 }) }));
    expect(creep[0]!.text).toBe('Size is 2.1x your 20-trade median after a +45% day. No survivable size is attached to this ticket yet. Run it through the sizing engine before it saves.');
    const offset = checkTicket(syntheticDraft({ accountId: 'vest-eval', instrument: 'NQ-PERP', direction: 'short' }), makeCtx(NOW, {
      accountRules: [{ id: 'vest-eval', firm: 'Vest', claimPromptGainPct: 30 }],
      hedgeViolations: [{ accountA: 'vest-instant', accountB: 'vest-eval', instrumentA: 'NQ-PERP', instrumentB: 'NQ-PERP', correlation: -1, clause: 'Coordinating accounts incl. opposite positions is prohibited. Accounts found doing so are closed and payouts voided, with no appeal and no refund of fees.', text: 'synthetic' }],
    }));
    expect(offset[0]!.text).toContain('Vest: "Coordinating accounts incl. opposite positions is prohibited".');
    const all = [...SEEN, ...creep, ...sized, ...offset];
    for (const f of all) patterns.add(f.pattern);
    expect([...patterns].sort()).toEqual([...GuardrailPattern.options].sort());
    expect(all.length).toBeGreaterThan(40);
    for (const f of all) {
      expect(lintVoice(f.text, PROFILE.voice.banned), f.text).toEqual([]);
      expect(inventedNumbers(f), f.text).toEqual([]);
      expect(sentences(f.text).length, f.text).toBeLessThanOrEqual(3);
    }
    // The ledger line that replaces a repeat is held to the same rules.
    expect(lintVoice('Overrides −$6,400 MTD across 7.', PROFILE.voice.banned)).toEqual([]);
    expect(syntheticLedger.instances).toBe(7);
  });
});
