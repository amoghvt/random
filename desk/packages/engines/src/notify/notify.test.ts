import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, Notification, NotificationIntent, fromZoned, iso } from '@desk/contracts';
import type { NotifyClass } from '@desk/contracts';
import {
  LINE_MAX, biasChanged, branchProbabilityShift, briefReady, catalystT60, clearHeld, decide, delivery, dueReminders, emptyNotifyState,
  entryTriggerFired, heldForMorning, impact3Headline, inactivityT24h, noteTaps, payoutEligible, positionCritical, ruleChange,
  setupConfirmed, sweepIgnored, tier1Resolved, ticketInvalidationHit, ticketTimeStopHit, toPushPayload, TradeNotificationError,
  usSessionKey, validateTradeNotification, vestWeekendLockT30, voiceLint, withFlag,
} from './index';
import type { DecideContext, NotifyState } from './index';
import {
  WED_0900, et, syntheticAccount, syntheticAccountState, syntheticBrief, syntheticCall, syntheticCatalyst, syntheticCmeAccount,
  syntheticCritical, syntheticDiff, syntheticHeadline, syntheticIntent, syntheticPlan, syntheticPosition, syntheticProfile,
  syntheticSetup, syntheticTicket,
} from './fixtures.synthetic';

const ctx = (now: number, over: Partial<DecideContext> = {}): DecideContext => ({ now, tz: 'America/New_York', profile: syntheticProfile, ...over });

/** Sends `count` distinct intents `gapMin` apart, tapping each P1 so the ignored-streak rule stays out of the way. */
function run(cls: NotifyClass, count: number, start: number, state: NotifyState, gapMin = 20, offset = 0) {
  const out: Notification[] = [];
  let s = state;
  for (let i = 0; i < count; i++) {
    const now = start + i * gapMin * MIN;
    const d = decide(syntheticIntent(cls, offset + i), s, ctx(now));
    s = cls === 'P1' ? noteTaps(d.state, d.notification.id, now + MIN) : d.state;
    out.push(d.notification);
  }
  return { out, state: s };
}

describe('acceptance', () => {
  it('simulated Tier-1 release produces the branch-trade P0 with a pre-filled ticket', () => {
    const catalyst = syntheticCatalyst();
    // Shaped like the catalyst engine's live-match output: the spec's three-line example plus the matched branch's sized plan.
    const engineOut = {
      lines: ['Core CPI 0.3% vs 0.2%.', 'Branch C: Lean short NQ 0.62, entry on second move after 08:45, T1 27,000.', '10Y +9 bp to 4.95%.'],
      plan: syntheticPlan,
    };
    const intent = tier1Resolved(catalyst, engineOut);
    expect(intent).not.toBeNull();
    const n = intent!;
    expect(NotificationIntent.safeParse(n).success).toBe(true);
    expect(n.class).toBe('P0');
    expect(n.lines).toEqual([
      'Core CPI 0.3% vs 0.2%. Branch: 0.3.',
      'Short NQ-PERP on vest-instant, $40,000 at 8x. Entry: second move after 08:45 ET if the 10Y confirms.',
      'T1 27,000. Invalidation 27,310. Time stop: flat by 10:30 ET.',
    ]);
    expect(validateTradeNotification(n)).toEqual({ ok: true, missing: [] });
    expect(voiceLint(n.lines)).toEqual([]);

    const p = n.ticketPrefill!;
    expect(p).toMatchObject({ instrument: 'NQ-PERP', direction: 'short', accountId: 'vest-instant' });
    expect(p.size).toEqual({ units: 40_000, notionalUsd: 40_000, leverage: 8, failPrice: 27_520 });
    expect(p.entry.text).toBe('second move after 08:45 ET if the 10Y confirms');
    expect(p.targets[0].price).toBe(27_000);
    expect(p.invalidation.price).toBe(27_310);
    expect(p.timeStop.text).toBe('flat by 10:30 ET');
    expect(p.reason).toEqual({ kind: 'catalyst', catalystId: catalyst.id, branchId: 'b_c' });

    const now = Date.parse(catalyst.resolution!.resolvedAt) + 1_000;
    const { notification } = decide(n, emptyNotifyState(), ctx(now));
    expect(Notification.safeParse(notification).success).toBe(true);
    expect(notification.decision).toBe('sent');
    expect(notification.channels).toEqual(['webpush', 'telegram', 'feed']);
    expect(notification.deepLink).toBe(`/ticket?prefill=${notification.id}`);
    expect(delivery(notification, now)).toMatchObject({ sound: true, urgent: true });
    expect(toPushPayload(notification)).toEqual({
      title: n.lines[0], body: `${n.lines[1]}\n${n.lines[2]}`, url: notification.deepLink, tag: 'tier1_resolved:cat_synthetic_core_cpi', class: 'P0',
    });
  });

  it('the P1 budget caps at 8', () => {
    const first = run('P1', 9, WED_0900, emptyNotifyState());
    expect(first.out.slice(0, 8).every((n) => n.decision === 'sent')).toBe(true);
    expect(first.out[8]).toMatchObject({ decision: 'suppressed', suppressedBy: 'p1_budget', channels: ['feed'] });
    expect(first.state.p1).toEqual({ session: '2026-11-18', count: 8 });

    // Still the same session at 17:55 ET; a new one opens at 18:00 ET.
    const late = decide(syntheticIntent('P1', 20), first.state, ctx(et(2026, 11, 18, 17, 55)));
    expect(late.notification.suppressedBy).toBe('p1_budget');
    const next = decide(syntheticIntent('P1', 21), late.state, ctx(et(2026, 11, 18, 18, 5)));
    expect(next.notification.decision).toBe('sent');
    expect(next.state.p1).toEqual({ session: '2026-11-19', count: 1 });
  });

  it('quiet hours hold P1 to P3 and pass P0', () => {
    const now = et(2026, 11, 18, 23, 45);
    let s = emptyNotifyState();
    for (const cls of ['P1', 'P2', 'P3'] as const) {
      const d = decide(syntheticIntent(cls, 1), s, ctx(now));
      expect(d.notification).toMatchObject({ decision: 'suppressed', suppressedBy: 'quiet_hours', channels: ['feed'] });
      s = d.state;
    }
    const p0 = decide(syntheticIntent('P0', 1), s, ctx(now));
    expect(p0.notification.decision).toBe('sent');
    expect(heldForMorning(p0.state).map((n) => n.class)).toEqual(['P1', 'P2', 'P3']);
    // Held intents spent no budget, and a re-offer of a held key is not held twice.
    expect(p0.state.p1.count).toBe(0);
    const again = decide(syntheticIntent('P1', 1), p0.state, ctx(now + MIN));
    expect(again.notification.suppressedBy).toBe('duplicate_key');
    expect(heldForMorning(again.state)).toHaveLength(3);
    expect(heldForMorning(clearHeld(again.state))).toEqual([]);
    // 06:00 local is outside the window.
    expect(decide(syntheticIntent('P2', 2), again.state, ctx(et(2026, 11, 19, 6, 0))).notification.decision).toBe('sent');
    expect(decide(syntheticIntent('P2', 3), again.state, ctx(et(2026, 11, 19, 5, 59))).notification.suppressedBy).toBe('quiet_hours');
  });
});

