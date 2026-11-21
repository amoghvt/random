import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, fromZoned, iso, type BiasCall, type GuardrailFiring } from '@desk/contracts';
import { countWords, renderBriefText } from './common';
import { extractNumbers } from './numbers';
import { NOW, at, emptyMorning, syntheticAccount, syntheticCall, syntheticCatalyst, syntheticLedger, syntheticMorning, syntheticPosition, syntheticProfile, syntheticQuote, syntheticRates, syntheticTicket } from './fixtures';
import { MORNING_SECTIONS, briefChanged, morningBrief } from './morning';
import { RECAP_SECTIONS, postCloseRecap } from './recap';
import { briefDue, slotTime } from './schedule';
import type { RecapCtx, WeeklyCtx } from './types';
import { commonality, rankReads, readAttrs, weekKey, weeklyMemo, weeklyReview } from './weekly';

const section = (b: ReturnType<typeof morningBrief>, key: string): string[] => b.sections.find((s) => s.key === key)!.lines;

describe('morning brief', () => {
  it('the morning brief has all seven sections in order and is due at 06:30 local', () => {
    const b = morningBrief(syntheticMorning());
    expect(b.sections.map((s) => s.key)).toEqual(['call', 'overnight', 'catalysts', 'positions', 'accounts', 'one_thing', 'reads']);
    expect(b.sections.map((s) => s.key)).toEqual([...MORNING_SECTIONS]);
    expect(b.sections.every((s) => s.lines.length > 0)).toBe(true);
    expect(b.kind).toBe('morning');
    expect(b.forDay).toBe('2026-11-20');

    // ET: 06:29 is early, 06:30 fires, and it fires once.
    const ny = syntheticProfile();
    const slot = fromZoned(2026, 11, 20, 6, 30);
    expect(briefDue('morning', slot - MIN, ny, null)).toBe(false);
    expect(briefDue('morning', slot, ny, null)).toBe(true);
    expect(briefDue('morning', slot + 5 * MIN, ny, slot)).toBe(false);
    expect(briefDue('morning', slot + DAY, ny, slot)).toBe(true);

    // A timezone other than ET: 06:30 in Kolkata is 01:00 UTC.
    const ist = syntheticProfile('Asia/Kolkata');
    expect(iso(slotTime('morning', Date.UTC(2026, 10, 20, 3), ist))).toBe('2026-11-20T01:00:00.000Z');
    expect(briefDue('morning', Date.UTC(2026, 10, 20, 0, 59), ist, null)).toBe(false);
    expect(briefDue('morning', Date.UTC(2026, 10, 20, 1, 0), ist, null)).toBe(true);
    expect(morningBrief(syntheticMorning({ now: Date.UTC(2026, 10, 20, 1, 0), profile: ist })).forDay).toBe('2026-11-20');

    // DST boundaries: the local time holds, the UTC instant moves by an hour.
    const london = syntheticProfile('Europe/London');
    expect(iso(slotTime('morning', Date.UTC(2026, 9, 24, 12), london))).toBe('2026-10-24T05:30:00.000Z');
    expect(iso(slotTime('morning', Date.UTC(2026, 9, 25, 12), london))).toBe('2026-10-25T06:30:00.000Z');
    expect(iso(slotTime('morning', Date.UTC(2027, 2, 13, 15), ny))).toBe('2027-03-13T11:30:00.000Z');
    expect(iso(slotTime('morning', Date.UTC(2027, 2, 14, 15), ny))).toBe('2027-03-14T10:30:00.000Z');
    const springSlot = Date.UTC(2027, 2, 14, 10, 30);
    expect(briefDue('morning', springSlot - MIN, ny, Date.UTC(2027, 2, 13, 11, 30))).toBe(false);
    expect(briefDue('morning', springSlot, ny, Date.UTC(2027, 2, 13, 11, 30))).toBe(true);
    expect(briefDue('morning', springSlot + HOUR, ny, springSlot)).toBe(false);
  });

  it('renders each section from its inputs and cites every source', () => {
    const b = morningBrief(syntheticMorning());
    expect(section(b, 'call')[0]).toBe('NQ intraday: Lean short 0.62, expires 16:00 ET. Facts: 10Y +6 bp to 4.94% overnight; SOX −1.8% while staples +0.4%; bounce stalled under the 50% retrace at 27,110. Kill: 15m close above 27,140.');
    expect(section(b, 'overnight')).toEqual([
      'Asia: N225 50,120 +0.8%, HSI 25,890 −0.5%.',
      'Europe: DAX 23,410 +0.1%, FTSE 9,620 −0.4%.',
      'Rates: 10Y 4.94% −9 bp 1d, 2Y 4.61% +2 bp 1d.',
      'DXY 99.80 +0.2%, oil 61.20 −1.1%, BTC 91,400 +0.5%, VIX 18.40 −2.6%.',
      'NQ 27,062 vs prior close 26,950: +0.42%. No fair-value input; this is the prior close, not fair value.',
    ]);
    expect(section(b, 'catalysts')).toEqual(['08:30 ET CPI (T1): consensus 0.3%, whisper 0.2%, implied move ±1.1% (options). Branch trade: core 0.3 (p 0.45): No edge, stand aside until 09:15.']);
    expect(section(b, 'positions')[0]).toBe('NQ-PERP long on vest-instant: Thin, fail 26,790 is 272 pts (1.01%) away, P&L +$83. Plan today: targets 27,100 (40%), 27,180 (30%), 27,260 (30%); invalidation 26,900; time stop 15:30 ET. CPI (T1) at 08:30 ET is inside the window.');
    expect(section(b, 'accounts')[0]).toContain('apex-50k: balance $51,240, room $2,000, claimable $740. Payout: 3 of 5 qualifying days. Best day $520 is 42% of the cycle; cap is 40%.');
    expect(section(b, 'accounts')[0]).toContain('Inactivity deadline Nov 26 (last trade Nov 19).');
    expect(section(b, 'accounts').at(-1)).toBe('No rule change overnight.');
    expect(section(b, 'one_thing')[0]).toMatch(/^Lean short NQ 0\.62: short on second move after 08:45 ET if the 10Y confirms\. Targets 26,950 \/ 26,880 \/ 26,800\. Invalidation 27,140/);
    expect(section(b, 'reads')).toHaveLength(3);
    expect(section(b, 'reads')[0]).toBe('[3] Synthetic: Fed speaker pushes back on cuts (synthetic wire, 05:12 ET). Why: macro, risk-off for NQ.');
    const labels = b.citations.map((c) => c.label);
    for (const l of ['call NQ intraday', 'N225', '10Y', '2Y', 'DXY', 'CL', 'BTC', 'VIX', 'NQ', 'catalyst CPI', 'matrix CPI', 'position NQ-PERP vest-instant', 'account apex-50k', 'headline h1']) expect(labels).toContain(l);
    expect(b.citations.every((c) => c.source.length > 0 && !Number.isNaN(Date.parse(c.asOf)))).toBe(true);
    expect(b.wordCount).toBe(countWords(renderBriefText(b)));
  });

  it('uses fair value when supplied, lists held notifications and rule changes', () => {
    const b = morningBrief(syntheticMorning({
      nqFairValue: { key: 'NQ.fair', value: 27040, source: 'synthetic fair value', asOf: iso(NOW - MIN), cadenceSec: 60 },
      heldOvernight: [{ id: 'n1', class: 'P1', reason: 'bias_strong', instrument: 'NQ', lines: ['Synthetic held line.'], deepLink: '/now', dedupeKey: 'k', ts: at(2, 0), decision: 'suppressed', suppressedBy: 'quiet_hours', channels: ['feed'], tappedAt: null }],
      ruleDiffs: [{ id: 'rd1', accountIds: ['apex-50k'], firm: 'Synthetic Firm', url: 'synthetic://rules', detectedAt: at(3, 0), summary: 'Synthetic: consistency cap text changed', added: [], removed: [] }],
    }));
    expect(section(b, 'overnight')).toContain('NQ 27,062 vs fair value 27,040: +22 pts (+0.08%).');
    expect(section(b, 'overnight').at(-1)).toBe('Held overnight (P1, 02:00 ET): Synthetic held line.');
    expect(section(b, 'accounts').at(-1)).toBe('Rule change, Synthetic Firm (apex-50k): Synthetic: consistency cap text changed. Detected 03:00 ET.');
    expect(section(b, 'accounts')).not.toContain('No rule change overnight.');
  });

  it('shows stale and missing inputs as stale or "no data", never smoothed over', () => {
    const ctx = syntheticMorning();
    const quotes = { ...ctx.quotes, VIX: syntheticQuote('VIX', 18.4, 18.9, iso(NOW - 3 * HOUR)), NQ: syntheticQuote('NQ', 27062, 26950, iso(NOW - 20 * MIN)) };
    delete (quotes as Record<string, unknown>).DXY;
    delete (quotes as Record<string, unknown>).N225;
    delete (quotes as Record<string, unknown>).HSI;
    const stale10 = { value: 4.94, asOf: iso(NOW - 3 * HOUR), source: 'synthetic rates', stale: true, age: '3h' };
    const noValue = { value: null, asOf: null, source: null, stale: true, age: null };
    const b = morningBrief({ ...ctx, quotes, rates: syntheticRates({ y10: stale10, y2: noValue }), positions: [syntheticPosition(iso(NOW - 12 * MIN))] });
    const o = section(b, 'overnight');
    expect(o[0]).toMatch(/^Europe:/); // the Asia line is omitted cleanly
    expect(o).toContain('Rates: 10Y 4.94% −9 bp 1d (3h old), 2Y no data.');
    expect(o).toContain('DXY no data, oil 61.20 −1.1%, BTC 91,400 +0.5%, VIX 18.40 −2.6% (3h old).');
    expect(o.at(-1)).toMatch(/^NQ 27,062 \(20m old\) vs prior close/);
    expect(section(b, 'positions')[0]).toContain('P&L +$83 (12m old)');
    expect(b.citations.find((c) => c.label === '10Y')!.asOf).toBe(iso(NOW - 3 * HOUR));
    expect(b.citations.some((c) => c.label === 'DXY')).toBe(false);

    const staleFactor = syntheticCall({ factors: [{ factor: 'rates', score: -1, weight: 0.2, evidence: 'synthetic', asOf: at(1, 0), stale: true }] });
    expect(section(morningBrief({ ...ctx, calls: [staleFactor] }), 'call')[0]).toMatch(/Stale inputs: rates\.$/);
    expect(section(morningBrief({ ...ctx, positions: [{ ...syntheticPosition(), status: null, ticket: null }] }), 'positions')[0]).toBe('NQ-PERP long on vest-instant: status: no data. No ticket attached: no plan on file.');
  });

  it('empty state: every section says so in one dry line', () => {
    const b = morningBrief(emptyMorning());
    expect(b.sections.map((s) => s.key)).toEqual([...MORNING_SECTIONS]);
    expect(section(b, 'call')).toEqual(['No calls on file.']);
    expect(section(b, 'overnight')).toEqual(['Rates: 10Y no data, 2Y no data.', 'DXY no data, oil no data, BTC no data, VIX no data.', 'NQ futures: no data.']);
    expect(section(b, 'catalysts')).toEqual(['No catalysts today.']);
    expect(section(b, 'positions')).toEqual(['No open positions, no live tickets.']);
    expect(section(b, 'accounts')).toEqual(['No active accounts on file.', 'No rule change overnight.']);
    expect(section(b, 'one_thing')).toEqual(['No edge. No catalyst on the calendar today.']);
    expect(section(b, 'reads')).toEqual(['No headlines worth two minutes.']);
    expect(b.citations).toEqual([]);
    expect(extractNumbers(renderBriefText(b))).toEqual([]);
  });

  it('the one thing is "No edge until [catalyst]" when no live call carries a trade', () => {
    const noEdge = syntheticCall({ call: 'no_edge', probability: 0.5, trade: null });
    expect(section(morningBrief(syntheticMorning({ calls: [noEdge] })), 'one_thing')).toEqual(['No edge until CPI at 08:30 ET.']);
    expect(section(morningBrief(syntheticMorning({ calls: [noEdge], catalysts: [] })), 'one_thing')).toEqual(['No edge until CPI at 08:30 ET.']); // from the call's next catalyst
    expect(section(morningBrief(syntheticMorning({ calls: [{ ...noEdge, nextCatalyst: null }], catalysts: [] })), 'one_thing')).toEqual(['No edge. No catalyst on the calendar today.']);
  });

  it('briefChanged: only a call, a consensus, a position status or a rule replaces the brief', () => {
    const base = syntheticMorning();
    const first = morningBrief(base);
    expect(briefChanged(null, first)).toBe(true);
    // 08:00 ET: prices and ages moved, nothing material did.
    const later = { ...base, now: NOW + 90 * MIN, quotes: { ...base.quotes, NQ: syntheticQuote('NQ', 27101, 26950, iso(NOW + 89 * MIN)) } };
    const same = morningBrief(later);
    expect(renderBriefText(same)).not.toBe(renderBriefText(first));
    expect(briefChanged(first, same)).toBe(false);
    expect(briefChanged(first, morningBrief({ ...later, calls: [syntheticCall({ id: 'call_syn_2', call: 'strong_short', probability: 0.71 })] }))).toBe(true);
    expect(briefChanged(first, morningBrief({ ...later, catalysts: [syntheticCatalyst({ consensus: 0.4 })] }))).toBe(true);
    const critical = syntheticPosition();
    expect(briefChanged(first, morningBrief({ ...later, positions: [{ ...critical, status: { ...critical.status!, status: 'Critical' } }] }))).toBe(true);
    expect(briefChanged(first, morningBrief({ ...later, ruleDiffs: [{ id: 'rd1', accountIds: [], firm: 'Synthetic Firm', url: 'synthetic://rules', detectedAt: at(7, 0), summary: 'synthetic change', added: [], removed: [] }] }))).toBe(true);
    expect(briefChanged(first, morningBrief({ ...later, now: NOW + DAY }))).toBe(true);
  });
});

