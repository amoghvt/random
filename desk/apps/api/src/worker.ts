/**
 * The desk's background work: the autonomous loop (every 60 s in US hours, every 5 minutes otherwise) and the daily,
 * weekly and monthly jobs. `runLoop(deps, now)` is the loop body itself, callable with any clock, store and feeds, so
 * the tests and the replay drive exactly what production runs.
 */
import { CORE_SYMBOLS, DAY, ET, KV, MIN, dayKey, isUsHours, iso, zoned, type BiasCall, type Catalyst, type Notification, type NotificationIntent, type NowView, type RuleDiff, type Timeframe } from '@desk/contracts';
import { notify } from '@desk/engines';
import { backfillCandles, buildFeeds, checkFirmRules, ingestOnce, streamCoverage, type Feeds, type IngestReport } from '@desk/feeds';
import type { DeskDeps } from './deps';
import { errText } from './log';
import { applyRuleDiffs, loadRules } from './services/accounts';
import { runBias, runCalibration, runRefit, scoreExpiredCalls } from './services/bias';
import { generateMorning, generateRecap, generateWeekly, regenerateMorning, runDueBriefs } from './services/briefs';
import { generateMatrices, refreshCatalysts, runCatalysts } from './services/catalysts';
import { killSwitchOn, lastRun, logOf, markRun, profileOf, recordHealth, runStep, type StepResult } from './services/context';
import { runGuardrails } from './services/guardrails';
import { candleReader } from './services/market';
import { dueReminders, offerAll, sweepIgnored } from './services/notify';
import { nowView } from './services/now';
import { runPositions, runTickets, type Held } from './services/positions';
import { baseRatesDue, computeBaseRates, runWatcher } from './services/watcher';

export interface WorkerHandle { stop(): Promise<void> }

export interface LoopStep { name: string; ok: boolean; ms: number; error: string | null }
export interface LoopReport {
  asOf: string;
  /** True when the kill switch was on: only the position monitor ran. */
  killSwitch: boolean;
  steps: LoopStep[];
  ingest: IngestReport | null;
  events: number; updates: number;
  /** Calls whose id changed in this loop. */
  calls: BiasCall[];
  /** Catalysts resolved to a branch in this loop. */
  matched: Catalyst[];
  intents: number;
  /** Notifications stored in this loop, sent or suppressed. */
  notifications: Notification[];
  now: NowView | null;
}

/** The environment as the feed layer reads it: the process environment (feature flags such as FEED_CBOE live only there) under the validated keys. */
/**
 * The desk's primary index reads IG's US Tech 100 cash on TradingView by default: it streams tick by tick, where the
 * free CME future is 10 minutes late. `TV_STREAM_SYMBOLS=off` turns the stream off; tests never open a socket.
 */
export const DEFAULT_STREAM_SYMBOLS = 'NQ=IG:NASDAQ';
export const feedEnv = (deps: DeskDeps): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...Object.fromEntries(Object.entries(deps.env).map(([k, v]) => [k, v === undefined ? undefined : String(v)])) };
  if (env.TV_STREAM_SYMBOLS === undefined && env.NODE_ENV !== 'test' && !env.VITEST) env.TV_STREAM_SYMBOLS = DEFAULT_STREAM_SYMBOLS;
  return env;
};
const feedsOf = (deps: DeskDeps): Feeds => deps.feeds ?? buildFeeds(feedEnv(deps));

/** Quotes are all the position monitor needs when everything else is switched off. */
const KILL_KINDS = ['quotes'] as const;

/**
 * One pass of the autonomous loop. Every step is isolated: a failure is logged, recorded in kv `feeds.health` as
 * `worker:<step>`, and the remaining steps still run. With the kill switch on, only quotes are polled and only
 * position-Critical P0s leave.
 */
