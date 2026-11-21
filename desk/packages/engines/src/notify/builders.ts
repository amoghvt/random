/**
 * Intent builders, one per trigger in the section-10 priority table. Each returns the three-line
 * template (fact with the number / the call or action / optional pattern flag) and the deep link.
 * A builder returns null when its trigger condition is not met, so callers can pass every candidate.
 */
import { BIAS_TEXT, NotificationIntent, fmtNum, iso, round } from '@desk/contracts';
import type {
  AccountRules, BiasCall, Brief, Catalyst, Headline, NotifyClass, Position, PositionStatus, RuleDiff,
  ScenarioBranch, StructureEvent, Ticket, TicketReason, TradePlan,
} from '@desk/contracts';
import { LINE_MAX, cap, clip, etDayTime, etTime, px, stop, tradeLines, validateTradeNotification, voiceLint } from './format';
import { POSITION_CRITICAL } from './policy';
import { instrumentKey, notificationId } from './state';

type Prefill = NonNullable<NotificationIntent['ticketPrefill']>;
type SizedPlan = TradePlan & { accountId: string; size: NonNullable<TradePlan['size']> };

/** Thrown when a trade-entry notification would reach the lock screen without everything needed to act. */
export class TradeNotificationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Trade notification is missing: ${missing.join(', ')}`);
    this.name = 'TradeNotificationError';
  }
}

interface Parts {
  class: NotifyClass; reason: string; instrument: string | null; lines: Array<string | null | undefined>;
  deepLink: string; dedupeKey: string; ts: string; ticketPrefill?: Prefill;
}
function intent(p: Parts): NotificationIntent {
  const lines = p.lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => clip(l)).slice(0, 3);
  return NotificationIntent.parse({ ...p, lines });
}
const q = (s: string): string => encodeURIComponent(s);
const isSized = (plan: TradePlan): plan is SizedPlan => typeof plan.accountId === 'string' && plan.accountId.length > 0 && plan.size !== undefined && plan.size.units > 0;

/** A trade-entry intent: fact line, then the two composed trade lines, the prefill and the ticket deep link. */
function tradeIntent(p: { class: NotifyClass; reason: string; fact: string; plan: TradePlan; ticketReason: TicketReason; dedupeKey: string; ts: string; lines?: string[] }): NotificationIntent {
  if (!isSized(p.plan)) throw new TradeNotificationError([...(p.plan.accountId ? [] : ['account']), ...(p.plan.size && p.plan.size.units > 0 ? [] : ['size'])]);
  const out = intent({
    class: p.class, reason: p.reason, instrument: p.plan.instrument, dedupeKey: p.dedupeKey, ts: p.ts,
    lines: p.lines ?? [p.fact, ...tradeLines(p.plan)],
    deepLink: `/ticket?prefill=${notificationId(p)}`,
    ticketPrefill: { ...p.plan, reason: p.ticketReason },
  });
  const check = validateTradeNotification(out);
  if (!check.ok) throw new TradeNotificationError(check.missing);
  return out;
}

/** Adds the guardrail's pattern flag as line 3, once. No-op when line 3 is already taken. */
export function withFlag(n: NotificationIntent, flag: string | null | undefined): NotificationIntent {
  return !flag || n.lines.length >= 3 ? n : { ...n, lines: [...n.lines, clip(flag)] };
}

/* ───────────────────────── P0: act now ───────────────────────── */

/** Position status Critical. The dedupe key is stable, so `decide` repeats it every 5 minutes until the status changes. */
export function positionCritical(position: Position, status: PositionStatus): NotificationIntent | null {
  if (status.status !== 'Critical') return null;
  const dist = `${px(round(Math.abs(status.distancePts), 2))} pts (${Math.abs(status.distancePct).toFixed(2)}%)`;
  const atr = status.atr1m !== null && status.atr1m > 0
    ? `Fail is ${(Math.abs(status.distancePts) / status.atr1m).toFixed(1)}x the 1m ATR (${px(round(status.atr1m, 2))} pts). ` : '';
  const window = status.catalystInWindow ? `${status.catalystInWindow.name} at ${etTime(status.catalystInWindow.at)} is inside the window.`
    : status.nextLockOrSnapshot ? `${cap(status.nextLockOrSnapshot.what)} at ${etTime(status.nextLockOrSnapshot.at)}.` : null;
  return intent({
    class: 'P0', reason: POSITION_CRITICAL, instrument: position.instrument, ts: status.asOf,
    lines: [
      `${position.instrument} ${px(status.mark)}: fail ${px(status.failPrice)} is ${dist} away. Critical on ${position.accountId}.`,
      `${atr}Cut size or close the ${position.direction}.`,
      window,
    ],
    deepLink: `/positions?id=${q(position.id)}`, dedupeKey: `${POSITION_CRITICAL}:${position.id}`,
  });
}

/**
 * A Tier-1 print resolved. `out` is the catalyst engine's live-match output: its three lines and the
 * matched branch's plan (null on a no-trade branch). Its lines are used verbatim when they already
 * show every lock-screen field; otherwise line 1 is kept and lines 2 and 3 are composed from the plan.
 * A plan with no account or size cannot be a trade entry: the read is still pushed, linked to the card.
 */
export function tier1Resolved(catalyst: Catalyst, out: { lines: string[]; plan: TradePlan | null }): NotificationIntent | null {
  if (catalyst.tier !== 1 || out.lines.length === 0) return null;
  const ts = catalyst.resolution?.resolvedAt ?? catalyst.asOf;
  const dedupeKey = `tier1_resolved:${catalyst.id}`;
  const branchId = catalyst.resolution?.branchId ?? null;
  const read = { class: 'P0' as const, reason: 'tier1_resolved', dedupeKey, ts, deepLink: `/catalysts?id=${q(catalyst.id)}` };
  if (out.plan === null) return intent({ ...read, instrument: catalyst.instruments[0] ?? null, lines: out.lines });
  if (!isSized(out.plan)) {
    return intent({ ...read, instrument: out.plan.instrument, lines: [out.lines[0], out.lines[1], 'Plan has no account or size yet. Size it on the card.'] });
  }
  const ticketReason: TicketReason = { kind: 'catalyst', catalystId: catalyst.id, ...(branchId ? { branchId } : {}) };
  const base = { class: 'P0' as const, reason: 'tier1_resolved', plan: out.plan, ticketReason, dedupeKey, ts };
  const verbatim = out.lines.slice(0, 3).map((l) => clip(l));
  if (voiceLint(verbatim).length === 0) {
    try { return tradeIntent({ ...base, fact: verbatim[0]!, lines: verbatim }); } catch (e) { if (!(e instanceof TradeNotificationError)) throw e; }
  }
  const branch = catalyst.matrix?.branches.find((b) => b.id === branchId);
  const fact = clip(out.lines[0]!);
  const labelled = branch ? `${stop(fact)} Branch: ${branch.label}.` : fact;
  return tradeIntent({ ...base, fact: labelled.length <= LINE_MAX ? labelled : fact });
}

/** A firm rule page changed (nightly diff). */
export function ruleChange(diff: RuleDiff): NotificationIntent {
  const n = diff.accountIds.length;
  return intent({
    class: 'P0', reason: 'rule_change', instrument: null, ts: diff.detectedAt,
    lines: [
      `${diff.firm} rules changed: ${diff.added.length} added, ${diff.removed.length} removed, ${n} account${n === 1 ? '' : 's'}.`,
      diff.summary,
      'Account rules update before the next session.',
    ],
    deepLink: `/positions?id=${q(diff.accountIds[0] ?? diff.firm)}`, dedupeKey: `rule_change:${diff.id}`,
  });
}

/** An impact-3 headline, only when a position is open on an instrument it tags. */
export function impact3Headline(headline: Headline, position: Position | null): NotificationIntent | null {
  if (headline.impact < 3 || position === null) return null;
  if (!headline.symbols.some((s) => instrumentKey(s) === instrumentKey(position.instrument))) return null;
  const against = headline.direction !== 0 && (headline.direction === 1) !== (position.direction === 'long');
  const read = headline.direction === 0 ? 'Direction unclear' : `Reads risk-${headline.direction === 1 ? 'on' : 'off'}, ${against ? 'against' : 'with'} the ${position.direction}`;
  return intent({
    class: 'P0', reason: 'impact3_headline', instrument: position.instrument, ts: headline.ts,
    lines: [
      `Impact 3 on ${position.instrument}: ${headline.title}`,
      `${read} on ${position.accountId}. ${against ? 'Check the invalidation now.' : 'Plan unchanged; watch the invalidation.'}`,
    ],
    deepLink: `/positions?id=${q(position.id)}`, dedupeKey: `impact3:${headline.dedupeKey}:${position.id}`,
  });
}

/** Price traded through the ticket's invalidation. */
export function ticketInvalidationHit(ticket: Ticket, price: number, now: number): NotificationIntent {
  return intent({
    class: 'P0', reason: 'ticket_invalidation', instrument: ticket.instrument, ts: iso(now),
    lines: [
      `${ticket.instrument} ${px(price)}: through invalidation ${px(ticket.invalidation.price)} on ${ticket.accountId}.`,
      `Plan says out. Close the ${ticket.direction}. Thesis broke: ${ticket.invalidation.reason}`,
    ],
    deepLink: `/positions?id=${q(ticket.id)}`, dedupeKey: `ticket_invalidation:${ticket.id}`,
  });
}

/** The ticket's time stop passed with the position still on. */
export function ticketTimeStopHit(ticket: Ticket): NotificationIntent {
  return intent({
    class: 'P0', reason: 'ticket_time_stop', instrument: ticket.instrument, ts: ticket.timeStop,
    lines: [
      `${ticket.instrument} time stop ${etTime(ticket.timeStop)} hit on ${ticket.accountId}.`,
      `Plan says flat by now. Close the ${ticket.direction}.`,
    ],
    deepLink: `/positions?id=${q(ticket.id)}`, dedupeKey: `ticket_time_stop:${ticket.id}`,
  });
}

/* ───────────────────────── P1: trade available ───────────────────────── */

/**
 * The bias call changed to Strong, or away from No edge. Anything else returns null.
 * With no previous call on record, only a Strong call notifies.
 */
export function biasChanged(prev: BiasCall | null, next: BiasCall): NotificationIntent | null {
  const strong = next.call === 'strong_long' || next.call === 'strong_short';
  const fromNoEdge = prev !== null && prev.call === 'no_edge' && next.call !== 'no_edge';
  if (prev?.call === next.call || !(strong || fromNoEdge)) return null;
  const was = prev ? `, was ${BIAS_TEXT[prev.call]} ${prev.probability.toFixed(2)}` : '';
  const t = next.trade;
  const trade = t
    ? `${cap(t.direction)} ${t.instrument}: T1 ${px(t.targets[0].price)}, invalidation ${px(t.invalidation.price)}. Entry: ${t.entry.text}`
    : `Kill: ${next.killCondition.text}`;
  return intent({
    class: 'P1', reason: strong ? 'bias_strong' : 'bias_from_no_edge', instrument: next.instrument, ts: next.createdAt,
    lines: [
      `${next.instrument} ${BIAS_TEXT[next.call]} ${next.probability.toFixed(2)}${was}. Expires ${etTime(next.expiresAt)}.`,
      trade,
      next.facts[0],
    ],
    deepLink: `/?call=${q(next.id)}`, dedupeKey: `bias:${next.id}`,
  });
}

const isCatalyst = (x: Catalyst | Ticket): x is Catalyst => 'tier' in x;

/** A ticket's time stop is an instant; the prefill wants the plan shape. */
function ticketPlan(ticket: Ticket, referencePrice: number): SizedPlan {
  return {
    instrument: ticket.instrument, direction: ticket.direction, entry: ticket.entry, referencePrice,
    targets: ticket.targets, invalidation: ticket.invalidation,
    timeStop: { at: ticket.timeStop, text: `flat by ${etTime(ticket.timeStop)}` },
    accountId: ticket.accountId,
    size: { units: ticket.size.units, notionalUsd: ticket.size.notionalUsd, leverage: ticket.size.leverage, failPrice: ticket.size.failPrice },
  };
}

/**
 * An entry trigger fired: a planned ticket's, or a catalyst branch's (pass the sized `plan`, or the
 * resolved branch's trade is used). Throws TradeNotificationError when the plan has no account or size.
 */
export function entryTriggerFired(source: Catalyst | Ticket, fired: { price: number; now: number; plan?: TradePlan }): NotificationIntent | null {
  const ts = iso(fired.now);
  if (!isCatalyst(source)) {
    return tradeIntent({
      class: 'P1', reason: 'entry_trigger', ts, dedupeKey: `entry_trigger:${source.id}`, ticketReason: source.reason,
      plan: ticketPlan(source, fired.price), fact: `${source.instrument} ${px(fired.price)}: entry trigger fired on your ${source.direction} ticket.`,
    });
  }
  const branchId = source.resolution?.branchId ?? null;
  const branch: ScenarioBranch | undefined = source.matrix?.branches.find((b) => b.id === branchId);
  const plan = fired.plan ?? branch?.trade ?? null;
  if (plan === null) return null;
  return tradeIntent({
    class: 'P1', reason: 'entry_trigger', ts, dedupeKey: `entry_trigger:${source.id}:${branchId ?? 'plan'}`, plan,
    ticketReason: { kind: 'catalyst', catalystId: source.id, ...(branchId ? { branchId } : {}) },
    fact: `${plan.instrument} ${px(fired.price)}: entry trigger fired, ${source.name}${branch ? ` branch ${branch.label}` : ''}.`,
  });
}

/**
 * A chart-watcher setup confirmed (sweep-and-reclaim with MSS) on a watchlist name. With a sized
 * `plan` it is a full trade entry; without one it links to the ticket with the setup attached.
 */
export function setupConfirmed(event: StructureEvent, watchlist: readonly string[], plan?: TradePlan): NotificationIntent | null {
  if (!event.confirmedSetup || event.bias === 0 || !['sweep_reclaim', 'mss'].includes(event.detector)) return null;
  if (!watchlist.includes(event.instrument)) return null;
  const side = event.bias === 1 ? 'long' : 'short';
  const fact = `${event.instrument} ${event.tf}: sweep-and-reclaim with MSS${event.level !== null ? ` at ${px(event.level)}` : ''}, confidence ${event.confidence.toFixed(2)}.`;
  const dedupeKey = `setup:${event.id}`;
  if (plan && isSized(plan)) {
    return tradeIntent({ class: 'P1', reason: 'setup_confirmed', ts: event.ts, dedupeKey, plan, fact, ticketReason: { kind: 'structure', setupEventId: event.id } });
  }
  return intent({
    class: 'P1', reason: 'setup_confirmed', instrument: event.instrument, ts: event.ts, dedupeKey,
    lines: [fact, `${cap(side)} setup confirmed. The ticket opens with it attached; size comes from the account.`, event.text],
    deepLink: `/ticket?prefill=${q(event.id)}`,
  });
}

/* ───────────────────────── P2: worth knowing ───────────────────────── */

const num = (x: number | null, unit?: string): string => (x === null ? 'n/a' : `${x}${unit ?? ''}`);
const branchTrade = (b: ScenarioBranch): string => (b.trade ? `${cap(b.trade.direction)} ${b.trade.instrument}` : 'no trade');

/** T-60 reminder with the matrix summary. Tier 3 is shown, not planned, so it returns null. */
export function catalystT60(catalyst: Catalyst, now: number): NotificationIntent | null {
  if (catalyst.tier === 3 || catalyst.status !== 'upcoming') return null;
  const mins = Math.round((Date.parse(catalyst.scheduledAt) - now) / 60_000);
  if (mins <= 0) return null;
  const implied = catalyst.impliedMovePct !== null ? `, implied ±${catalyst.impliedMovePct.toFixed(1)}%` : '';
  const m = catalyst.matrix;
  const top = m ? [...m.branches].sort((a, b) => b.probability - a.probability)[0] : undefined;
  return intent({
    class: 'P2', reason: 'catalyst_t60', instrument: catalyst.instruments[0] ?? null, ts: iso(now),
    lines: [
      `${catalyst.name} in ${mins} min (${etTime(catalyst.scheduledAt)}). Consensus ${num(catalyst.consensus, catalyst.unit)}, prior ${num(catalyst.prior, catalyst.unit)}${implied}.`,
      m && top
        ? `${m.branches.length} branches, ${m.branches.filter((b) => b.trade).length} with a trade. Most likely ${top.label} at ${Math.round(top.probability * 100)}%: ${branchTrade(top)}.`
        : 'No matrix yet. No edge until it prints.',
      m?.whatIWouldDo,
    ],
    deepLink: `/catalysts?id=${q(catalyst.id)}`, dedupeKey: `catalyst_t60:${catalyst.id}`,
  });
}

/** Vest weekend lock in 30 minutes. `lockAt` is the lock instant (Friday 20:00 ET). */
export function vestWeekendLockT30(account: AccountRules, lockAt: number, now: number): NotificationIntent | null {
  const lock = account.session.weekendLock;
  if (!lock) return null;
  const mins = Math.max(1, Math.round((lockAt - now) / 60_000));
  return intent({
    class: 'P2', reason: 'weekend_lock_t30', instrument: null, ts: iso(now),
    lines: [
      `${account.name}: weekend lock in ${mins} min, ${etDayTime(lockAt)}.`,
      'Non-crypto positions lock until the reopen. Flat, or sized for the weekend gap, before then.',
      lock.text,
    ],
    deepLink: `/positions?id=${q(account.id)}`, dedupeKey: `weekend_lock:${account.id}:${iso(lockAt).slice(0, 10)}`,
  });
}

/** Payout eligibility reached. `line` is the numbers-first eligibility line (amount, days, consistency). */
export function payoutEligible(account: AccountRules, line: string, now: number, cycleKey = 'open'): NotificationIntent {
  return intent({
    class: 'P2', reason: 'payout_eligible', instrument: null, ts: iso(now),
    lines: [`${account.name}: ${line}`, account.venue === 'perp' ? 'Claim it and withdraw the same day.' : 'Request the payout today.'],
    deepLink: `/positions?id=${q(account.id)}`, dedupeKey: `payout:${account.id}:${cycleKey}`,
  });
}

/** Inactivity-rule deadline inside 24 hours. `deadline` is the instant the account breaches. */
export function inactivityT24h(account: AccountRules, deadline: number, now: number): NotificationIntent | null {
  if (account.inactivityDays === null || deadline <= now) return null;
  const hours = Math.max(1, Math.round((deadline - now) / 3_600_000));
  return intent({
    class: 'P2', reason: 'inactivity_t24h', instrument: null, ts: iso(now),
    lines: [
      `${account.name}: inactivity breach in ${hours}h, ${etDayTime(deadline)}. Rule: one trade every ${account.inactivityDays} days.`,
      'One trade before the deadline keeps the account.',
    ],
    deepLink: `/positions?id=${q(account.id)}`, dedupeKey: `inactivity:${account.id}:${iso(deadline)}`,
  });
}

/** A branch's probability moved 15 points or more on prediction-market odds. Smaller shifts return null. */
export function branchProbabilityShift(catalyst: Catalyst, branch: ScenarioBranch, fromPct: number, toPct: number, now: number): NotificationIntent | null {
  const shift = Math.round(toPct - fromPct);
  if (Math.abs(shift) < 15) return null;
  return intent({
    class: 'P2', reason: 'branch_probability_shift', instrument: catalyst.instruments[0] ?? null, ts: iso(now),
    lines: [
      `${catalyst.name}: branch ${branch.label} ${Math.round(fromPct)}% to ${Math.round(toPct)}% on prediction-market odds (${shift > 0 ? '+' : '−'}${Math.abs(shift)} pts).`,
      branch.trade ? `Branch trade: ${branchTrade(branch)}, T1 ${px(branch.trade.targets[0].price)}. Entry: ${branch.trade.entry.text}` : `No trade on this branch. ${branch.noTradeReason ?? ''}`,
    ],
    deepLink: `/catalysts?id=${q(catalyst.id)}`,
    dedupeKey: `branch_shift:${catalyst.id}:${branch.id}:${Math.round(toPct / 5) * 5}`,
  });
}

/* ───────────────────────── P3: brief ───────────────────────── */

const BRIEF_NAME: Record<Brief['kind'], string> = { morning: 'Morning brief', recap: 'Post-close recap', weekly: 'Weekly review' };

/** A scheduled brief is ready: the morning brief, the post-close recap or the weekly review. */
export function briefReady(brief: Brief): NotificationIntent {
  const lead = brief.sections.find((s) => /one.?thing|call/i.test(s.key) && s.lines.length > 0) ?? brief.sections.find((s) => s.lines.length > 0);
  return intent({
    class: 'P3', reason: `brief_${brief.kind}`, instrument: null, ts: brief.ts,
    lines: [
      `${BRIEF_NAME[brief.kind]} ${brief.forDay}: ${brief.sections.length} sections, ${fmtNum(brief.wordCount)} words.`,
      lead?.lines[0],
    ],
    deepLink: `/journal?brief=${q(brief.id)}`, dedupeKey: `brief:${brief.kind}:${brief.forDay}`,
  });
}
