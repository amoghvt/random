/** Morning brief, the 08:00 ET regeneration, post-close recap, weekly review and the weekly memo proposal. */
import { DAY, ET, HOUR, KV, dayKey, fromZoned, iso, zoned, type Brief, type NotificationIntent, type Profile } from '@desk/contracts';
import { briefs as b, guardrails as g, notify, tickets as tk } from '@desk/engines';
import { applyProposedWeights, calibrationTable, currentCalls, pendingWeightChanges } from './bias';
import { lastRun, markRun, profileOf, type DeskDeps } from './context';
import { quotesWithFallback, ratesStrip } from './market';
import { notifyState } from './notify';
import { positionsView } from './positions';

/** What the overnight lines and the recap read; a symbol with nothing in the store prints as "no data". */
const BRIEF_SYMBOLS = ['NQ', 'ES', 'VIX', 'DXY', 'CL', 'GC', 'BTC', 'SOX', 'N225', 'HSI', 'DAX', 'FTSE'];
const JOB = { morning: 'brief.morning', regen: 'brief.morning_regen', recap: 'brief.recap', weekly: 'brief.weekly' } as const;

const dayStart = (now: number, tz: string): number => { const z = zoned(now, tz); return fromZoned(z.year, z.month, z.day, 0, 0, tz); };

export async function latestBrief(deps: DeskDeps, kind: Brief['kind']): Promise<Brief | null> {
  return (await deps.store.list('briefs', { status: kind, limit: 1 }))[0] ?? null;
}

export async function morningContext(deps: DeskDeps, now: number): Promise<b.MorningCtx> {
  const profile = await profileOf(deps);
  const since = (await lastRun(deps.store, JOB.morning)) ?? now - DAY;
  const [calls, quotes, rates, catalysts, view, tickets, ruleDiffs, headlines, state] = await Promise.all([
    currentCalls(deps, now), quotesWithFallback(deps, now, BRIEF_SYMBOLS), ratesStrip(deps, now),
    deps.store.list('catalysts', { since: iso(dayStart(now, profile.timezone)), until: iso(now + 2 * DAY), order: 'asc' }),
    positionsView(deps, now), deps.store.list('tickets', { status: ['planned', 'watch'] }),
    deps.store.list('rule_diffs', { since: iso(since), until: iso(now + 1) }),
    deps.store.list('headlines', { since: iso(now - DAY), until: iso(now + 1) }), notifyState(deps),
  ]);
  return {
    now, profile, calls, quotes, rates, catalysts, tickets, ruleDiffs, headlines,
    positions: view.positions.map((p) => ({ position: p.position, status: p.status, ticket: p.ticket })),
    accounts: view.accounts, heldOvernight: notify.heldForMorning(state),
  };
}

export interface BriefRun { brief: Brief; intent: NotificationIntent | null; replaced: boolean }

async function save(deps: DeskDeps, brief: Brief, job: string, now: number): Promise<void> {
  await deps.store.put('briefs', [brief]);
  await markRun(deps.store, job, now);
}

/** The morning brief. What quiet hours held overnight is listed in it and then released. */
export async function generateMorning(deps: DeskDeps, now: number): Promise<BriefRun> {
  const brief = b.morningBrief(await morningContext(deps, now));
  await save(deps, brief, JOB.morning, now);
  await deps.store.kvSet(KV.notifyState, notify.clearHeld(await notifyState(deps)));
  return { brief, intent: notify.briefReady(brief), replaced: true };
}

/** 08:00 ET: rebuilt, and stored only when something material changed since the brief already sent. */
export async function regenerateMorning(deps: DeskDeps, now: number): Promise<BriefRun> {
  const ctx = await morningContext(deps, now);
  const next = b.morningBrief(ctx);
  const day = dayKey(now, ctx.profile.timezone);
  const prev = (await deps.store.list('briefs', { status: 'morning', limit: 5 })).find((x) => x.forDay === day) ?? null;
  const replaced = b.briefChanged(prev, next);
  if (replaced) {
    if (prev && prev.id !== next.id) await deps.store.remove('briefs', prev.id);
    await deps.store.put('briefs', [next]);
  }
  await markRun(deps.store, JOB.regen, now);
  return { brief: replaced ? next : (prev as Brief), intent: null, replaced };
}

export async function generateRecap(deps: DeskDeps, now: number): Promise<BriefRun> {
  const profile = await profileOf(deps);
  const from = dayStart(now, ET);
  const weekday = zoned(now, ET).weekday;
  // Friday's "tomorrow" is Monday: the window runs through the weekend to the next session's close.
  const ahead = weekday === 5 ? 3 : weekday === 6 ? 2 : 1;
  const [calls, quotes, catalysts, tickets] = await Promise.all([
    deps.store.list('bias_calls', { since: iso(from), until: iso(now + 1), order: 'asc' }),
    quotesWithFallback(deps, now, BRIEF_SYMBOLS),
    deps.store.list('catalysts', { since: iso(from), until: iso(from + (ahead + 1) * DAY), order: 'asc' }),
    deps.store.list('tickets', { since: iso(now - 90 * DAY), until: iso(now + 1) }),
  ]);
  const brief = b.postCloseRecap({
    now, profile, calls, quotes,
    resolved: catalysts.filter((c) => c.status === 'resolved' && Date.parse(c.scheduledAt) <= now),
    closedTickets: tickets.filter((t) => t.status === 'closed' && t.closedAt !== null && Date.parse(t.closedAt) >= from),
    ledger: tickets.length ? tk.overrideLedger(tickets, now, profile.timezone) : null, journalAsOf: iso(now),
    tomorrow: catalysts.filter((c) => Date.parse(c.scheduledAt) >= from + DAY && c.tier < 3),
  });
  await save(deps, brief, JOB.recap, now);
  return { brief, intent: notify.briefReady(brief), replaced: true };
}

