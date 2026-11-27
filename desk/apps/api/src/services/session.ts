/** Session direction call over the store: today's call, the desk's replayed record of it, and the push when it fires. */
import { MIN, type NotificationIntent } from '@desk/contracts';
import { session as s } from '@desk/engines';
import type { DeskDeps } from './context';

export const SESSION_INSTRUMENT = 'NQ';
/** A call first seen long after its check (a backfill landed, the desk was down) is shown but not pushed. */
const FRESH_MS = 20 * MIN;

export interface SessionView { call: s.SessionCallView; scorecard: s.Scorecard }

export async function sessionView(deps: DeskDeps, now: number, instrument = SESSION_INSTRUMENT): Promise<SessionView> {
  const [c15, daily] = await Promise.all([
    deps.store.getCandles(instrument, '15m', { to: now, limit: 6000 }),
    deps.store.getCandles(instrument, '1d', { to: now, limit: 120 }),
  ]);
  return { call: s.sessionCall(c15, daily, now, instrument), scorecard: s.scorecard(c15.filter((c) => c.t + 15 * MIN <= now), daily) };
}

export interface SessionStep { status: s.CallStatus; intents: NotificationIntent[] }

export async function runSession(deps: DeskDeps, now: number): Promise<SessionStep> {
  const { call } = await sessionView(deps, now);
  const intents: NotificationIntent[] = [];
  if (call.call && now - Date.parse(call.call.firedAt) <= FRESH_MS) {
    const n = s.callNotification(call);
    if (n) intents.push(n);
  }
  return { status: call.status, intents };
}
