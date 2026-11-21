/**
 * The notification policy: decides whether an intent is pushed. Pure; transport is the platform's Pusher.
 * Spec section 10: budgets, quiet hours, suppression, channels and sound are enforced here, in code.
 */
import { hashId, inWindow, isUsHours, iso } from '@desk/contracts';
import type { JournalNote, Notification, NotificationIntent, Profile } from '@desk/contracts';
import { etTime } from './format';
import {
  IGNORED_P1_LIMIT, P0_ONLY_MS, P0_REPEAT_MS, P1_AFTER_P0_MS, P1_SESSION_MAX, P2_DAY_MAX, TAP_WINDOW_MS,
  contentHash, instrumentKey, notificationId, rollState,
} from './state';
import type { NotifyLogEntry, NotifyState } from './state';

/** The one P0 that survives the kill switch and repeats on unchanged content. */
export const POSITION_CRITICAL = 'position_critical';
/** P3 is scheduled only: an intent must carry one of these reasons. */
export const SCHEDULE_REASONS: readonly string[] = ['brief_morning', 'brief_recap', 'brief_weekly'];

export type SuppressedBy =
  | 'kill_switch' | 'unscheduled' | 'p0_repeat_5m' | 'duplicate_key' | 'duplicate_content'
  | 'quiet_hours' | 'p0_only' | 'p0_cooldown_10m' | 'p1_budget' | 'p2_budget';

export interface DecideContext {
  now: number;
  /** IANA zone for quiet hours and the P2 day. */
  tz: string;
  profile: Profile;
  /** Last time the trader tapped any notification, when individual taps were not recorded with `noteTaps`. */
  lastTapAt?: number;
  /** Admin kill switch: everything is suppressed except P0 position-Critical. */
  killSwitch?: boolean;
}

export interface Decision {
  notification: Notification;
  state: NotifyState;
  /** Set when this call's sweep dropped the desk to P0-only; write them to the journal. */
  journalNotes: JournalNote[];
}

export function inQuietHours(now: number, tz: string, profile: Profile): boolean {
  const q = profile.notifications.quietHours;
  return inWindow(now, q.from, q.to, tz);
}

/**
 * Resolves sent P1s whose 15-minute tap window has closed. Three ignored in a row drop the desk to
 * P0-only for 2 hours, counted from the moment the third window closed, and produce the journal note.
 */
export function sweepIgnored(state: NotifyState, now: number, lastTapAt?: number): { state: NotifyState; journalNotes: JournalNote[] } {
  const log = state.log.map((e): NotifyLogEntry => {
    if (e.attention !== 'pending' || now < e.at + TAP_WINDOW_MS) return e;
    const tapped = e.tappedAt !== null || (lastTapAt !== undefined && lastTapAt >= e.at && lastTapAt <= e.at + TAP_WINDOW_MS);
    return { ...e, attention: tapped ? 'tapped' : 'ignored' };
  });
  const resolved = log.filter((e) => e.at > state.streakFloor && (e.attention === 'tapped' || e.attention === 'ignored'));
  let streak = 0;
  for (let i = resolved.length - 1; i >= 0 && resolved[i]!.attention === 'ignored'; i--) streak++;
  if (streak < IGNORED_P1_LIMIT) return { state: { ...state, log, ignoredP1Streak: streak }, journalNotes: [] };

  const third = resolved[resolved.length - 1]!;
  const droppedAt = third.at + TAP_WINDOW_MS;
  const until = droppedAt + P0_ONLY_MS;
  const note: JournalNote = {
    id: hashId('note', 'p0_only', third.id), ts: iso(droppedAt), source: 'system', tags: ['notifications', 'p0_only'],
    text: `${streak} P1s in a row went untapped for 15 min. Notifications are P0-only until ${etTime(until)}.`,
  };
  return { state: { ...state, log, ignoredP1Streak: 0, streakFloor: third.at, p0OnlyUntil: until }, journalNotes: [note] };
}

/** Records a tap. A tap on a P1 inside its 15-minute window breaks the ignored streak. */
export function noteTaps(state: NotifyState, tappedId: string, now: number): NotifyState {
  const log = state.log.map((e): NotifyLogEntry => {
    if (e.id !== tappedId || e.tappedAt !== null) return e;
    const timely = e.attention === 'pending' && now <= e.at + TAP_WINDOW_MS;
    return { ...e, tappedAt: now, attention: timely ? 'tapped' : e.attention };
  });
  return sweepIgnored({ ...state, log }, now).state;
}