async function weeklyContext(deps: DeskDeps, now: number): Promise<b.WeeklyCtx> {
  const profile = await profileOf(deps);
  const week = iso(now - 7 * DAY), until = iso(now + 1);
  const [calibration, tickets, allFirings, calls, catalysts, nextWeek, weightChanges] = await Promise.all([
    calibrationTable(deps), deps.store.list('tickets', { since: iso(now - 90 * DAY), until }),
    deps.store.list('guardrail_firings', { since: iso(now - 150 * DAY), until }),
    deps.store.list('bias_calls', { since: week, until }), deps.store.list('catalysts', { since: week, until }),
    deps.store.list('catalysts', { since: iso(now), until: iso(now + 7 * DAY), order: 'asc' }), pendingWeightChanges(deps),
  ]);
  const z = zoned(now, profile.timezone);
  const cmp = tk.captureComparison(tickets, fromZoned(z.year, z.month, 1, 0, 0, profile.timezone));
  return {
    now, profile, calibration, calls, catalysts, nextWeek, weightChanges, journalAsOf: iso(now),
    ledger: tickets.length ? tk.overrideLedger(tickets, now, profile.timezone) : null,
    captureCounts: { plan: cmp.planCount, override: cmp.overrideCount },
    scorecard: g.scorecard(allFirings, now).map((r) => ({ pattern: r.pattern, fired: r.fired, complied: r.complied, overrode: r.overrode, savedUsd: r.savedUsd, costUsd: r.costUsd, retired: r.retired })),
    firings: allFirings.filter((f) => f.ts >= week),
  };
}

export type Memo = Profile['memos'][number];

/**
 * The weekly review, and the memo for profile.yaml stored on the profile as a proposal (`approved: false`).
 * A memo the trader already approved for the same week is left alone.
 */
export async function generateWeekly(deps: DeskDeps, now: number): Promise<BriefRun & { memo: Memo }> {
  const ctx = await weeklyContext(deps, now);
  const brief = b.weeklyReview(ctx);
  const memo: Memo = b.weeklyMemo(ctx);
  const stored = await deps.store.kvGet<Profile>(KV.profile);
  if (stored && !stored.memos.some((m) => m.week === memo.week && m.approved)) {
    await deps.store.kvSet<Profile>(KV.profile, { ...stored, memos: [...stored.memos.filter((m) => m.week !== memo.week), memo] });
  }
  await save(deps, brief, JOB.weekly, now);
  return { brief, intent: notify.briefReady(brief), replaced: true, memo };
}

/**
 * The trader approved a memo (optionally edited). It is marked approved on the profile, and only then do the
 * re-fitted weights it described take effect.
 */
export async function approveMemo(deps: DeskDeps, week: string, text?: string): Promise<Memo | null> {
  const stored = await deps.store.kvGet<Profile>(KV.profile);
  const memo = stored?.memos.find((m) => m.week === week);
  if (!stored || !memo) return null;
  const approved: Memo = { ...memo, text: text ?? memo.text, approved: true };
  await deps.store.kvSet<Profile>(KV.profile, { ...stored, memos: stored.memos.map((m) => (m.week === week ? approved : m)) });
  await applyProposedWeights(deps);
  return approved;
}

/** How long after its slot a missed brief is still worth writing. Past that (a restart, a fresh install) the slot is skipped, not caught up. */
const CATCH_UP_MS: Record<b.BriefSlot, number> = { morning: 6 * HOUR, morning_regen: 2 * HOUR, recap: 6 * HOUR, weekly: DAY };

/** Runs every brief whose slot has passed and has not run since. Safe to call every loop and from the cron jobs. */
export async function runDueBriefs(deps: DeskDeps, now: number): Promise<{ briefs: Brief[]; intents: NotificationIntent[] }> {
  const profile = await profileOf(deps);
  const out: { briefs: Brief[]; intents: NotificationIntent[] } = { briefs: [], intents: [] };
  const take = (r: BriefRun): void => { if (r.replaced) out.briefs.push(r.brief); if (r.intent) out.intents.push(r.intent); };
  const due = async (slot: b.BriefSlot, job: string): Promise<boolean> =>
    b.briefDue(slot, now, profile, await lastRun(deps.store, job)) && now - b.slotTime(slot, now, profile) <= CATCH_UP_MS[slot];
  if (await due('morning', JOB.morning)) take(await generateMorning(deps, now));
  if (await due('morning_regen', JOB.regen)) take(await regenerateMorning(deps, now));
  if (await due('recap', JOB.recap)) take(await generateRecap(deps, now));
  if (await due('weekly', JOB.weekly)) take(await generateWeekly(deps, now));
  return out;
}