describe('budgets and suppression', () => {
  it('P0 repeat spacing of 5 minutes', () => {
    const crit = positionCritical(syntheticPosition, syntheticCritical)!;
    const a = decide(crit, emptyNotifyState(), ctx(WED_0900));
    const b = decide(crit, a.state, ctx(WED_0900 + MIN));
    const c = decide(crit, b.state, ctx(WED_0900 + 5 * MIN - 1));
    const d = decide(crit, c.state, ctx(WED_0900 + 5 * MIN));
    expect([a, b, c, d].map((x) => x.notification.suppressedBy)).toEqual([null, 'p0_repeat_5m', 'p0_repeat_5m', null]);
    // Unchanged content still repeats for position-Critical, and a suppressed repeat does not push the clock back.
    expect(d.notification.lines).toEqual(a.notification.lines);
    expect(d.notification.id).not.toBe(a.notification.id);
    // Any other P0 with the same key and unchanged content does not repeat.
    const rule = ruleChange(syntheticDiff);
    const r1 = decide(rule, emptyNotifyState(), ctx(WED_0900));
    expect(decide(rule, r1.state, ctx(WED_0900 + 6 * MIN)).notification.suppressedBy).toBe('duplicate_content');
  });

  it('no P1 within 10 minutes of a P0 on the same instrument', () => {
    const p0 = decide(syntheticIntent('P0', 1, { instrument: 'NQ-PERP' }), emptyNotifyState(), ctx(WED_0900));
    const sameUnderlying = decide(syntheticIntent('P1', 1, { instrument: 'NQ' }), p0.state, ctx(WED_0900 + 9 * MIN));
    expect(sameUnderlying.notification.suppressedBy).toBe('p0_cooldown_10m');
    const other = decide(syntheticIntent('P1', 2, { instrument: 'NVDA' }), sameUnderlying.state, ctx(WED_0900 + 9 * MIN));
    expect(other.notification.decision).toBe('sent');
    const after = decide(syntheticIntent('P1', 3, { instrument: 'NQ' }), other.state, ctx(WED_0900 + 10 * MIN));
    expect(after.notification.decision).toBe('sent');
  });

  it('identical content suppressed', () => {
    const a = decide(syntheticIntent('P1', 1), emptyNotifyState(), ctx(WED_0900));
    const same = syntheticIntent('P2', 99, { lines: ['  synthetic P1   FACT 1', 'Synthetic action.'] });
    const b = decide(same, a.state, ctx(WED_0900 + MIN));
    expect(b.notification).toMatchObject({ decision: 'suppressed', suppressedBy: 'duplicate_content' });
    // A changed number is new content.
    const c = decide(syntheticIntent('P2', 100, { lines: ['Synthetic P1 fact 2.', 'Synthetic action.'] }), b.state, ctx(WED_0900 + 2 * MIN));
    expect(c.notification.decision).toBe('sent');
  });

  it('three ignored P1s drop to P0-only for 2 hours and recover', () => {
    let s = emptyNotifyState();
    for (let i = 0; i < 3; i++) s = decide(syntheticIntent('P1', i), s, ctx(WED_0900 + i * MIN)).state;
    // 14 minutes after the third: its window is still open.
    expect(sweepIgnored(s, WED_0900 + 16 * MIN)).toMatchObject({ journalNotes: [], state: { ignoredP1Streak: 2, p0OnlyUntil: null } });

    const droppedAt = WED_0900 + 2 * MIN + 15 * MIN;
    const swept = sweepIgnored(s, droppedAt);
    expect(swept.state.p0OnlyUntil).toBe(droppedAt + 2 * HOUR);
    expect(swept.journalNotes).toHaveLength(1);
    expect(swept.journalNotes[0]).toMatchObject({ source: 'system', ts: iso(droppedAt), text: '3 P1s in a row went untapped for 15 min. Notifications are P0-only until 11:17 ET.' });

    // decide runs the sweep itself and hands back the note, once.
    const during = decide(syntheticIntent('P1', 10), s, ctx(droppedAt + MIN));
    expect(during.notification.suppressedBy).toBe('p0_only');
    expect(during.journalNotes).toHaveLength(1);
    const p2 = decide(syntheticIntent('P2', 10), during.state, ctx(droppedAt + 30 * MIN));
    expect(p2.notification.suppressedBy).toBe('p0_only');
    expect(p2.journalNotes).toEqual([]);
    expect(decide(syntheticIntent('P0', 10), p2.state, ctx(droppedAt + 31 * MIN)).notification.decision).toBe('sent');

    const lastMinute = decide(syntheticIntent('P1', 11), p2.state, ctx(droppedAt + 2 * HOUR - 1));
    expect(lastMinute.notification.suppressedBy).toBe('p0_only');
    const recovered = decide(syntheticIntent('P1', 12), lastMinute.state, ctx(droppedAt + 2 * HOUR));
    expect(recovered.notification.decision).toBe('sent');
    expect(recovered.state.ignoredP1Streak).toBe(0);
  });

  it('a tap inside 15 minutes breaks the ignored streak', () => {
    let s = emptyNotifyState();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = decide(syntheticIntent('P1', i), s, ctx(WED_0900 + i * MIN));
      s = d.state; ids.push(d.notification.id);
    }
    const tapped = noteTaps(s, ids[2]!, WED_0900 + 10 * MIN);
    expect(sweepIgnored(tapped, WED_0900 + HOUR).state).toMatchObject({ p0OnlyUntil: null, ignoredP1Streak: 0 });
    // lastTapAt from the context counts the same way.
    expect(sweepIgnored(s, WED_0900 + HOUR, WED_0900 + 10 * MIN).state.p0OnlyUntil).toBeNull();
    // A tap after the window does not undo it.
    const late = noteTaps(sweepIgnored(s, WED_0900 + HOUR).state, ids[2]!, WED_0900 + HOUR);
    expect(late.p0OnlyUntil).toBe(WED_0900 + 17 * MIN + 2 * HOUR);
  });

  it('P2 daily cap', () => {
    const first = run('P2', 7, WED_0900, emptyNotifyState());
    expect(first.out.map((n) => n.suppressedBy)).toEqual([null, null, null, null, null, null, 'p2_budget']);
    const sameDay = decide(syntheticIntent('P2', 30), first.state, ctx(et(2026, 11, 18, 23, 0)));
    expect(sameDay.notification.suppressedBy).toBe('p2_budget');
    const nextDay = decide(syntheticIntent('P2', 31), sameDay.state, ctx(et(2026, 11, 19, 6, 30)));
    expect(nextDay.notification.decision).toBe('sent');
    // The profile can lower a cap, never raise it.
    const greedy = { ...syntheticProfile, notifications: { ...syntheticProfile.notifications, p2PerDay: 50 } };
    let s = emptyNotifyState();
    const decisions: Array<string | null> = [];
    for (let i = 0; i < 7; i++) {
      const d = decide(syntheticIntent('P2', i), s, ctx(WED_0900 + i * MIN, { profile: greedy }));
      s = d.state; decisions.push(d.notification.suppressedBy);
    }
    expect(decisions[6]).toBe('p2_budget');
  });

  it('DST-safe quiet hours with a non-ET timezone', () => {
    const tz = 'Europe/Berlin';
    const local = (y: number, m: number, d: number, h: number, min: number): number => fromZoned(y, m, d, h, min, tz);
    const decideAt = (now: number, n: number) => decide(syntheticIntent('P2', n), emptyNotifyState(), ctx(now, { tz })).notification.suppressedBy;
    // Berlin leaves summer time on 25 Oct 2026. 21:45 UTC is 23:45 local the night before and 22:45 local the night after.
    const before = Date.UTC(2026, 9, 24, 21, 45);
    const after = Date.UTC(2026, 9, 25, 21, 45);
    expect(before).toBe(local(2026, 10, 24, 23, 45));
    expect(after).toBe(local(2026, 10, 25, 22, 45));
    expect(decideAt(before, 1)).toBe('quiet_hours');
    expect(decideAt(after, 2)).toBeNull();
    expect(decideAt(local(2026, 10, 25, 23, 30), 3)).toBe('quiet_hours');
    expect(decideAt(local(2026, 10, 25, 23, 29), 4)).toBeNull();
    // The repeated 02:30 on the fall-back night is quiet both times.
    expect(decideAt(Date.UTC(2026, 9, 25, 0, 30), 5)).toBe('quiet_hours');
    expect(decideAt(Date.UTC(2026, 9, 25, 1, 30), 6)).toBe('quiet_hours');
    // Spring forward, 28 Mar 2027: 06:00 local is 04:00 UTC, an hour earlier in UTC than the day before.
    expect(decideAt(local(2027, 3, 28, 5, 59), 7)).toBe('quiet_hours');
    expect(decideAt(local(2027, 3, 28, 6, 0), 8)).toBeNull();
    expect(local(2027, 3, 28, 6, 0)).toBe(Date.UTC(2027, 2, 28, 4, 0));
    // 09:00 ET is 15:00 in Berlin: awake there. 18:00 ET is midnight in Berlin: quiet there, not in ET.
    expect(decideAt(et(2026, 11, 18, 18, 0), 9)).toBe('quiet_hours');
    expect(decide(syntheticIntent('P2', 9), emptyNotifyState(), ctx(et(2026, 11, 18, 18, 0))).notification.decision).toBe('sent');
    // P0 passes in any zone.
    expect(decide(syntheticIntent('P0', 1), emptyNotifyState(), ctx(before, { tz })).notification.decision).toBe('sent');
  });

  it('P3 is scheduled only', () => {
    const adhoc = decide(syntheticIntent('P3', 1, { reason: 'something_else' }), emptyNotifyState(), ctx(WED_0900));
    expect(adhoc.notification.suppressedBy).toBe('unscheduled');
    const brief = decide(briefReady(syntheticBrief('morning')), adhoc.state, ctx(et(2026, 11, 18, 6, 30)));
    expect(brief.notification).toMatchObject({ decision: 'sent', channels: ['webpush', 'feed'] });
    expect(delivery(brief.notification, WED_0900)).toMatchObject({ sound: false, urgent: false });
  });

  it('the kill switch suppresses everything except P0 position-Critical', () => {
    const kill = ctx(WED_0900, { killSwitch: true });
    for (const cls of ['P0', 'P1', 'P2', 'P3'] as const) {
      expect(decide(syntheticIntent(cls, 1), emptyNotifyState(), kill).notification.suppressedBy).toBe('kill_switch');
    }
    const crit = decide(positionCritical(syntheticPosition, syntheticCritical)!, emptyNotifyState(), kill);
    expect(crit.notification.decision).toBe('sent');
  });

  it('sound follows the class: P1 only during US hours', () => {
    const p1 = decide(syntheticIntent('P1', 1), emptyNotifyState(), ctx(WED_0900)).notification;
    expect(delivery(p1, WED_0900)).toEqual({ sound: true, urgent: false, channels: ['webpush', 'feed'] });
    expect(delivery(p1, et(2026, 11, 18, 21, 0)).sound).toBe(false);
    expect(delivery(p1, et(2026, 11, 21, 12, 0)).sound).toBe(false);
    const p2 = decide(syntheticIntent('P2', 1), emptyNotifyState(), ctx(WED_0900)).notification;
    expect(delivery(p2, WED_0900).sound).toBe(false);
    const held = decide(syntheticIntent('P1', 2), emptyNotifyState(), ctx(et(2026, 11, 18, 2, 0))).notification;
    expect(delivery(held, WED_0900)).toEqual({ sound: false, urgent: false, channels: ['feed'] });
  });

  it('the US session key rolls at 18:00 ET across a DST change', () => {
    expect(usSessionKey(et(2026, 11, 18, 17, 59))).toBe('2026-11-18');
    expect(usSessionKey(et(2026, 11, 18, 18, 0))).toBe('2026-11-19');
    expect(usSessionKey(et(2026, 11, 22, 18, 0))).toBe('2026-11-23');
    expect(usSessionKey(et(2027, 3, 14, 17, 59))).toBe('2027-03-14');
    expect(usSessionKey(et(2027, 3, 14, 18, 0))).toBe('2027-03-15');
    expect(usSessionKey(et(2026, 12, 31, 19, 0))).toBe('2027-01-01');
  });

  it('state survives a JSON round trip and decide does not mutate its input', () => {
    const a = decide(syntheticIntent('P1', 1), emptyNotifyState(), ctx(et(2026, 11, 18, 23, 45)));
    const frozen = JSON.stringify(a.state);
    const revived = JSON.parse(frozen) as NotifyState;
    const b = decide(syntheticIntent('P0', 2), revived, ctx(et(2026, 11, 18, 23, 46)));
    expect(JSON.stringify(a.state)).toBe(frozen);
    expect(b.state.log).toHaveLength(2);
    expect(JSON.stringify(revived)).toBe(frozen);
  });
});

