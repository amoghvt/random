/**
 * Learning loop (spec section 11): each firing is logged with what the trader did next and what it cost or saved.
 * Monthly the scorecard says which guardrails saved money, which were overridden at a cost and which fired on nothing;
 * a guardrail that fires on nothing three months running is retired. Threshold changes are proposals only.
 */
import { ET, GuardrailPattern, dayKey, fmtNum, fmtUsd, type GuardrailFiring } from '@desk/contracts';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';

export type FollowUpAction = 'complied' | 'overrode' | 'ignored';

/**
 * Attaches the outcome to a firing. `outcomeUsd` is signed from the trader's side: positive is money the flag
 * saved (complied) or the trade made anyway; negative is what going against the flag lost. Null while unknown.
 */
export function recordFollowUp(firing: GuardrailFiring, action: FollowUpAction, outcomeUsd: number | null): GuardrailFiring {
  return { ...firing, followUp: { action, outcomeUsd } };
}

type Verdict = 'saved' | 'cost' | 'nothing' | 'pending';
/** Saved: complied and it avoided a loss. Cost: overrode or ignored and lost. Nothing: resolved, and no money either way. */
export function verdict(f: GuardrailFiring): Verdict {
  const fu = f.followUp;
  if (!fu || fu.action == null || fu.outcomeUsd == null) return 'pending';
  if (fu.action === 'complied') return fu.outcomeUsd > 0 ? 'saved' : 'nothing';
  return fu.outcomeUsd < 0 ? 'cost' : 'nothing';
}

export interface ScorecardMonth { month: string; fired: number; savedUsd: number; costUsd: number; pending: number; firedOnNothing: boolean }
export interface ScorecardRow {
  pattern: GuardrailPattern;
  fired: number; complied: number; overrode: number; ignored: number; pending: number;
  savedUsd: number; costUsd: number;
  /** Resolved firings where no money was saved or lost. */
  firedOnNothing: number;
  months: ScorecardMonth[];
  /** Fired at least once and on nothing in each of the last `retireAfterMonths` complete months. */
  retired: boolean;
  asOf: string;
}