const CLOSE = fromZoned(2026, 11, 20, 16, 30);
const closed = (id: string, adherence: number, overrides = 0) => syntheticTicket({
  id, status: 'closed', closedAt: at(15, 0),
  overrides: Array.from({ length: overrides }, () => ({ ts: at(14, 0), kind: 'moved_stop' as const, reason: 'synthetic', pnlImpactUsd: -100 })),
  result: { pnlUsd: 200, exitPrice: 27100, adherence, deductions: [], mfeAfterExitPct: 0.2, maeAfterExitPct: -0.1, capturePct: 60, followedPlan: overrides === 0 },
});
const recapCtx = (over: Partial<RecapCtx> = {}): RecapCtx => ({
  now: CLOSE, profile: syntheticProfile(), calls: [syntheticCall({ outcome: { resolvedAt: at(16, 0), movePct: -1.12, correct: true } })],
  quotes: { NQ: syntheticQuote('NQ', 26760, 27062, iso(CLOSE - MIN)) }, resolved: [syntheticCatalyst({ status: 'resolved', resolution: { actual: 0.4, branchId: 'b_hot', resolvedAt: at(8, 30) } })],
  closedTickets: [closed('t1', 90), closed('t2', 70, 1)], ledger: syntheticLedger, journalAsOf: iso(CLOSE), tomorrow: [syntheticCatalyst({ id: 'cat_pce', name: 'PCE', code: 'PCE', scheduledAt: at(8, 30, 21), consensus: 0.2 })], ...over,
});

