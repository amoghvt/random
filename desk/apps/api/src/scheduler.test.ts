import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { hhmm, KV, zoned } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { BullScheduler, createScheduler, nextCronFire, TimerScheduler, type Scheduler } from './scheduler';
import { memoryLog } from './testkit';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}

let s: Scheduler | null = null;
afterEach(async () => { await s?.stop(); s = null; });

describe('scheduler (in-process timers)', () => {
  const make = () => {
    const store = new MemoryStore();
    const log = memoryLog();
    const sched = new TimerScheduler({ store, clock: Date.now, log });
    s = sched;
    return { store, log, sched };
  };

  it('honours the kill switch: kv admin.kill true skips every job and says so in the log', async () => {
    const { store, log, sched } = make();
    const runs = { loop: 0, brief: 0 };
    sched.every('loop', 60_000, () => { runs.loop++; });
    sched.cron('brief', '06:30', 'America/New_York', () => { runs.brief++; });
    await store.kvSet(KV.killSwitch, true);
    expect((await sched.runNow('loop')).status).toBe('skipped_kill');
    expect((await sched.runNow('brief')).status).toBe('skipped_kill');
    expect(runs).toEqual({ loop: 0, brief: 0 });
    expect(log.lines).toEqual(['warn scheduler: loop skipped, kill switch is on', 'warn scheduler: brief skipped, kill switch is on']);
    await store.kvSet(KV.killSwitch, false);
    expect((await sched.runNow('loop')).status).toBe('ok');
    expect((await sched.runNow('brief')).status).toBe('ok');
    expect(runs).toEqual({ loop: 1, brief: 1 });
  });

  it('never overlaps a job with itself, while different jobs run side by side', async () => {
    const { sched } = make();
    let release = (): void => undefined;
    let active = 0, peak = 0, other = 0;
    sched.every('slow', 60_000, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((r) => { release = r; });
      active--;
    });
    sched.every('other', 60_000, () => { other++; });
    const first = sched.runNow('slow');
    await until(() => active === 1);
    expect((await sched.runNow('slow')).status).toBe('skipped_overlap');
    expect((await sched.runNow('other')).status).toBe('ok');
    expect(sched.jobs().find((j) => j.name === 'slow')!.running).toBe(true);
    release();
    expect((await first).status).toBe('ok');
    expect(peak).toBe(1);
    expect(other).toBe(1);
    const again = sched.runNow('slow');
    await until(() => active === 1);
    release();
    expect((await again).status).toBe('ok');
  });

  it('survives a thrown error and runs the job again', async () => {
    const { sched, log } = make();
    let n = 0;
    sched.every('flaky', 60_000, () => { n++; if (n === 1) throw new Error('feed down'); });
    const r1 = await sched.runNow('flaky');
    expect(r1).toMatchObject({ status: 'error', error: 'feed down' });
    expect(log.lines[0]).toMatch(/^error scheduler: flaky failed: Error: feed down/);
    expect((await sched.runNow('flaky')).status).toBe('ok');
    expect(sched.jobs()[0]!.lastRun!.status).toBe('ok');
  });

  it('fires interval jobs on the timer, keeps going after an error, and stops on stop()', async () => {
    const { sched } = make();
    let n = 0;
    sched.every('tick', 20, () => { n++; if (n === 2) throw new Error('synthetic failure'); });
    await sched.start();
    await until(() => n >= 4, 3000);
    await sched.stop();
    const at = n;
    await sleep(80);
    expect(n).toBe(at);
  });

  it('refuses duplicate names, bad times and unknown jobs', async () => {
    const { sched } = make();
    sched.every('a', 1000, () => undefined);
    expect(() => sched.every('a', 1000, () => undefined)).toThrow(/already registered/);
    expect(() => sched.cron('b', '6:30', 'America/New_York', () => undefined)).toThrow(/HH:MM/);
    expect(() => sched.cron('c', '06:30', 'Mars/Olympus', () => undefined)).toThrow();
    expect(() => sched.every('d', 0, () => undefined)).toThrow(/positive interval/);
    await expect(sched.runNow('nope')).rejects.toThrow(/Unknown job/);
  });

  it('createScheduler picks timers without REDIS_URL', () => {
    const sched = createScheduler({}, { store: new MemoryStore(), clock: Date.now });
    expect(sched).toBeInstanceOf(TimerScheduler);
  });
});

describe('nextCronFire', () => {
  const NY = 'America/New_York';
  it('is the next wall-clock HH:MM in the zone, today or tomorrow', () => {
    const before = Date.parse('2026-11-16T10:00:00Z'); // 05:00 ET
    expect(new Date(nextCronFire(before, 6, 30, NY)).toISOString()).toBe('2026-11-16T11:30:00.000Z');
    const after = Date.parse('2026-11-16T11:30:00Z'); // exactly 06:30 ET: strictly after
    expect(new Date(nextCronFire(after, 6, 30, NY)).toISOString()).toBe('2026-11-17T11:30:00.000Z');
  });
  it('holds wall-clock time across the DST change (2026-03-08 in New York)', () => {
    const t = nextCronFire(Date.parse('2026-03-07T12:00:00Z'), 6, 30, NY);
    expect(new Date(t).toISOString()).toBe('2026-03-08T10:30:00.000Z');
    expect(hhmm(t, NY)).toBe('06:30');
  });
  it('respects weekdays: Sunday 18:00 from a Monday', () => {
    const t = nextCronFire(Date.parse('2026-11-16T15:00:00Z'), 18, 0, NY, [0]);
    expect(new Date(t).toISOString()).toBe('2026-11-22T23:00:00.000Z');
    expect(zoned(t, NY).weekday).toBe(0);
  });
});

const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)('scheduler (BullMQ, REDIS_URL)', () => {
  it('runs a repeatable job from Redis, does not overlap it, survives an error and honours the kill switch', async () => {
    const store = new MemoryStore();
    const log = memoryLog();
    const sched = new BullScheduler({ store, clock: Date.now, log }, { url: redisUrl!, prefix: `desk-test-${randomBytes(5).toString('hex')}` });
    s = sched;
    expect(createScheduler({ REDIS_URL: redisUrl }, { store, clock: Date.now })).toBeInstanceOf(BullScheduler);
    let runs = 0, active = 0, peak = 0;
    sched.every('tick', 200, async () => {
      runs++; active++; peak = Math.max(peak, active);
      await sleep(450);
      active--;
      if (runs === 1) throw new Error('synthetic failure');
    });
    sched.cron('brief', '06:30', 'America/New_York', () => undefined, { days: [1, 2, 3, 4, 5] });
    try {
      await sched.start();
      await until(() => runs >= 3, 20_000);
      expect(peak).toBe(1);
      expect(log.lines.some((l) => l.startsWith('error scheduler: tick failed: Error: synthetic failure'))).toBe(true);

      await store.kvSet(KV.killSwitch, true);
      await until(() => active === 0);
      const frozen = runs;
      await until(() => log.lines.includes('warn scheduler: tick skipped, kill switch is on'), 10_000);
      await sleep(700);
      expect(runs).toBe(frozen);

      await store.kvSet(KV.killSwitch, false);
      await until(() => runs > frozen, 10_000);
      expect((await sched.runNow('brief')).status).toBe('ok');
    } finally {
      await sched.obliterate();
    }
  }, 60_000);
});
