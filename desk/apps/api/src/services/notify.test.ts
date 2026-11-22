import { describe, expect, it } from 'vitest';
import { HOUR, KV, MIN, fromZoned, iso, type NotificationIntent } from '@desk/contracts';
import { notify } from '@desk/engines';
import { refreshCatalysts } from './catalysts';
import { profileOf } from './context';
import { dueReminders, inQuietHours, notifyState, offer, offerAll, sweepIgnored } from './notify';
import { desk, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const NOW = et(17, 11, 0);

/** An intent as an engine would build it; the wording is the test's, there is no market number in it. */
const intent = (cls: NotificationIntent['class'], key: string, now: number, over: Partial<NotificationIntent> = {}): NotificationIntent =>
  ({ class: cls, reason: 'test_reason', instrument: 'NQ', lines: [`Test line for ${key}.`, 'Second line.'], deepLink: '/journal', dedupeKey: key, ts: iso(now), ...over });

describe('notify service', () => {
  it('a sent notification is stored, pushed and published; the same key is not offered twice', async () => {
    const d = await desk(NOW);
    const n = (await offer(d.deps, intent('P1', 'k1', NOW), NOW))!;
    expect(n.decision).toBe('sent');
    expect(n.channels).toContain('webpush');
    expect((await d.store.get('notifications', n.id))?.dedupeKey).toBe('k1');
    expect(d.pushed.map((p) => p.payload.tag)).toEqual(['k1']);
    expect(d.feed.map((x) => x.id)).toEqual([n.id]);
    expect(await offer(d.deps, intent('P1', 'k1', NOW + MIN), NOW + MIN)).toBeNull();
    expect(await d.store.list('notifications')).toHaveLength(1);
    expect(d.log.lines.some((l) => l.startsWith('info notify: P1 test_reason sent'))).toBe(true);
  });

  it('the P1 budget caps at the profile limit: the ninth is stored as suppressed and not pushed', async () => {
    const d = await desk(NOW);
    const limit = (await profileOf(d.deps)).notifications.p1PerSession;
    expect(limit).toBe(8);
    const out = [];
    for (let i = 0; i <= limit; i++) {
      const at = NOW + i * 12 * MIN;
      const n = (await offer(d.deps, intent('P1', `k${i}`, at, { instrument: `S${i}`, lines: [`Test line ${i}.`] }), at))!;
      // The trader opens each one, so the ignored-P1 rule stays out of the way and only the budget is counted.
      if (n.decision === 'sent') await d.store.put('notifications', [{ ...n, tappedAt: iso(at + MIN) }]);
      out.push(n);
    }
    console.log(`[notify] decisions: ${out.map((n) => `${n.decision}${n.suppressedBy ? `(${n.suppressedBy})` : ''}`).join(', ')}`);
    expect(out.slice(0, limit).map((n) => n.decision)).toEqual(Array(limit).fill('sent'));
    expect([out[limit]!.decision, out[limit]!.suppressedBy]).toEqual(['suppressed', 'p1_budget']);
    expect(d.pushed.length).toBe(out.filter((n) => n.decision === 'sent').length);
    // Suppressed ones are still on the live feed and in the journal.
    expect(d.feed.length).toBe(out.length);
    expect(await d.store.list('notifications')).toHaveLength(out.length);
  });

  it('quiet hours hold a P1 for the morning brief; a P0 goes through', async () => {
    const night = et(17, 2, 0);
    const d = await desk(night);
    expect(await inQuietHours(d.deps, night)).toBe(true);
    expect(await inQuietHours(d.deps, NOW)).toBe(false);
    const held = (await offer(d.deps, intent('P1', 'night', night), night))!;
    expect([held.decision, held.suppressedBy]).toEqual(['suppressed', 'quiet_hours']);
    expect(d.pushed).toEqual([]);
    expect(notify.heldForMorning(await notifyState(d.deps)).map((h) => h.dedupeKey)).toEqual(['night']);
    const p0 = (await offer(d.deps, intent('P0', 'night_p0', night, { reason: 'tier1_resolved' }), night))!;
    expect(p0.decision).toBe('sent');
    expect(d.pushed).toHaveLength(1);
  });

  it('kill switch: everything is suppressed except a position-Critical P0', async () => {
    const d = await desk(NOW);
    await d.store.kvSet(KV.killSwitch, true);
    const out = await offerAll(d.deps, [
      intent('P1', 'a', NOW), intent('P0', 'b', NOW, { reason: 'tier1_resolved' }),
      intent('P0', `${notify.POSITION_CRITICAL}:pos_1`, NOW, { reason: notify.POSITION_CRITICAL }),
    ], NOW);
    expect(out.map((n) => [n.reason, n.decision, n.suppressedBy])).toEqual([
      ['tier1_resolved', 'suppressed', 'kill_switch'], [notify.POSITION_CRITICAL, 'sent', null], ['test_reason', 'suppressed', 'kill_switch'],
    ]);
    expect(d.pushed.map((p) => p.payload.class)).toEqual(['P0']);
  });

  it('three P1s left untapped drop the desk to P0-only for two hours, noted in the journal; a tap breaks the streak', async () => {
    const d = await desk(NOW);
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push((await offer(d.deps, intent('P1', `p${i}`, NOW + i * 11 * MIN, { instrument: `S${i}`, lines: [`Line ${i}.`] }), NOW + i * 11 * MIN))!);
    expect(sent.map((n) => n.decision)).toEqual(['sent', 'sent', 'sent']);
    const after = NOW + 22 * MIN + 16 * MIN;
    const swept = await sweepIgnored(d.deps, after);
    // Two hours from the moment the third tap window (15 minutes) closed.
    expect(swept.p0OnlyUntil).toBe(NOW + 22 * MIN + 15 * MIN + 2 * HOUR);
    expect((await d.store.list('notes')).length).toBe(1);
    const blocked = (await offer(d.deps, intent('P1', 'p9', after + MIN, { instrument: 'S9' }), after + MIN))!;
    expect([blocked.decision, blocked.suppressedBy]).toEqual(['suppressed', 'p0_only']);

    const t = await desk(NOW);
    const ns = [];
    for (let i = 0; i < 3; i++) ns.push((await offer(t.deps, intent('P1', `p${i}`, NOW + i * 11 * MIN, { instrument: `S${i}`, lines: [`Line ${i}.`] }), NOW + i * 11 * MIN))!);
    await t.store.put('notifications', [{ ...ns[2]!, tappedAt: iso(NOW + 23 * MIN) }]);
    expect((await sweepIgnored(t.deps, after)).p0OnlyUntil).toBeNull();
  });

  it('reminders: the real Nov 10 CPI gets its T-60 once, with consensus and prior from the recorded calendar', async () => {
    const at = et(10, 7, 35);
    const d = await recordedDesk(at, { symbols: ['NQ', 'US10Y', 'VIX'], tfs: ['5m', '1h', '1d'] });
    await refreshCatalysts(d.deps, at);
    const due = await dueReminders(d.deps, at);
    const t60 = due.find((i) => i.reason === 'catalyst_t60')!;
    console.log(`[notify] T-60: ${t60.lines.join(' / ')}`);
    expect(t60.class).toBe('P2');
    expect(t60.lines[0]).toContain('Consensus 0.2%, prior 0.3%');
    expect((await offerAll(d.deps, due, at)).some((n) => n.reason === 'catalyst_t60' && n.decision === 'sent')).toBe(true);
    expect((await dueReminders(d.deps, at + MIN)).filter((i) => i.reason === 'catalyst_t60')).toEqual([]);
    expect(await dueReminders(await desk(at).then((x) => x.deps), at)).toEqual([]);
  }, 60_000);
});