describe('post-close recap', () => {
  it('says what the call was, what happened, whether it was right, adherence, the ledger and tomorrow', () => {
    const b = postCloseRecap(recapCtx());
    expect(b.sections.map((s) => s.key)).toEqual([...RECAP_SECTIONS]);
    expect(b.sections.map((s) => s.lines)).toEqual([
      ['NQ intraday: Lean short 0.62 at 06:00 ET.'],
      ['NQ 26,760, −1.12% on the day.', 'CPI: 0.4% vs consensus 0.3%.'],
      ['NQ intraday: right, −1.12% over the call.'],
      ['80 over 2 closed trades.', 'Lowest: NQ-PERP long at 70.'],
      ['−$1,240 month to date over 5 overrides; 1 today.', 'Plan capture 68% vs override capture 41%.'],
      ['Nov 21 08:30 ET PCE (T1), consensus 0.2%.'],
    ]);
  });

  it('the recap is under 200 words', () => {
    const longName = Array.from({ length: 3 }, () => 'Synthetic catalyst with a very long descriptive name that goes on for quite a number of words indeed').join(' ');
    const calls: BiasCall[] = Array.from({ length: 14 }, (_, i) => syntheticCall({ id: `c${i}`, instrument: i === 0 ? 'NQ' : `SYN${i}`, outcome: { resolvedAt: at(16, 0), movePct: -1 - i / 10, correct: i % 2 === 0 } }));
    const many = Array.from({ length: 12 }, (_, i) => syntheticCatalyst({ id: `x${i}`, name: `${longName} ${i}`, tier: i === 0 ? 1 : 2, scheduledAt: at(8 + (i % 8), 30, 21) }));
    const big = recapCtx({ calls, resolved: many.map((c) => ({ ...c, status: 'resolved' as const, resolution: { actual: 0.4, branchId: null, resolvedAt: at(9, 0) } })), tomorrow: many, closedTickets: Array.from({ length: 9 }, (_, i) => closed(`t${i}`, 50 + i, 2)) });
    const b = postCloseRecap(big);
    expect(countWords(renderBriefText(b))).toBeLessThan(200);
    expect(b.wordCount).toBeLessThan(200);
    // Trimming removes the lowest-priority lines first; every section keeps its lead line.
    expect(b.sections.map((s) => s.key)).toEqual([...RECAP_SECTIONS]);
    expect(b.sections.every((s) => s.lines.length >= 1)).toBe(true);
    expect(b.sections[0]!.lines[0]).toBe('NQ intraday: Lean short 0.62 at 06:00 ET.');
    expect(b.sections[2]!.lines[0]).toBe('NQ intraday: right, −1.00% over the call.');
    expect(b.sections[5]!.lines[0]).toMatch(/^Nov 21 08:30 ET Synthetic catalyst/);
    expect(b.sections[5]!.lines[0]).toMatch(/…$/);
    // A short day is not trimmed at all.
    expect(postCloseRecap(recapCtx()).sections.flatMap((s) => s.lines)).toHaveLength(9);
  });

  it('empty day: no call, no trades, no ledger, nothing tomorrow', () => {
    const b = postCloseRecap(recapCtx({ calls: [], quotes: {}, resolved: [], closedTickets: [], ledger: null, tomorrow: [] }));
    expect(b.sections.map((s) => s.lines)).toEqual([
      ['No call was made today.'], ['NQ: no data.'], ['Nothing to score.'], ['No closed trades today. No adherence score.'],
      ['Ledger: no data. 0 overrides on today\'s closed trades.'], ['Nothing on the calendar.'],
    ]);
    const open = postCloseRecap(recapCtx({ calls: [syntheticCall(), syntheticCall({ id: 'c2', instrument: 'NVDA', call: 'no_edge', probability: 0.5, outcome: { resolvedAt: at(16, 0), movePct: 0.3, correct: null } })] }));
    expect(open.sections[2]!.lines).toEqual(['NQ intraday: not resolved yet.', 'NVDA intraday: unscored (No edge), +0.30% over the call.']);
  });
});

