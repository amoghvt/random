/** When each brief is due. Wall-clock slots are resolved per day, so DST shifts move the UTC instant, not the local time. */
import { DAY, ET, fromZoned, zoned, type Profile } from '@desk/contracts';

export type BriefSlot = 'morning' | 'morning_regen' | 'recap' | 'weekly';
export const REGEN_ET = '08:00';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseHm(s: string, fallback: [number, number]): [number, number] {
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

/** Epoch ms of the slot on the local day (or week) that contains `now`. */
export function slotTime(kind: BriefSlot, now: number, profile: Profile): number {
  const n = profile.notifications;
  if (kind === 'weekly') {
    const tz = profile.timezone;
    const wd = Math.max(0, WEEKDAYS.indexOf(n.weeklyLocal.trim().slice(0, 3).toLowerCase()));
    const [h, m] = parseHm(n.weeklyLocal, [18, 0]);
    const z = zoned(now, tz);
    // Step back to the most recent such weekday; noon keeps the day arithmetic clear of DST shifts.
    for (let back = 0; back <= 7; back++) {
      const d = zoned(fromZoned(z.year, z.month, z.day, 12, 0, tz) - back * DAY, tz);
      if (d.weekday !== wd) continue;
      const slot = fromZoned(d.year, d.month, d.day, h, m, tz);
      if (slot <= now) return slot;
    }
    return Number.POSITIVE_INFINITY;
  }
  const tz = kind === 'morning' ? profile.timezone : ET;
  const [h, m] = kind === 'morning' ? parseHm(n.morningBriefLocal, [6, 30]) : kind === 'recap' ? parseHm(n.recapET, [16, 30]) : parseHm(REGEN_ET, [8, 0]);
  const z = zoned(now, tz);
  return fromZoned(z.year, z.month, z.day, h, m, tz);
}

/**
 * True once per slot: the slot has passed and nothing of this kind ran since.
 * `lastBriefAt` is the last time this kind fired (for `morning_regen`, the last regeneration check,
 * whether or not it replaced the brief). Daily kinds only catch up within their own day; the weekly
 * catches up until the next Sunday. The recap and the 08:00 ET check skip Saturday and Sunday.
 */
export function briefDue(kind: BriefSlot, now: number, profile: Profile, lastBriefAt: number | null): boolean {
  const slot = slotTime(kind, now, profile);
  if (now < slot) return false;
  if (kind === 'recap' || kind === 'morning_regen') {
    const wd = zoned(now, ET).weekday;
    if (wd === 0 || wd === 6) return false;
  }
  return lastBriefAt === null || lastBriefAt < slot;
}