function suppression(intent: NotificationIntent, s: NotifyState, ctx: DecideContext, hash: string): SuppressedBy | null {
  const { now } = ctx;
  const critical = intent.class === 'P0' && intent.reason === POSITION_CRITICAL;
  if (ctx.killSwitch && !critical) return 'kill_switch';
  if (intent.class === 'P3' && !SCHEDULE_REASONS.includes(intent.reason)) return 'unscheduled';

  if (intent.class === 'P0') {
    const last = s.lastP0ByKey[intent.dedupeKey];
    if (last && now - last.at < P0_REPEAT_MS) return 'p0_repeat_5m';
    // Position-Critical repeats every 5 minutes until acted on, even when the numbers have not moved.
    if (!critical && (last?.hash === hash || s.lastContentHash === hash)) return 'duplicate_content';
    return null;
  }

  const seen = s.keys[intent.dedupeKey];
  if (seen && seen.decision !== 'suppressed') return 'duplicate_key';
  if (s.lastContentHash === hash) return 'duplicate_content';
  if (inQuietHours(now, ctx.tz, ctx.profile)) return 'quiet_hours';
  if (s.p0OnlyUntil !== null && now < s.p0OnlyUntil) return 'p0_only';
  if (intent.class === 'P1') {
    const lastP0 = intent.instrument === null ? undefined : s.lastP0ByInstrument[instrumentKey(intent.instrument)];
    if (lastP0 !== undefined && now - lastP0 < P1_AFTER_P0_MS) return 'p0_cooldown_10m';
    if (s.p1.count >= Math.min(P1_SESSION_MAX, ctx.profile.notifications.p1PerSession)) return 'p1_budget';
  }
  if (intent.class === 'P2' && s.p2.count >= Math.min(P2_DAY_MAX, ctx.profile.notifications.p2PerDay)) return 'p2_budget';
  return null;
}

/**
 * Decides one intent. Sent: web push plus the feed, and Telegram for P0. Suppressed: the feed only,
 * with the reason. A suppressed intent never consumes budget.
 */
export function decide(intent: NotificationIntent, state: NotifyState, ctx: DecideContext): Decision {
  const { now } = ctx;
  const swept = sweepIgnored(state, now, ctx.lastTapAt);
  const s = rollState(swept.state, now, ctx.tz);
  const hash = contentHash(intent.lines);
  const suppressedBy = suppression(intent, s, ctx, hash);
  const sent = suppressedBy === null;

  const baseId = notificationId(intent);
  const id = s.log.some((e) => e.id === baseId) ? hashId('ntf', intent.dedupeKey, intent.ts, now) : baseId;
  const notification: Notification = {
    ...intent, id, decision: sent ? 'sent' : 'suppressed', suppressedBy,
    channels: !sent ? ['feed'] : intent.class === 'P0' ? ['webpush', 'telegram', 'feed'] : ['webpush', 'feed'],
    tappedAt: null,
  };
  const entry: NotifyLogEntry = {
    id, class: intent.class, reason: intent.reason, instrument: intent.instrument, dedupeKey: intent.dedupeKey, at: now,
    decision: notification.decision, suppressedBy, tappedAt: null, attention: sent && intent.class === 'P1' ? 'pending' : null,
  };

  const held = suppressedBy === 'quiet_hours';
  const prior = s.keys[intent.dedupeKey];
  const keyDecision = sent ? 'sent' : held ? 'held' : 'suppressed';
  const next: NotifyState = {
    ...s,
    log: [...s.log, entry],
    keys: !prior || (prior.decision === 'suppressed' && keyDecision !== 'suppressed') ? { ...s.keys, [intent.dedupeKey]: { at: now, decision: keyDecision } } : s.keys,
    held: held ? [...s.held, notification] : s.held,
  };
  if (sent) {
    next.lastContentHash = hash;
    if (intent.class === 'P1') next.p1 = { ...s.p1, count: s.p1.count + 1 };
    if (intent.class === 'P2') next.p2 = { ...s.p2, count: s.p2.count + 1 };
    if (intent.class === 'P0') {
      next.lastP0ByKey = { ...s.lastP0ByKey, [intent.dedupeKey]: { at: now, hash } };
      if (intent.instrument !== null) next.lastP0ByInstrument = { ...s.lastP0ByInstrument, [instrumentKey(intent.instrument)]: now };
    }
  }
  return { notification, state: next, journalNotes: swept.journalNotes };
}

export interface Delivery {
  /** Play a sound. */
  sound: boolean;
  /** Break through silent mode and Focus (P0 only). */
  urgent: boolean;
  channels: Notification['channels'];
}

/** Sound semantics per class: P0 always and overrides silent, P1 during US hours (04:00 to 20:00 ET weekdays), P2 and P3 never. */
export function delivery(notification: Notification, now: number): Delivery {
  const sent = notification.decision === 'sent';
  const p0 = sent && notification.class === 'P0';
  return { sound: p0 || (sent && notification.class === 'P1' && isUsHours(now)), urgent: p0, channels: notification.channels };
}

export interface PushPayload { title: string; body: string; url: string; tag: string; class: Notification['class'] }

/** Web-push shape. `tag` is the dedupe key, so a repeat replaces the previous one on the lock screen. */
export function toPushPayload(notification: Notification): PushPayload {
  const [title = '', ...rest] = notification.lines;
  return { title, body: rest.join('\n'), url: notification.deepLink, tag: notification.dedupeKey, class: notification.class };
}