describe('builders', () => {
  const catalyst = syntheticCatalyst();
  const upcoming = syntheticCatalyst({ status: 'upcoming', resolution: null });
  const vest = syntheticAccount();
  const cme = syntheticCmeAccount();
  const lockAt = et(2026, 11, 20, 20, 0);
  const all = (): Array<[string, NotificationIntent | null]> => [
    ['positionCritical', positionCritical(syntheticPosition, syntheticCritical)],
    ['tier1Resolved', tier1Resolved(catalyst, { lines: ['Core CPI 0.3% vs 0.2%.', 'Branch C: Lean short NQ 0.62.', '10Y +9 bp to 4.95%.'], plan: syntheticPlan })],
    ['tier1Resolved no-trade', tier1Resolved(catalyst, { lines: ['Core CPI 0.2% vs 0.2%.', 'Branch B: No edge, stand aside until 09:15.'], plan: null })],
    ['tier1Resolved unsized', tier1Resolved(catalyst, { lines: ['Core CPI 0.3% vs 0.2%.', 'Branch C: Lean short NQ 0.62.'], plan: { ...syntheticPlan, size: undefined } })],
    ['ruleChange', ruleChange(syntheticDiff)],
    ['impact3Headline', impact3Headline(syntheticHeadline, syntheticPosition)],
    ['ticketInvalidationHit', ticketInvalidationHit(syntheticTicket, 27_316.25, WED_0900)],
    ['ticketTimeStopHit', ticketTimeStopHit(syntheticTicket)],
    ['biasChanged strong', biasChanged(syntheticCall('lean_short', 0.58, 'c1'), syntheticCall('strong_short', 0.71, 'c2'))],
    ['biasChanged from no edge', biasChanged(syntheticCall('no_edge', 0.5, 'c0'), syntheticCall('lean_long', 0.6, 'c3'))],
    ['entryTriggerFired ticket', entryTriggerFired(syntheticTicket, { price: 27_178.5, now: WED_0900 })],
    ['entryTriggerFired catalyst', entryTriggerFired(catalyst, { price: 27_150, now: WED_0900 })],
    ['setupConfirmed', setupConfirmed(syntheticSetup, syntheticProfile.instruments.watchlist)],
    ['setupConfirmed with plan', setupConfirmed(syntheticSetup, ['NVDA'], { ...syntheticPlan, instrument: 'NVDA', direction: 'long' })],
    ['catalystT60', catalystT60(upcoming, et(2026, 11, 18, 7, 30))],
    ['catalystT60 no matrix', catalystT60({ ...upcoming, matrix: null }, et(2026, 11, 18, 7, 32))],
    ['vestWeekendLockT30', vestWeekendLockT30(vest, lockAt, lockAt - 30 * MIN)],
    ['payoutEligible', payoutEligible(cme, '$1,400 claimable, 2 of 2 qualifying days, best day 44% of the cycle vs 50% limit.', WED_0900)],
    ['inactivityT24h', inactivityT24h(cme, WED_0900 + DAY, WED_0900)],
    ['branchProbabilityShift', branchProbabilityShift(upcoming, upcoming.matrix!.branches[2]!, 40, 56, WED_0900)],
    ['branchProbabilityShift no trade', branchProbabilityShift(upcoming, upcoming.matrix!.branches[1]!, 45, 28, WED_0900)],
    ['briefReady morning', briefReady(syntheticBrief('morning'))],
    ['briefReady recap', briefReady(syntheticBrief('recap'))],
    ['briefReady weekly', briefReady(syntheticBrief('weekly'))],
  ];

  it('voice lint', () => {
    const built = all();
    expect(built).toHaveLength(24);
    for (const [name, n] of built) {
      expect(n, name).not.toBeNull();
      expect(voiceLint(n!.lines), `${name}: ${n!.lines.join(' | ')}`).toEqual([]);
      expect(NotificationIntent.safeParse(n).success, name).toBe(true);
    }
    // Long upstream text is cut to fit the lock screen, not passed through.
    const wordy = impact3Headline({ ...syntheticHeadline, title: `${syntheticHeadline.title} ${'and more detail '.repeat(12)}` }, syntheticPosition)!;
    expect(wordy.lines[0]!.length).toBeLessThanOrEqual(LINE_MAX);
    expect(wordy.lines[0]!.endsWith('…')).toBe(true);
    // The lint itself catches each rule.
    expect(voiceLint(['You may want to consider trimming 1 lot.'])).toHaveLength(2);
    expect(voiceLint(['No number here.'])).toEqual(['line 1 carries no number']);
    expect(voiceLint([`1 ${'x'.repeat(LINE_MAX)}`])).toHaveLength(1);
    expect(voiceLint(['1', '2', '3', '4'])).toHaveLength(1);
  });

  it('classes, deep links and schedule reasons match the priority table', () => {
    const byName = new Map(all());
    const expectLink = (name: string, cls: NotifyClass, link: RegExp): void => {
      const n = byName.get(name)!;
      expect(n.class, name).toBe(cls);
      expect(n.deepLink, name).toMatch(link);
    };
    expectLink('positionCritical', 'P0', /^\/positions\?id=pos_synthetic_1$/);
    expectLink('tier1Resolved', 'P0', /^\/ticket\?prefill=ntf_/);
    expectLink('tier1Resolved no-trade', 'P0', /^\/catalysts\?id=cat_synthetic_core_cpi$/);
    expectLink('ruleChange', 'P0', /^\/positions\?id=/);
    expectLink('impact3Headline', 'P0', /^\/positions\?id=pos_synthetic_1$/);
    expectLink('ticketInvalidationHit', 'P0', /^\/positions\?id=tkt_synthetic_1$/);
    expectLink('ticketTimeStopHit', 'P0', /^\/positions\?id=/);
    expectLink('biasChanged strong', 'P1', /^\/\?call=c2$/);
    expectLink('entryTriggerFired ticket', 'P1', /^\/ticket\?prefill=ntf_/);
    expectLink('entryTriggerFired catalyst', 'P1', /^\/ticket\?prefill=ntf_/);
    expectLink('setupConfirmed', 'P1', /^\/ticket\?prefill=evt_synthetic_1$/);
    expectLink('catalystT60', 'P2', /^\/catalysts\?id=/);
    expectLink('vestWeekendLockT30', 'P2', /^\/positions\?id=vest-instant$/);
    expectLink('payoutEligible', 'P2', /^\/positions\?id=/);
    expectLink('inactivityT24h', 'P2', /^\/positions\?id=/);
    expectLink('branchProbabilityShift', 'P2', /^\/catalysts\?id=/);
    expectLink('briefReady weekly', 'P3', /^\/journal/);
    expect(byName.get('briefReady recap')!.reason).toBe('brief_recap');
  });

  it('every trade-entry builder passes validateTradeNotification and carries the prefill', () => {
    const byName = new Map(all());
    for (const name of ['tier1Resolved', 'entryTriggerFired ticket', 'entryTriggerFired catalyst', 'setupConfirmed with plan']) {
      const n = byName.get(name)!;
      expect(validateTradeNotification(n), name).toEqual({ ok: true, missing: [] });
      expect(n.ticketPrefill?.size?.units, name).toBeGreaterThan(0);
    }
    expect(byName.get('entryTriggerFired ticket')!.lines).toEqual([
      'NQ 27,178.50: entry trigger fired on your short ticket.',
      'Short NQ on mffu-builder-50k, 2 ct. Entry: rejection of 27,180 after the print.',
      'T1 27,000. Invalidation 27,310. Time stop: flat by 15:30 ET.',
    ]);
    expect(byName.get('setupConfirmed with plan')!.ticketPrefill!.reason).toEqual({ kind: 'structure', setupEventId: 'evt_synthetic_1' });
    // Without a sized plan the read still goes out, but never dressed as a trade entry.
    const unsized = byName.get('tier1Resolved unsized')!;
    expect(unsized.ticketPrefill).toBeUndefined();
    expect(unsized.lines[2]).toBe('Plan has no account or size yet. Size it on the card.');
  });

  it('validateTradeNotification fails when a lock-screen field is missing', () => {
    const good = tier1Resolved(catalyst, { lines: ['Core CPI 0.3% vs 0.2%.'], plan: syntheticPlan })!;
    expect(validateTradeNotification({ ...good, ticketPrefill: undefined })).toEqual({ ok: false, missing: ['ticketPrefill'] });
    expect(validateTradeNotification({ ...good, lines: [good.lines[0]!, good.lines[1]!] }).missing).toEqual(['t1', 'invalidation', 'timeStop']);
    expect(validateTradeNotification({ ...good, lines: [good.lines[0]!, good.lines[2]!] }).missing).toEqual(['instrument', 'direction', 'account', 'size', 'entryTrigger']);
    expect(validateTradeNotification({ ...good, ticketPrefill: { ...good.ticketPrefill!, size: undefined } }).missing).toEqual(['size']);
    expect(validateTradeNotification({ ...good, ticketPrefill: { ...good.ticketPrefill!, accountId: undefined } }).missing).toEqual(['account']);
    expect(validateTradeNotification({ ...good, deepLink: '/catalysts?id=x' }).missing).toEqual(['deepLink']);
    expect(() => entryTriggerFired(catalyst, { price: 27_150, now: WED_0900, plan: { ...syntheticPlan, accountId: undefined } })).toThrow(TradeNotificationError);
  });

  it('catalyst-engine lines are used verbatim when they already show every field', () => {
    const lines = [
      'Core CPI 0.3% vs 0.2%. Short NQ-PERP on vest-instant, $40,000 at 8x.',
      'Entry: second move after 08:45 ET if the 10Y confirms. T1 27,000, invalidation 27,310.',
      'Flat by 10:30 ET. 10Y +9 bp to 4.95%.',
    ];
    expect(tier1Resolved(catalyst, { lines, plan: syntheticPlan })!.lines).toEqual(lines);
  });

  it('builders return null when the trigger condition is not met', () => {
    expect(positionCritical(syntheticPosition, { ...syntheticCritical, status: 'Thin' })).toBeNull();
    expect(tier1Resolved({ ...catalyst, tier: 2 }, { lines: ['x 1'], plan: syntheticPlan })).toBeNull();
    expect(impact3Headline(syntheticHeadline, null)).toBeNull();
    expect(impact3Headline({ ...syntheticHeadline, impact: 2 }, syntheticPosition)).toBeNull();
    expect(impact3Headline({ ...syntheticHeadline, symbols: ['NVDA'] }, syntheticPosition)).toBeNull();
    // Lean to lean, strong to lean, anything to no edge, and an unchanged call do not notify.
    expect(biasChanged(syntheticCall('lean_long', 0.6, 'a'), syntheticCall('lean_short', 0.6, 'b'))).toBeNull();
    expect(biasChanged(syntheticCall('strong_long', 0.7, 'a'), syntheticCall('lean_long', 0.6, 'b'))).toBeNull();
    expect(biasChanged(syntheticCall('lean_long', 0.6, 'a'), syntheticCall('no_edge', 0.5, 'b'))).toBeNull();
    expect(biasChanged(syntheticCall('strong_long', 0.7, 'a'), syntheticCall('strong_long', 0.72, 'b'))).toBeNull();
    expect(biasChanged(null, syntheticCall('lean_long', 0.6, 'b'))).toBeNull();
    expect(biasChanged(null, syntheticCall('strong_long', 0.7, 'b'))).not.toBeNull();
    expect(setupConfirmed(syntheticSetup, ['AMZN'])).toBeNull();
    expect(setupConfirmed({ ...syntheticSetup, confirmedSetup: false }, ['NVDA'])).toBeNull();
    expect(branchProbabilityShift(upcoming, upcoming.matrix!.branches[2]!, 40, 54, WED_0900)).toBeNull();
    expect(catalystT60({ ...upcoming, tier: 3 }, et(2026, 11, 18, 7, 30))).toBeNull();
  });

  it('withFlag adds the pattern flag once', () => {
    const base = ticketTimeStopHit(syntheticTicket);
    const flagged = withFlag(base, 'Held through time stop 3 times this month.');
    expect(flagged.lines).toHaveLength(3);
    expect(withFlag(flagged, 'Again.').lines).toEqual(flagged.lines);
  });
});