/** Constructed week: three right calls that share a catalyst type, a dominant factor and a time of day; three wrong ones that share only the instrument. */
const weekCall = (id: string, day: number, h: number, m: number, call: BiasCall['call'], movePct: number, correct: boolean, top: 'rates' | 'structure' | 'news' | 'breadth', ref: string): BiasCall => syntheticCall({
  id, call, createdAt: at(h, m, day), expiresAt: at(16, 0, day), trigger: { kind: 'print', ref }, nextCatalyst: null,
  factors: [{ factor: top, score: 2, weight: 0.3, evidence: 'synthetic', asOf: at(h, m, day), stale: false }, { factor: 'calendar', score: 1, weight: 0.015, evidence: 'synthetic', asOf: at(h, m, day), stale: false }],
  outcome: { resolvedAt: at(16, 0, day), movePct, correct },
});
const SUNDAY = fromZoned(2026, 11, 22, 18, 0);
const weekCatalysts = [syntheticCatalyst({ id: 'cpi_a' }), syntheticCatalyst({ id: 'cpi_b' }), syntheticCatalyst({ id: 'cpi_c' }), syntheticCatalyst({ id: 'nfp', code: 'NFP', name: 'NFP' }), syntheticCatalyst({ id: 'earn', code: 'EARNINGS', name: 'NVDA earnings' })];
const firing = (pattern: GuardrailFiring['pattern'], ts: string): GuardrailFiring => ({ id: `f_${ts}`, ts, pattern, episodeKey: ts, text: 'synthetic', blocks: false, effect: 'none', trigger: { kind: 'chat', ref: 'x' }, evidence: {}, followUp: null });
const weeklyCtx = (over: Partial<WeeklyCtx> = {}): WeeklyCtx => ({
  now: SUNDAY, profile: syntheticProfile(),
  calibration: { buckets: [{ lo: 0.5, hi: 0.55, n: 0, predicted: 0.52, realized: null }, { lo: 0.6, hi: 0.65, n: 24, predicted: 0.62, realized: 0.58 }, { lo: 0.7, hi: 0.75, n: 9, predicted: 0.72, realized: 0.67 }], n: 33, updatedAt: iso(SUNDAY - HOUR), source: 'replay' },
  ledger: syntheticLedger, captureCounts: { plan: 11, override: 5 },
  scorecard: [{ pattern: 'bottom_call', fired: 3, complied: 2, overrode: 1, savedUsd: 400, costUsd: 250, retired: false }, { pattern: 'size_creep', fired: 0, complied: 0, overrode: 0, savedUsd: 0, costUsd: 0, retired: false }],
  calls: [
    weekCall('b1', 16, 9, 45, 'lean_short', -1.4, true, 'rates', 'cpi_a'), weekCall('b2', 17, 10, 5, 'lean_long', 0.9, true, 'rates', 'cpi_b'), weekCall('b3', 18, 10, 30, 'strong_short', -2.1, true, 'rates', 'cpi_c'),
    weekCall('w1', 16, 7, 0, 'lean_long', -1.6, false, 'structure', 'nfp'), weekCall('w2', 18, 12, 0, 'lean_short', 0.7, false, 'news', 'earn'), weekCall('w3', 19, 15, 0, 'lean_long', -0.4, false, 'breadth', 'none'),
    weekCall('small', 19, 9, 40, 'lean_long', 0.1, true, 'news', 'none'),
  ],
  catalysts: weekCatalysts, firings: [], journalAsOf: iso(SUNDAY - HOUR),
  nextWeek: [syntheticCatalyst({ id: 'n1', name: 'PCE', code: 'PCE', scheduledAt: at(8, 30, 25) }), syntheticCatalyst({ id: 'n2', name: 'Claims', code: 'CLAIMS', tier: 2, scheduledAt: at(8, 30, 26) })],
  ...over,
});