const monthOf = (ts: string | number): string => dayKey(ts, ET).slice(0, 7);
function previousMonths(now: number, n: number): string[] {
  let [y, m] = monthOf(now).split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

/** One row per pattern in the library. Repeats inside an episode are the same flag and are not counted again. */
export function scorecard(firings: GuardrailFiring[], now: number, retireAfterMonths: number = DEFAULT_THRESHOLDS.retireAfterMonths): ScorecardRow[] {
  const window = previousMonths(now, retireAfterMonths);
  return GuardrailPattern.options.map((pattern) => {
    const mine = firings.filter((f) => f.pattern === pattern && f.evidence.repeat !== true && Date.parse(f.ts) <= now);
    const byMonth = new Map<string, ScorecardMonth>();
    const row: ScorecardRow = { pattern, fired: mine.length, complied: 0, overrode: 0, ignored: 0, pending: 0, savedUsd: 0, costUsd: 0, firedOnNothing: 0, months: [], retired: false, asOf: new Date(now).toISOString() };
    for (const f of mine) {
      const key = monthOf(f.ts);
      const month = byMonth.get(key) ?? { month: key, fired: 0, savedUsd: 0, costUsd: 0, pending: 0, firedOnNothing: false };
      byMonth.set(key, month);
      month.fired += 1;
      const action = f.followUp?.action;
      if (action === 'complied') row.complied += 1;
      else if (action === 'overrode') row.overrode += 1;
      else if (action === 'ignored') row.ignored += 1;
      const v = verdict(f);
      const usd = Math.abs(f.followUp?.outcomeUsd ?? 0);
      if (v === 'saved') { row.savedUsd += usd; month.savedUsd += usd; }
      else if (v === 'cost') { row.costUsd += usd; month.costUsd += usd; }
      else if (v === 'nothing') row.firedOnNothing += 1;
      else { row.pending += 1; month.pending += 1; }
    }
    for (const month of byMonth.values()) month.firedOnNothing = month.fired > 0 && month.pending === 0 && month.savedUsd === 0 && month.costUsd === 0;
    row.months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
    row.retired = window.every((key) => byMonth.get(key)?.firedOnNothing === true);
    return row;
  });
}

/** Which threshold each pattern's sensitivity hangs on, and which way makes it fire less. */
const TUNABLE: Partial<Record<GuardrailPattern, { key: keyof Thresholds; loosen: 'up' | 'down'; integer: boolean }>> = {
  bottom_call: { key: 'bottomCallWindowHours', loosen: 'down', integer: true },
  size_creep: { key: 'sizeCreepMultiple', loosen: 'up', integer: false },
  thin_fail_price: { key: 'thinFailAtrMultiple', loosen: 'down', integer: false },
  liquidity_run: { key: 'liquidityRunRetraceMaxPct', loosen: 'down', integer: true },
  squeeze_as_strength: { key: 'squeezeEventMaxAgeMin', loosen: 'down', integer: true },
  late_night_idea: { key: 'lateNightMissesBeforeWatch', loosen: 'up', integer: true },
  research_as_permission: { key: 'laggedFactStaleDays', loosen: 'up', integer: true },
};
export const TUNING = { minResolved: 4, nothingShare: 0.6, step: 0.2 } as const;

export interface ThresholdProposal {
  pattern: GuardrailPattern;
  change: 'loosen' | 'tighten' | 'retire';
  key: keyof Thresholds | null; from: number | null; to: number | null;
  /** Numbers-first, from the scorecard. */
  reason: string;
  /** Proposals only: the trader approves them in the weekly memo. */
  requiresApproval: true;
}

function stepped(from: number, dir: 'up' | 'down', integer: boolean): number {
  const raw = dir === 'up' ? from * (1 + TUNING.step) : from * (1 - TUNING.step);
  if (!integer) return Math.round(raw * 100) / 100;
  const r = dir === 'up' ? Math.ceil(raw) : Math.floor(raw);
  return Math.max(1, r === from ? from + (dir === 'up' ? 1 : -1) : r);
}

/** Proposed threshold changes with their reasons. Nothing is applied here. */
export function tuneThresholds(rows: ScorecardRow[], thresholds: Thresholds = DEFAULT_THRESHOLDS): ThresholdProposal[] {
  const out: ThresholdProposal[] = [];
  for (const row of rows) {
    if (row.retired) {
      const months = row.months.slice(-thresholds.retireAfterMonths).map((m) => m.month).join(', ');
      out.push({ pattern: row.pattern, change: 'retire', key: null, from: null, to: null, requiresApproval: true, reason: `Fired on nothing ${thresholds.retireAfterMonths} months running (${months}): ${fmtNum(row.fired)} firings, $0 saved, $0 cost. Retire it.` });
      continue;
    }
    const knob = TUNABLE[row.pattern];
    const resolved = row.fired - row.pending;
    if (!knob || resolved < TUNING.minResolved) continue;
    const from = thresholds[knob.key];
    if (row.firedOnNothing / resolved >= TUNING.nothingShare) {
      const to = stepped(from, knob.loosen, knob.integer);
      if (to !== from) out.push({ pattern: row.pattern, change: 'loosen', key: knob.key, from, to, requiresApproval: true, reason: `${fmtNum(row.firedOnNothing)} of ${fmtNum(resolved)} resolved firings fired on nothing (saved ${fmtUsd(row.savedUsd)}, cost ${fmtUsd(row.costUsd)}). Fire less often: ${knob.key} ${from} to ${to}.` });
    } else if (row.costUsd > row.savedUsd && row.overrode + row.ignored > row.complied) {
      const to = stepped(from, knob.loosen === 'up' ? 'down' : 'up', knob.integer);
      if (to !== from) out.push({ pattern: row.pattern, change: 'tighten', key: knob.key, from, to, requiresApproval: true, reason: `Overridden or ignored ${fmtNum(row.overrode + row.ignored)} times at a cost of ${fmtUsd(row.costUsd)} against ${fmtUsd(row.savedUsd)} saved. Flag earlier: ${knob.key} ${from} to ${to}.` });
    }
  }
  return out;
}
