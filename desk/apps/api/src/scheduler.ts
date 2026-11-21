import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { fromZoned, KV, zoned, type Store } from '@desk/contracts';
import { errText, silentLog, type Log } from './log';

export type JobFn = () => Promise<void> | void;
/** `days`: weekdays the cron fires on in its timezone, 0 = Sunday. Default every day. */
export interface CronOpts { days?: number[] }
export type JobStatus = 'ok' | 'error' | 'skipped_kill' | 'skipped_overlap';
export interface JobRun { name: string; status: JobStatus; startedAt: string; ms: number; error: string | null }
export interface JobInfo { name: string; schedule: string; running: boolean; lastRun: JobRun | null }

export interface Scheduler {
  /** Runs `fn` every `ms`. A run still in flight when the next is due is skipped, never doubled. */
  every(name: string, ms: number, fn: JobFn): void;
  /** Runs `fn` at wall-clock 'HH:MM' in `tz`. */
  cron(name: string, hhmm: string, tz: string, fn: JobFn, opts?: CronOpts): void;
  /** Runs a registered job now, through the same kill-switch, overlap and error handling as a scheduled run. */
  runNow(name: string): Promise<JobRun>;
  jobs(): JobInfo[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SchedulerDeps { store: Store; clock: () => number; log?: Log }

type JobDef = { name: string; fn: JobFn } & ({ kind: 'every'; ms: number } | { kind: 'cron'; hour: number; minute: number; tz: string; days: number[] | null });

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Bad cron time "${hhmm}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Next instant strictly after `now` that reads `hour:minute` in `tz` on an allowed weekday. */
export function nextCronFire(now: number, hour: number, minute: number, tz: string, days: number[] | null = null): number {
  const z = zoned(now, tz);
  for (let i = 0; i <= 8; i++) {
    const t = fromZoned(z.year, z.month, z.day + i, hour, minute, tz);
    if (t > now && (days === null || days.includes(zoned(t, tz).weekday))) return t;
  }
  throw new Error(`No fire time for ${hour}:${minute} ${tz} on days [${String(days)}]`);
}

abstract class BaseScheduler implements Scheduler {
  protected readonly defs = new Map<string, JobDef>();
  protected readonly log: Log;
  protected started = false;
  private readonly running = new Set<string>();
  private readonly lastRun = new Map<string, JobRun>();

  constructor(protected readonly deps: SchedulerDeps) { this.log = deps.log ?? silentLog; }

  protected abstract arm(def: JobDef): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  private register(def: JobDef): void {
    if (this.defs.has(def.name)) throw new Error(`Job "${def.name}" is already registered`);
    this.defs.set(def.name, def);
    if (this.started) this.arm(def).catch((e: unknown) => this.log.error(`scheduler: could not schedule ${def.name}: ${errText(e)}`));
  }

  every(name: string, ms: number, fn: JobFn): void {
    if (!Number.isFinite(ms) || ms < 1) throw new Error(`Job "${name}" needs a positive interval`);
    this.register({ name, fn, kind: 'every', ms });
  }

  cron(name: string, hhmm: string, tz: string, fn: JobFn, opts: CronOpts = {}): void {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    const days = opts.days && opts.days.length > 0 ? opts.days : null;
    if (days?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error(`Job "${name}" has a weekday outside 0-6`);
    this.register({ name, fn, kind: 'cron', ...parseHhmm(hhmm), tz, days });
  }

  runNow(name: string): Promise<JobRun> { return this.run(name); }

  protected async run(name: string): Promise<JobRun> {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown job "${name}"`);
    const t0 = this.deps.clock();
    const done = (status: JobStatus, error: string | null = null): JobRun => {
      const r: JobRun = { name, status, startedAt: new Date(t0).toISOString(), ms: this.deps.clock() - t0, error };
      this.lastRun.set(name, r);
      return r;
    };
    if (this.running.has(name)) {
      this.log.warn(`scheduler: ${name} skipped, previous run still in flight`);
      return done('skipped_overlap');
    }
    this.running.add(name);
    try {
      if ((await this.deps.store.kvGet<boolean>(KV.killSwitch)) === true) {
        this.log.warn(`scheduler: ${name} skipped, kill switch is on`);
        return done('skipped_kill');
      }
      await def.fn();
      return done('ok');
    } catch (e) {
      this.log.error(`scheduler: ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return done('error', errText(e));
    } finally {
      this.running.delete(name);
    }
  }

  jobs(): JobInfo[] {
    return [...this.defs.values()].map((d) => ({
      name: d.name,
      schedule: d.kind === 'every' ? `every ${d.ms}ms` : `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')} ${d.tz}${d.days ? ` days ${d.days.join(',')}` : ''}`,
      running: this.running.has(d.name),
      lastRun: this.lastRun.get(d.name) ?? null,
    }));
  }
}

/** Timers in this process. Used when there is no Redis. */
export class TimerScheduler extends BaseScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  protected async arm(def: JobDef): Promise<void> {
    if (def.kind === 'every') {
      this.timers.set(def.name, setInterval(() => void this.run(def.name), def.ms));
      return;
    }
    const schedule = (): void => {
      const delay = nextCronFire(Date.now(), def.hour, def.minute, def.tz, def.days) - Date.now();
      this.timers.set(def.name, setTimeout(() => { void this.run(def.name); schedule(); }, delay));
    };
    schedule();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const def of this.defs.values()) await this.arm(def);
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

export interface BullOptions { url: string; queueName?: string; prefix?: string }

/** BullMQ job schedulers (repeatable jobs) and one worker. Schedules survive a restart in Redis. */
export class BullScheduler extends BaseScheduler {
  private readonly queueName: string;
  private readonly prefix: string;
  private readonly connections: Redis[] = [];
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(deps: SchedulerDeps, private readonly opts: BullOptions) {
    super(deps);
    this.queueName = opts.queueName ?? 'desk-jobs';
    this.prefix = opts.prefix ?? 'desk';
  }

  private connection(): Redis {
    const c = new Redis(this.opts.url, { maxRetriesPerRequest: null });
    c.on('error', (e: Error) => this.log.error(`scheduler: redis ${errText(e)}`));
    this.connections.push(c);
    return c;
  }

  protected async arm(def: JobDef): Promise<void> {
    if (!this.queue) throw new Error('Scheduler is not started');
    const repeat = def.kind === 'every'
      ? { every: def.ms }
      : { pattern: `${def.minute} ${def.hour} * * ${def.days ? def.days.join(',') : '*'}`, tz: def.tz };
    await this.queue.upsertJobScheduler(def.name, repeat, { name: def.name, opts: { removeOnComplete: 20, removeOnFail: 50 } });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.queue = new Queue(this.queueName, { connection: this.connection(), prefix: this.prefix });
    // Schedules left in Redis by an older build that no longer registers them would fire into nothing.
    for (const s of await this.queue.getJobSchedulers()) {
      if (s.key && !this.defs.has(s.key)) await this.queue.removeJobScheduler(s.key);
    }
    for (const def of this.defs.values()) await this.arm(def);
    // One worker. Its concurrency lets different jobs run side by side; `run` keeps each job name to one at a time.
    this.worker = new Worker(this.queueName, async (job) => {
      if (!this.defs.has(job.name)) return { name: job.name, status: 'unregistered' };
      return this.run(job.name);
    }, { connection: this.connection(), prefix: this.prefix, concurrency: 16 });
    this.worker.on('error', (e) => this.log.error(`scheduler: worker ${errText(e)}`));
    await this.worker.waitUntilReady();
  }

  /** Removes every key this scheduler wrote to Redis (tests). */
  async obliterate(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
    await this.queue?.obliterate({ force: true });
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.worker?.close();
    await this.queue?.close();
    this.worker = null;
    this.queue = null;
    await Promise.allSettled(this.connections.splice(0).map((c) => c.quit()));
  }
}

export function createScheduler(env: { REDIS_URL?: string | undefined }, deps: SchedulerDeps): Scheduler {
  return env.REDIS_URL ? new BullScheduler(deps, { url: env.REDIS_URL }) : new TimerScheduler(deps);
}