describe('weekly review', () => {
  it('weekly commonality on a constructed set: names what the reads share, and says so when they share nothing', () => {
    const ctx = weeklyCtx();
    const { best, worst } = rankReads(ctx.calls);
    expect(best.map((c) => c.id)).toEqual(['b3', 'b1', 'b2']); // 2.1, 1.4, 0.9 in the call's direction; the +0.1 call does not make the cut
    expect(worst.map((c) => c.id)).toEqual(['w1', 'w2', 'w3']);
    const attrs = (cs: BiasCall[]) => cs.map((c) => readAttrs(c, ctx.catalysts, ctx.firings));
    expect(attrs(best)[0]).toMatchObject({ catalystType: 'CPI', dominantFactor: 'rates', timeOfDay: 'open', guardrails: [] });
    expect(commonality(attrs(best)).text).toBe('In common, 3 of 3: same catalyst type (CPI); rates dominated each; same time of day (open).');
    expect(commonality(attrs(worst))).toMatchObject({ themes: [], text: 'Nothing in common beyond the instrument (NQ) and the horizon (intraday).' });

    const b = weeklyReview(ctx);
    expect(b.sections.map((s) => s.key)).toEqual(['calibration', 'capture', 'guardrails', 'best', 'worst', 'next_week']);
    const lines = (k: string): string[] => b.sections.find((s) => s.key === k)!.lines;
    expect(lines('best')).toEqual([
      'Wed Nov 18 10:30 ET NQ Strong short 0.62: −2.10% move, right. [CPI, rates led, open, no guardrail]',
      'Mon Nov 16 09:45 ET NQ Lean short 0.62: −1.40% move, right. [CPI, rates led, open, no guardrail]',
      'Tue Nov 17 10:05 ET NQ Lean long 0.62: +0.90% move, right. [CPI, rates led, open, no guardrail]',
      'In common, 3 of 3: same catalyst type (CPI); rates dominated each; same time of day (open).',
    ]);
    expect(lines('worst').at(-1)).toBe('Nothing in common beyond the instrument (NQ) and the horizon (intraday).');

    // The same guardrail firing inside each losing call's window becomes the shared theme.
    const fired = weeklyCtx({ firings: [firing('bottom_call', at(8, 0, 16)), firing('bottom_call', at(13, 0, 18)), firing('bottom_call', at(15, 30, 19)), firing('size_creep', at(15, 31, 19))] });
    expect(commonality(rankReads(fired.calls).worst.map((c) => readAttrs(c, fired.catalysts, fired.firings))).text).toBe('In common, 3 of 3: same guardrail fired (bottom_call).');
    expect(commonality([]).text).toBe('Nothing to compare.');
    expect(commonality(attrs(best).slice(0, 1)).text).toBe('One read; nothing to compare it with.');
  });

  it('renders calibration rows with counts, capture, the scorecard and next week with Tier-1 windows blocked', () => {
    const b = weeklyReview(weeklyCtx());
    const lines = (k: string): string[] => b.sections.find((s) => s.key === k)!.lines;
    expect(b.sections[0]!.title).toBe('Calibration (n=33)');
    expect(lines('calibration')).toEqual(['0.60 to 0.65: predicted 0.62, realized 0.58, n=24', '0.70 to 0.75: predicted 0.72, realized 0.67, n=9']);
    expect(lines('capture')).toEqual(['Plan capture 68% (n=11) vs override capture 41% (n=5).', 'Override ledger: −$1,240 month to date over 5 overrides.']);
    expect(lines('guardrails')).toEqual(['bottom_call: fired 3, complied 2, overrode 1, saved $400, cost $250']);
    expect(lines('next_week')).toEqual(['Wed Nov 25 08:30 ET PCE (T1). BLOCKED 07:30 to 09:15 ET.', 'Thu Nov 26 08:30 ET Claims (T2).']);
    expect(b.citations.map((c) => c.label)).toEqual(expect.arrayContaining(['calibration', 'override ledger', 'guardrail scorecard', 'catalyst PCE']));
    expect(b.forDay).toBe('2026-11-22');
  });

  it('empty week: each section says so in one line', () => {
    const b = weeklyReview(weeklyCtx({ calibration: { buckets: [], n: 0, updatedAt: null, source: 'live' }, ledger: null, scorecard: [], calls: [], nextWeek: [] }));
    expect(b.sections.map((s) => s.lines)).toEqual([
      ['No scored calls yet. No calibration to show.'], ['Capture: no data.'], ['No guardrail fired this week.'],
      ['No right calls scored this week.'], ['No wrong calls scored this week.'], ['Nothing on next week\'s calendar.'],
    ]);
  });

  it('the weekly memo is a proposal: evidence in the text, approved false', () => {
    const memo = weeklyMemo(weeklyCtx({ weightChanges: [{ factor: 'rates', from: 0.2, to: 0.22, evidence: 'rates-led calls 3 of 3 right' }] }));
    expect(memo.approved).toBe(false);
    expect(memo.week).toBe('2026-11-16');
    expect(weekKey(fromZoned(2026, 11, 16, 0, 5), 'America/New_York')).toBe('2026-11-16');
    expect(memo.text.split('\n')).toEqual([
      'Week of 2026-11-16. 7 scored calls.',
      'Edges confirmed: CPI calls 3 of 3 right; rates-led calls 3 of 3 right; open calls 4 of 4 right; following the plan captured 68% vs 41% on overrides.',
      'Patterns observed: bottom_call fired 3, overrode 1, cost $250.',
      'Best reads: In common, 3 of 3: same catalyst type (CPI); rates dominated each; same time of day (open). Worst reads: Nothing in common beyond the instrument (NQ) and the horizon (intraday).',
      'Weights adjusted: rates 0.200 to 0.220 (rates-led calls 3 of 3 right).',
      'Evidence: calibration 0.62 predicted, 0.58 realized, n=24; 0.72 predicted, 0.67 realized, n=9 (replay, as of 17:00 ET).',
    ]);
    const quiet = weeklyMemo(weeklyCtx({ calls: [], scorecard: [], ledger: null }));
    expect(quiet.text).toContain('Edges confirmed: none (no group reached 3 calls at 60%).');
    expect(quiet.text).toContain('Weights adjusted: none proposed.');
  });
});