describe('dueReminders', () => {
  const vest = syntheticAccount();
  const cme = syntheticCmeAccount();
  const upcoming = syntheticCatalyst({ status: 'upcoming', resolution: null });
  const base = { catalysts: [upcoming], profile: syntheticProfile };
  const reasons = (xs: NotificationIntent[]): string[] => xs.map((x) => x.reason).sort();

  it('emits each time-based P2 inside its window, once', () => {
    const accounts = [
      { rules: vest, state: syntheticAccountState('vest-instant'), positions: [syntheticPosition] },
      {
        rules: cme,
        state: syntheticAccountState('mffu-builder-50k', {
          balance: 53_500, cyclePnl: 3_500, bestDayPnlInCycle: 1_540, qualifyingDaysInCycle: 2,
          cycleStartedAt: iso(et(2026, 11, 9, 9, 30)), lastTradeAt: iso(et(2026, 11, 12, 7, 0)),
        }),
      },
    ];
    // Wed 07:30 ET: CPI is 60 min out; the Builder account breaches inactivity Thu 07:00 ET; payout conditions are met.
    const now = et(2026, 11, 18, 7, 30);
    const due = dueReminders({ ...base, now, accounts, state: emptyNotifyState() });
    expect(reasons(due)).toEqual(['catalyst_t60', 'inactivity_t24h', 'payout_eligible']);
    const payout = due.find((d) => d.reason === 'payout_eligible')!;
    expect(payout.lines[0]).toBe('Builder 50K: $1,400 claimable, 2 of 2 qualifying days, best day 44% of the cycle vs 50% limit.');
    expect(due.find((d) => d.reason === 'catalyst_t60')!.lines[0]).toBe('Core CPI MoM in 60 min (08:30 ET). Consensus 0.2%, prior 0.2%, implied ±1.1%.');
    expect(due.find((d) => d.reason === 'inactivity_t24h')!.lines[0]).toBe('Builder 50K: inactivity breach in 24h, Thu 07:00 ET. Rule: one trade every 7 days.');
    for (const d of due) expect(voiceLint(d.lines), d.reason).toEqual([]);

    let state = emptyNotifyState();
    for (const d of due) state = decide(d, state, ctx(now)).state;
    expect(dueReminders({ ...base, now: now + MIN, accounts, state })).toEqual([]);
    // 61 minutes out is not due yet.
    expect(reasons(dueReminders({ ...base, now: now - MIN, accounts: [], state: emptyNotifyState() }))).toEqual([]);
  });

  it('a reminder held by quiet hours or cut by the budget is not offered again', () => {
    const early = syntheticCatalyst({ id: 'cat_synthetic_early', status: 'upcoming', resolution: null, scheduledAt: iso(et(2026, 11, 18, 6, 15)) });
    const now = et(2026, 11, 18, 5, 30);
    const [t60] = dueReminders({ now, catalysts: [early], accounts: [], profile: syntheticProfile, state: emptyNotifyState() });
    const d = decide(t60!, emptyNotifyState(), ctx(now));
    expect(d.notification.suppressedBy).toBe('quiet_hours');
    expect(dueReminders({ now: now + 40 * MIN, catalysts: [early], accounts: [], profile: syntheticProfile, state: d.state })).toEqual([]);
  });

  it('Vest weekend lock: T-30 before Friday 20:00 ET, only with a non-crypto position unless configured', () => {
    const fri1931 = et(2026, 11, 20, 19, 31);
    const withPos = [{ rules: vest, state: syntheticAccountState('vest-instant'), positions: [syntheticPosition] }];
    const flat = [{ rules: vest, state: syntheticAccountState('vest-instant'), positions: [] }];
    const crypto = [{ rules: vest, state: syntheticAccountState('vest-instant'), positions: [{ ...syntheticPosition, instrument: 'BTC' }] }];
    const at = (now: number, accounts: typeof withPos, always = false) =>
      reasons(dueReminders({ now, catalysts: [], accounts, profile: syntheticProfile, state: emptyNotifyState(), weekendLockAlways: always }));
    expect(at(fri1931, withPos)).toEqual(['weekend_lock_t30']);
    expect(at(et(2026, 11, 20, 19, 29), withPos)).toEqual([]);
    expect(at(et(2026, 11, 19, 19, 45), withPos)).toEqual([]);
    expect(at(et(2026, 11, 20, 20, 1), withPos)).toEqual([]);
    expect(at(fri1931, flat)).toEqual([]);
    expect(at(fri1931, crypto)).toEqual([]);
    expect(at(fri1931, flat, true)).toEqual(['weekend_lock_t30']);
    const [lock] = dueReminders({ now: fri1931, catalysts: [], accounts: withPos, profile: syntheticProfile, state: emptyNotifyState() });
    expect(lock!.lines[0]).toBe('Vest Instant: weekend lock in 29 min, Fri 20:00 ET.');
    expect(lock!.dedupeKey).toBe('weekend_lock:vest-instant:2026-11-21');
  });

  it('payout eligibility respects consistency, qualifying days and the buffer', () => {
    const cmeState = (over: Parameters<typeof syntheticAccountState>[1]) =>
      [{ rules: cme, state: syntheticAccountState('mffu-builder-50k', { balance: 53_500, cyclePnl: 3_500, bestDayPnlInCycle: 1_540, qualifyingDaysInCycle: 2, ...over }) }];
    const due = (accounts: ReturnType<typeof cmeState>) => reasons(dueReminders({ now: WED_0900, catalysts: [], accounts, profile: syntheticProfile, state: emptyNotifyState() }));
    expect(due(cmeState({}))).toEqual(['payout_eligible']);
    expect(due(cmeState({ bestDayPnlInCycle: 1_800 }))).toEqual([]);
    expect(due(cmeState({ qualifyingDaysInCycle: 1 }))).toEqual([]);
    expect(due(cmeState({ balance: 52_500 }))).toEqual([]);
    expect(due(cmeState({ active: false }))).toEqual([]);
  });
});
