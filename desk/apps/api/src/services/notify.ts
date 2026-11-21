/** The one door a notification leaves through: policy decision, journal record, delivery when sent, the live feed. */
import { KV, type Notification, type NotificationIntent } from '@desk/contracts';
import { notify } from '@desk/engines';
import { accounts } from './accounts';
import { killSwitchOn, logOf, profileOf, type DeskDeps } from './context';

type NotifyState = notify.NotifyState;

export async function notifyState(deps: DeskDeps): Promise<NotifyState> {
  return (await deps.store.kvGet<NotifyState>(KV.notifyState)) ?? notify.emptyNotifyState();
}

/** Taps are written on the notification docs by the API; the policy state needs them for the ignored-P1 streak. */
async function withTaps(deps: DeskDeps, state: NotifyState, now: number): Promise<NotifyState> {
  let s = state;
  for (const e of state.log) {
    if (e.attention !== 'pending' || e.tappedAt !== null) continue;
    const doc = await deps.store.get('notifications', e.id);
    if (doc?.tappedAt) s = notify.noteTaps(s, e.id, Math.min(now, Date.parse(doc.tappedAt)));
  }
  return s;
}

/**
 * Offers one intent. Returns the stored notification, or null when it is a repeat that is not due yet
 * (a Critical position inside its 5-minute spacing, a key already sent or held): those leave no record.
 * With the kill switch on only position-Critical P0s are delivered.
 */
export async function offer(deps: DeskDeps, intent: NotificationIntent, now: number): Promise<Notification | null> {
  const profile = await profileOf(deps);
  const state = await withTaps(deps, await notifyState(deps), now);
  const lastP0 = state.lastP0ByKey[intent.dedupeKey];
  if (intent.class === 'P0' && lastP0) {
    if (now - lastP0.at < notify.P0_REPEAT_MS) return null;
    if (intent.reason !== notify.POSITION_CRITICAL && lastP0.hash === notify.contentHash(intent.lines)) return null;
  }
  const prior = state.keys[intent.dedupeKey];
  if (intent.class !== 'P0' && prior && prior.decision !== 'suppressed') return null;

  const d = notify.decide(intent, state, { now, tz: profile.timezone, profile, killSwitch: await killSwitchOn(deps.store) });
  const n = d.notification;
  // A key that was already suppressed once and still is: one record of it is enough.
  if (n.decision === 'suppressed' && prior) return null;
  await deps.store.kvSet(KV.notifyState, d.state);
  await deps.store.put('notifications', [n]);
  if (d.journalNotes.length) await deps.store.put('notes', d.journalNotes);
  if (n.decision === 'sent') {
    const r = await deps.push.deliver(n);
    logOf(deps).info(`notify: ${n.class} ${n.reason} sent (${r.channels.join(', ') || 'no channel'})`);
  } else {
    await deps.bus.publish('notification', n);
  }
  return n;
}

export async function offerAll(deps: DeskDeps, intents: NotificationIntent[], now: number): Promise<Notification[]> {
  const out: Notification[] = [];
  // P0 first: a P1 on the same instrument inside 10 minutes of a P0 is then correctly held back.
  const order: Record<NotificationIntent['class'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  for (const i of [...intents].sort((a, b) => order[a.class] - order[b.class])) {
    const n = await offer(deps, i, now);
    if (n) out.push(n);
  }
  return out;
}

/** P2 reminders due now: catalyst T-60, weekend lock T-30, inactivity T-24h, payout eligibility. Each key is emitted once. */
export async function dueReminders(deps: DeskDeps, now: number): Promise<NotificationIntent[]> {
  const [profile, state, accts, positions] = await Promise.all([profileOf(deps), notifyState(deps), accounts(deps, now), deps.store.list('positions')]);
  const catalysts = await deps.store.list('catalysts', { since: new Date(now).toISOString(), until: new Date(now + 2 * 3_600_000).toISOString(), status: 'upcoming' });
  return notify.dueReminders({
    now, catalysts, profile, state,
    accounts: accts.map((a) => ({ rules: a.rules, state: a.state, positions: positions.filter((p) => p.accountId === a.rules.id) })),
  });
}

/** Closes the 15-minute tap windows. Three ignored P1s in a row drop the desk to P0-only for 2 hours, noted in the journal. */
export async function sweepIgnored(deps: DeskDeps, now: number): Promise<{ p0OnlyUntil: number | null }> {
  const state = await withTaps(deps, await notifyState(deps), now);
  const swept = notify.sweepIgnored(state, now);
  await deps.store.kvSet(KV.notifyState, swept.state);
  if (swept.journalNotes.length) await deps.store.put('notes', swept.journalNotes);
  return { p0OnlyUntil: swept.state.p0OnlyUntil };
}

export async function inQuietHours(deps: DeskDeps, now: number): Promise<boolean> {
  const profile = await profileOf(deps);
  return notify.inQuietHours(now, profile.timezone, profile);
}