describe('schedule', () => {
  const p = syntheticProfile('America/Los_Angeles');
  it('recap fires once at 16:30 ET on weekdays, whatever the local timezone', () => {
    const slot = fromZoned(2026, 11, 20, 16, 30);
    expect(briefDue('recap', slot - MIN, p, null)).toBe(false);
    expect(briefDue('recap', slot, p, null)).toBe(true);
    expect(briefDue('recap', slot + MIN, p, slot)).toBe(false);
    expect(briefDue('recap', slot + DAY, p, slot)).toBe(false); // Saturday
    expect(briefDue('recap', slot + 3 * DAY, p, slot)).toBe(true); // Monday
  });
  it('the 08:00 ET regeneration check fires once per weekday', () => {
    const slot = fromZoned(2026, 11, 20, 8, 0);
    expect(briefDue('morning_regen', slot - MIN, p, null)).toBe(false);
    expect(briefDue('morning_regen', slot, p, slot - 20 * HOUR)).toBe(true);
    expect(briefDue('morning_regen', slot + 10 * MIN, p, slot)).toBe(false);
  });
  it('weekly fires once at Sunday 18:00 local, across the DST change', () => {
    const slot = fromZoned(2026, 11, 22, 18, 0, 'America/Los_Angeles');
    expect(briefDue('weekly', slot - MIN, p, slot - 7 * DAY)).toBe(false);
    expect(briefDue('weekly', slot, p, slot - 7 * DAY)).toBe(true);
    expect(briefDue('weekly', slot + 2 * DAY, p, slot)).toBe(false);
    expect(briefDue('weekly', slot + 2 * DAY, p, null)).toBe(true); // catches up until the next Sunday
    // 2026-11-01 is the US fall-back Sunday: 18:00 PST is 02:00 UTC Monday, an hour later than the week before.
    expect(iso(slotTime('weekly', Date.UTC(2026, 10, 2, 12), p))).toBe('2026-11-02T02:00:00.000Z');
    expect(iso(slotTime('weekly', Date.UTC(2026, 9, 27, 12), p))).toBe('2026-10-26T01:00:00.000Z');
  });
});

describe('account fixtures', () => {
  it('inactive accounts are left out', () => {
    const a = syntheticAccount();
    const b = morningBrief(syntheticMorning({ accounts: [{ ...a, state: { ...a.state, active: false } }] }));
    expect(section(b, 'accounts')[0]).toBe('No active accounts on file.');
  });
});