export async function runLoop(deps: DeskDeps, now: number): Promise<LoopReport> {
  const kill = await killSwitchOn(deps.store);
  const report: LoopReport = { asOf: iso(now), killSwitch: kill, steps: [], ingest: null, events: 0, updates: 0, calls: [], matched: [], intents: 0, notifications: [], now: null };
  const intents: NotificationIntent[] = [];
  const reader = candleReader(deps, now);
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const r: StepResult<T> = await runStep(deps, name, fn);
    report.steps.push({ name: r.name, ok: r.ok, ms: r.ms, error: r.error });
    return r.value;
  };

  report.ingest = await step('ingest', () => ingestOnce(deps.store, feedsOf(deps), now, {
    env: feedEnv(deps), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...deps.ingest, ...(kill ? { kinds: [...KILL_KINDS] } : {}),
  }));

  let held: Held[] | undefined;
  if (kill) {
    const pos = await step('positions', () => runPositions(deps, now, reader));
    if (pos) intents.push(...pos.intents.filter((i) => i.reason === notify.POSITION_CRITICAL));
  } else {
    const watched = await step('watcher', () => runWatcher(deps, now, reader));
    if (watched) { report.events = watched.events.length; report.updates = watched.updates.length; intents.push(...watched.intents); }

    const cats = await step('catalysts', () => runCatalysts(deps, now, reader));
    if (cats) { report.matched = cats.matched; intents.push(...cats.intents); }

    const calls = await step('bias', async () => { await scoreExpiredCalls(deps, now); return runBias(deps, now, reader); });
    if (calls) { report.calls = calls.changed; intents.push(...calls.intents); }

    const pos = await step('positions', () => runPositions(deps, now, reader));
    held = pos?.held;
    const tickets = await step('tickets', () => runTickets(deps, now, reader));
    if (tickets) intents.push(...tickets.intents);

    const guard = await step('guardrails', () => runGuardrails(deps, now, held));
    if (guard) intents.push(...guard.intents);
    // The pattern flag rides on line 3 of the position's own notification, once.
    if (pos) intents.push(...pos.intents.map((i) => notify.withFlag(i, guard?.flags[i.dedupeKey.slice(notify.POSITION_CRITICAL.length + 1)] ?? null)));

    const reminders = await step('reminders', () => dueReminders(deps, now));
    if (reminders) intents.push(...reminders);
  }

  report.intents = intents.length;
  const sent = await step('notifications', async () => {
    const out = await offerAll(deps, intents, now);
    await sweepIgnored(deps, now);
    return out;
  });
  report.notifications = sent ?? [];

  report.now = await step('now', async () => {
    const view = await nowView(deps, now);
    await deps.bus.publish('now', view);
    return view;
  });

  await step('health', async () => {
    await recordHealth(deps.store, report.steps.filter((s) => s.name !== 'health').map((s) => ({ feed: `worker:${s.name}`, ok: s.ok, error: s.error })), now);
    await deps.store.kvSet(KV.lastLoop, iso(now));
  });
  return report;
}

/* ───────────────────────── scheduled jobs ───────────────────────── */

/** Nightly: every rule page is re-read. A changed page raises a P0 and is written onto the stored rules of its accounts. */
export async function runRuleDiff(deps: DeskDeps, now: number): Promise<{ diffs: RuleDiff[]; notifications: Notification[] }> {
  const diffs = await checkFirmRules(deps.store, await loadRules(deps), now, deps.fetch);
  await applyRuleDiffs(deps, diffs);
  const notifications = await offerAll(deps, diffs.map((d) => notify.ruleChange(d)), now);
  await markRun(deps.store, 'rules.diff', now);
  return { diffs, notifications };
}

/** Matrix run at 20:00 ET and 06:00 ET: everything inside the 36-hour window is regenerated on the current calendar. */
export async function runMatrices(deps: DeskDeps, now: number): Promise<number> {
  const refreshed = await refreshCatalysts(deps, now);
  const run = await generateMatrices(deps, now, { force: true, catalysts: refreshed.catalysts });
  await offerAll(deps, run.intents, now);
  return run.generated.length;
}

export interface DueJobs { briefs: string[]; baseRates: number | null; calibration: boolean; refit: boolean; notifications: Notification[] }

/**
 * Everything on a clock that needs no network, run when due: briefs, daily base rates, weekly calibration (Saturday),
 * the monthly re-fit (first loop of a new month). Idempotent, so the cron jobs and a replay stepping a fake clock
 * can both call it.
 */
export async function runDueJobs(deps: DeskDeps, now: number): Promise<DueJobs> {
  const out: DueJobs = { briefs: [], baseRates: null, calibration: false, refit: false, notifications: [] };
  if (await killSwitchOn(deps.store)) return out;
  if (await baseRatesDue(deps, now)) out.baseRates = await computeBaseRates(deps, now);
  const cal = await lastRun(deps.store, 'bias.calibration');
  if (cal === null || now - cal >= 7 * DAY) { await runCalibration(deps, now); await markRun(deps.store, 'bias.calibration', now); out.calibration = true; }
  const refit = await lastRun(deps.store, 'bias.refit');
  if (refit === null || dayKey(refit, ET).slice(0, 7) !== dayKey(now, ET).slice(0, 7)) { await runRefit(deps, now); await markRun(deps.store, 'bias.refit', now); out.refit = true; }
  const due = await runDueBriefs(deps, now);
  out.briefs = due.briefs.map((b) => `${b.kind}:${b.forDay}`);
  out.notifications = await offerAll(deps, due.intents, now);
  return out;
}

const BACKFILL_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

/** On boot: the deepest free history per timeframe, unless the store already holds a recent daily series. */
export async function backfillOnBoot(deps: DeskDeps, now: number): Promise<number> {
  const daily = await deps.store.getCandles('NQ', '1d', { to: now, limit: 300 });
  const last = daily.at(-1);
  if (daily.length >= 250 && last && now - last.t < 5 * DAY) return 0;
  const profile = await profileOf(deps);
  const symbols = [...new Set([...CORE_SYMBOLS, ...profile.instruments.watchlist, ...profile.instruments.occasional, 'CL', 'GC', 'BTC', 'RSP', 'QQQ', 'XLP', 'XLU'])];
  const r = await backfillCandles(deps.store, symbols, BACKFILL_TFS, { ...(deps.fetch ? { fetch: deps.fetch } : {}), exclude: deps.feeds ? [] : streamCoverage(feedEnv(deps)) });
  for (const s of r.series.filter((x) => x.error)) logOf(deps).warn(`backfill: ${s.symbol} ${s.tf}: ${s.error}`);
  return r.candles;
}

const OVERNIGHT_EVERY_MS = 5 * MIN;

/**
 * Registers the loop and the clock jobs with the scheduler and starts it. The scheduler skips every job while the
 * kill switch is on, so the position monitor has its own timer for that case: it runs the loop, which under the
 * kill switch does nothing but watch open positions.
 */
export async function startWorker(deps: DeskDeps): Promise<WorkerHandle> {
  const { scheduler, clock } = deps;
  const log = logOf(deps);
  const profile = await profileOf(deps);
  let inFlight = false;
  const loop = async (): Promise<void> => {
    const now = clock();
    const last = await deps.store.kvGet<string>(KV.lastLoop);
    if (!isUsHours(now) && last && now - Date.parse(last) < OVERNIGHT_EVERY_MS - 5000) return;
    if (inFlight) return;
    inFlight = true;
    try { await runLoop(deps, now); } finally { inFlight = false; }
  };

  scheduler.every('loop', MIN, loop);
  scheduler.every('due-jobs', 10 * MIN, async () => { await runDueJobs(deps, clock()); });
  scheduler.cron('matrices-evening', '20:00', ET, async () => { await runMatrices(deps, clock()); });
  scheduler.cron('matrices-morning', '06:00', ET, async () => { await runMatrices(deps, clock()); });
  const n = profile.notifications;
  const hm = (s: string, fallback: string): string => { const m = /(\d{1,2}):(\d{2})/.exec(s); return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : fallback; };
  const offerBrief = async (r: { intent: NotificationIntent | null }): Promise<void> => { if (r.intent) await offerAll(deps, [r.intent], clock()); };
  scheduler.cron('brief-morning', hm(n.morningBriefLocal, '06:30'), profile.timezone, async () => offerBrief(await generateMorning(deps, clock())));
  scheduler.cron('brief-regen', '08:00', ET, async () => { await regenerateMorning(deps, clock()); }, { days: [1, 2, 3, 4, 5] });
  scheduler.cron('brief-recap', hm(n.recapET, '16:30'), ET, async () => offerBrief(await generateRecap(deps, clock())), { days: [1, 2, 3, 4, 5] });
  const weekday = Math.max(0, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(n.weeklyLocal.trim().slice(0, 3).toLowerCase()));
  scheduler.cron('brief-weekly', hm(n.weeklyLocal, '18:00'), profile.timezone, async () => offerBrief(await generateWeekly(deps, clock())), { days: [weekday] });
  scheduler.cron('rule-diff', '02:30', ET, async () => { await runRuleDiff(deps, clock()); });
  scheduler.cron('base-rates', '17:15', ET, async () => { await computeBaseRates(deps, clock()); });
  scheduler.cron('calibration', '09:00', ET, async () => { await runCalibration(deps, clock()); await markRun(deps.store, 'bias.calibration', clock()); }, { days: [6] });
  scheduler.cron('refit', '09:30', ET, async () => {
    if (zoned(clock(), ET).day !== 1) return;
    await runRefit(deps, clock());
    await markRun(deps.store, 'bias.refit', clock());
  });
  await scheduler.start();

  const critical = setInterval(() => {
    void (async () => {
      try {
        if (!(await killSwitchOn(deps.store)) || inFlight) return;
        inFlight = true;
        try { await runLoop(deps, clock()); } finally { inFlight = false; }
      } catch (e) { log.error(`worker: position monitor under the kill switch failed: ${errText(e)}`); }
    })();
  }, MIN);
  critical.unref();

  if (deps.env.NODE_ENV !== 'test') {
    void (async () => {
      try {
        if (await killSwitchOn(deps.store)) return;
        const n = await backfillOnBoot(deps, clock());
        if (n > 0) log.info(`backfill: ${n} candles loaded`);
      } catch (e) { log.error(`backfill failed: ${errText(e)}`); }
    })();
  }

  return { stop: async () => { clearInterval(critical); await scheduler.stop(); } };
}
