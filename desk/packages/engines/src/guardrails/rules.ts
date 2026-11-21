/**
 * The pattern library (spec section 11), seeded from the spec table. Every rule is a pure
 * `(input, ctx) => GuardrailFiring | null`. Text is one sentence of pattern, one of evidence, one of action;
 * every number in it comes from `ctx`, and a clause whose datum is missing is dropped, never filled in.
 */
import { DAY, HOUR, MIN, fmtNum, hhmm, inWindow, ms, type GuardrailFiring, type OverrideKind, type Position, type PositionStatus, type StructureEvent, type Ticket } from '@desk/contracts';
import { thresholdsOf, type GuardrailContext, type TicketInput } from './context';
import { fire } from './firing';
import { hoursSince, type FlushState } from './flush';
import {
  matchBottomCall, matchCrowd, matchHoldQuestion, matchLaggedKinds, matchLiquidityRun, matchOppositeSide, matchRegret,
  matchSqueezeAsStrength, matchTradeIdea, mentionedPriceSymbols,
} from './phrases';
import {
  atr1m, cap, etClock, flushesFor, fmtElapsed, fmtPctAbs, fmtPrice, fmtPts, fmtSignedPct, fmtUnits, hoursUntil, isFuture, localDay,
  localNight, num, priceSym, recentEvents, shownValues, sign, sizingFor, str, upcomingCatalysts,
} from './util';
import { captureLine, clauseQuote, countWord, fractionWord, joinAnd, ledgerClause, shortDate, signedUsd } from './voice';

type Trigger = GuardrailFiring['trigger'];
type Held = { position: Position; status: PositionStatus };
export type TicketRule = (ticket: TicketInput, ctx: GuardrailContext) => GuardrailFiring | null;
export type ChatRule = (message: string, ctx: GuardrailContext) => GuardrailFiring | null;
export type PositionRule = (held: Held, ctx: GuardrailContext) => GuardrailFiring | null;
export type SessionRule = (ctx: GuardrailContext) => GuardrailFiring[];

const chatTrigger = (ctx: GuardrailContext): Trigger => ({ kind: 'chat', ref: `chat:${ctx.now}` });
const ticketTrigger = (t: TicketInput): Trigger => ({ kind: 'ticket', ref: t.ref });

/** Positions the message is about: the ones it names, or all of them when it names none. */
function heldFor(message: string, ctx: GuardrailContext): Held[] {
  const syms = mentionedPriceSymbols(message);
  return ctx.positions.filter((p) => syms.length === 0 || syms.includes(priceSym(p.position.instrument)));
}

/* ───────────────────────── bottom_call ───────────────────────── */

function bottomCallFiring(ctx: GuardrailContext, sym: string, flush: FlushState | null, lead: string, trigger: Trigger, sizeFor: TicketInput | null, extra: Record<string, unknown>): GuardrailFiring {
  const th = thresholdsOf(ctx);
  const S = shownValues();
  const sizeWord = th.bottomCallSizeFraction === 0.25 ? 'Quarter size' : `${S(String(Math.round(th.bottomCallSizeFraction * 100)))}% size`;
  const sizing = sizeFor ? sizingFor(ctx, sizeFor.accountId, sizeFor.instrument) : undefined;
  const max = sizing?.maxUnits ?? sizeFor?.engineMaxUnits ?? null;
  const capUnits = max == null || !sizeFor ? undefined : isFuture(sizeFor.instrument) ? Math.floor(max * th.bottomCallSizeFraction) : Math.round(max * th.bottomCallSizeFraction * 100) / 100;
  const capText = capUnits !== undefined && sizeFor ? `: ${S(fmtUnits(sizeFor.instrument, capUnits))} max` : '';
  let text: string;
  let priors: FlushState[] = [];
  if (flush) {
    priors = flushesFor(ctx, sym).filter((f) => f.closeAt < flush.closeAt && f.lowUndercut).slice(-2);
    const priorClause = priors.length === 0 ? '' : priors.length === 1
      ? `; the ${S(shortDate(priors[0]!.flushDate))} flush low was undercut before one did`
      : `; the ${joinAnd(priors.map((f) => S(shortDate(f.flushDate))))} flush lows were both undercut before one did`;
    text = `${lead} ${S(fmtElapsed(hoursSince(flush, ctx.now)))} after the ${S(shortDate(flush.flushDate))} flush (${S(fmtSignedPct(flush.dropPct))}). Confirmation day hasn't printed${priorClause}. ${sizeWord} until it does${capText}.`;
  } else {
    text = `${lead} with no confirmation day on record for ${sym}. ${sizeWord} until one prints${capText}.`;
  }
  return fire(ctx, {
    pattern: 'bottom_call', episodeKey: flush ? `${sym}:${flush.flushDate}` : `${sym}:no-flush:${localDay(ctx)}`,
    text, effect: sizeFor ? 'cap_size' : 'none', capUnits, trigger,
    evidence: {
      ...extra, instrument: sym, flush, hoursSinceFlush: flush ? hoursSince(flush, ctx.now) : null, priorFlushes: priors,
      capFraction: th.bottomCallSizeFraction, engineMaxUnits: max, shown: S.all,
      definition: `Flush: daily close down ${th.flushDownPct}%+. Confirmation day: a later session that closes up and above the flush day's midpoint.`,
    },
  });
}

/** A long ticket within 24h of a 2%+ down day with no confirmation day. */
export const bottomCallTicket: TicketRule = (t, ctx) => {
  if (t.direction !== 'long') return null;
  const sym = priceSym(t.instrument);
  const flush = flushesFor(ctx, sym).at(-1);
  if (!flush || flush.confirmation) return null;
  const h = hoursSince(flush, ctx.now);
  if (h < 0 || h > thresholdsOf(ctx).bottomCallWindowHours) return null;
  return bottomCallFiring(ctx, sym, flush, `Long ${t.instrument}`, ticketTrigger(t), t, { via: 'ticket' });
};

/** "Bottom is in" and its relatives. Silent when the latest flush already has its confirmation day. */
export const bottomCallChat: ChatRule = (message, ctx) => {
  const phrase = matchBottomCall(message);
  if (!phrase) return null;
  const sym = mentionedPriceSymbols(message)[0] ?? priceSym(ctx.profile.instruments.primary[0] ?? 'NQ');
  const latest = flushesFor(ctx, sym).at(-1);
  const recent = latest && hoursSince(latest, ctx.now) <= thresholdsOf(ctx).bottomCallPhraseLookbackHours ? latest : null;
  if (recent?.confirmation) return null;
  return bottomCallFiring(ctx, sym, recent, 'Bottom call', chatTrigger(ctx), null, { via: 'phrase', phrase });
};

/* ───────────────────────── hold_the_winner ───────────────────────── */

/** A "hold"/"fully" question on an open position above T1: the plan, P&L, the ledger, points to the next scale-out. */
export const holdTheWinner: ChatRule = (message, ctx) => {
  const phrase = matchHoldQuestion(message);
  if (!phrase) return null;
  for (const { position, status } of heldFor(message, ctx)) {
    const ticket = ctx.tickets.find((t) => t.id === position.ticketId);
    if (!ticket) continue;
    const sg = sign(position.direction);
    if (sg * (status.mark - ticket.targets[0].price) < 0) continue;
    const S = shownValues();
    const done = ticket.fills.filter((f) => f.kind === 'scale_out').length;
    const next = ticket.targets[done];
    const ledger = ledgerClause(ctx.ledger);
    const pnl = `P&L is ${S(signedUsd(status.pnlUsd))} now`;
    let plan: string, action: string, distancePts: number | null = null;
    if (next) {
      distancePts = sg * (next.price - status.mark);
      plan = distancePts > 0
        ? `Exits were written before the entry: ${fractionWord(next.fraction)} off at ${S(fmtPrice(next.price))}, ${S(fmtPts(distancePts))} away.`
        : `Exits were written before the entry: ${fractionWord(next.fraction)} off at ${S(fmtPrice(next.price))}, and price is ${S(fmtPts(distancePts))} past it.`;
      action = distancePts > 0 ? 'Scale there.' : 'Take the scale-out now.';
    } else {
      plan = 'All three scale-outs are done; the plan left a runner on a trailing stop at the prior swing.';
      action = 'Trail it; nothing left to decide.';
    }
    if (ledger) S(ledger);
    return fire(ctx, {
      pattern: 'hold_the_winner', episodeKey: position.id, trigger: chatTrigger(ctx), effect: 'none',
      text: `${plan} ${pnl}${ledger ? `; ${ledger}` : ''}. ${action}`,
      evidence: {
        phrase, positionId: position.id, ticketId: ticket.id, mark: status.mark, pnlUsd: status.pnlUsd,
        plan: { targets: ticket.targets, invalidation: ticket.invalidation, timeStop: ticket.timeStop }, scaleOutsDone: done,
        nextScaleOut: next ?? null, distancePts, ledger: ctx.ledger, shown: S.all,
      },
    });
  }
  return null;
};

/* ───────────────────────── size_creep ───────────────────────── */

/** Best gain, as a percent of the account, booked inside the window on any account. */
function recentGain(ctx: GuardrailContext, windowMs: number): { accountId: string; pct: number; usd: number } | null {
  let best: { accountId: string; pct: number; usd: number } | null = null;
  for (const s of ctx.accountStates) {
    if (s.dayStartBalance <= 0) continue;
    const closed = ctx.tickets
      .filter((t) => t.accountId === s.accountId && t.result && t.closedAt && ctx.now - ms(t.closedAt) >= 0 && ctx.now - ms(t.closedAt) <= windowMs)
      .reduce((a, t) => a + (t.result?.pnlUsd ?? 0), 0);
    const day = ctx.now - ms(s.asOf) <= windowMs ? s.dayPnl : 0;
    const usd = Math.max(closed, day);
    const pct = (usd / s.dayStartBalance) * 100;
    if (!best || pct > best.pct) best = { accountId: s.accountId, pct, usd };
  }
  return best;
}

/** Notional above 1.5x the 20-trade median within 24h of a gain above 20% of the account. */
export const sizeCreep: TicketRule = (t, ctx) => {
  const th = thresholdsOf(ctx);
  const median = ctx.medianNotional20;
  if (median == null || median <= 0 || t.notionalUsd == null) return null;
  const multiple = t.notionalUsd / median;
  if (multiple <= th.sizeCreepMultiple) return null;
  const gain = recentGain(ctx, th.sizeCreepWindowHours * HOUR);
  if (!gain || gain.pct <= th.sizeCreepGainPct) return null;
  const S = shownValues();
  const max = sizingFor(ctx, t.accountId, t.instrument)?.maxUnits ?? t.engineMaxUnits;
  const head = `Size is ${S(multiple.toFixed(1))}x your 20-trade median after a ${S(fmtSignedPct(gain.pct, 0))} day.`;
  const text = max != null
    ? `${head} The engine's survivable size is ${S(fmtUnits(t.instrument, max))}. Confirm ${fmtUnits(t.instrument, max)} or lower.`
    : `${head} No survivable size is attached to this ticket yet. Run it through the sizing engine before it saves.`;
  return fire(ctx, {
    pattern: 'size_creep', episodeKey: t.ref, trigger: ticketTrigger(t), text,
    effect: max != null ? 'cap_size' : 'none', capUnits: max ?? undefined,
    evidence: { notionalUsd: t.notionalUsd, medianNotional20: median, multiple, gain, engineMaxUnits: max, requiresConfirm: true, shown: S.all },
  });
};

/* ───────────────────────── thin_fail_price ───────────────────────── */

/** Fail price within 1.5x the 1-minute ATR: Critical. Notifications own the 5-minute cadence. */
export const thinFailPrice: PositionRule = ({ position, status }, ctx) => {
  const th = thresholdsOf(ctx);
  const atr = status.atr1m ?? atr1m(ctx.candles.m1?.[priceSym(position.instrument)], ctx.now);
  if (atr == null || atr <= 0) return null;
  const multiple = Math.abs(status.distancePts) / atr;
  if (multiple > th.thinFailAtrMultiple) return null;
  const S = shownValues();
  return fire(ctx, {
    pattern: 'thin_fail_price', episodeKey: position.id, trigger: { kind: 'position', ref: position.id }, effect: 'none',
    text: `${position.instrument} ${position.direction}: fail price ${S(fmtPrice(status.failPrice))} is ${S(fmtPts(status.distancePts))} away, ${S(multiple.toFixed(1))}x the 1-minute ATR of ${S(fmtNum(atr, 1))}. Status Critical. Cut size or close; one ordinary wick reaches it.`,
    evidence: { status: 'Critical', repeatEveryMin: th.thinFailRepeatMin, positionId: position.id, failPrice: status.failPrice, distancePts: status.distancePts, atr1m: atr, atrMultiple: multiple, mark: status.mark, statusAsOf: status.asOf, shown: S.all },
  });
};

/* ───────────────────────── squeeze_as_strength ───────────────────────── */

function spikeEvidence(e: StructureEvent, S: (s: string) => string): string {
  const pts = num(e.data, 'points', 'pts', 'movePts', 'spikePts');
  const mins = num(e.data, 'minutesToRejection', 'rejectedWithinMin', 'rejectedInMin', 'minutes');
  const ratio = num(e.data, 'volumeRatio', 'volRatio');
  const volPct = num(e.data, 'volumePctOfImpulse', 'volumePct', 'volPct') ?? (ratio != null ? ratio * 100 : null);
  const impulseRaw = str(e.data, 'impulseLabel', 'impulseAt', 'impulseTs');
  const impulse = impulseRaw == null ? null : Number.isNaN(Date.parse(impulseRaw)) || impulseRaw.length < 10 ? impulseRaw : hhmm(impulseRaw);
  const parts: string[] = [];
  if (pts != null) parts.push(`${pts < 0 ? '−' : '+'}${S(fmtNum(Math.round(Math.abs(pts))))} pts`);
  if (mins != null) parts.push(`rejected within ${S(fmtNum(Math.round(mins)))} ${Math.round(mins) === 1 ? 'minute' : 'minutes'}`);
  if (volPct != null) parts.push(`volume ${S(fmtNum(Math.round(volPct)))}% of the ${impulse ? `${S(impulse)} ` : ''}impulse`);
  if (parts.length > 0) return `That candle: ${parts.join(', ')}.`;
  S(e.text);
  return `That candle, per the watcher: ${e.text.replace(/[.\s]+$/, '')}.`;
}

/** A single spike called institutional while the watcher logged it as rejected on sub-impulse volume. */
export const squeezeAsStrength: ChatRule = (message, ctx) => {
  const phrase = matchSqueezeAsStrength(message);
  if (!phrase) return null;
  const syms = mentionedPriceSymbols(message);
  const event = recentEvents(ctx, 'volume_context', syms, thresholdsOf(ctx).squeezeEventMaxAgeMin * MIN).find((e) => e.kind === 'spike_rejected');
  if (!event) return null;
  const S = shownValues();
  const evidence = spikeEvidence(event, S);
  const action = event.level != null ? `It counts after a hold above ${S(fmtPrice(event.level))}, not before.` : 'It counts after a second push on rising volume, not before.';
  return fire(ctx, {
    pattern: 'squeeze_as_strength', episodeKey: event.id, trigger: chatTrigger(ctx), effect: 'none',
    text: `${evidence} Covering, not accumulation. ${action}`,
    evidence: { phrase, eventId: event.id, eventTs: event.ts, eventData: event.data, eventText: event.text, shown: S.all },
  });
};

/* ───────────────────────── liquidity_run ───────────────────────── */

function retracePct(e: StructureEvent): number | null {
  const pct = num(e.data, 'retracePct', 'retracePercent', 'bouncePct');
  if (pct != null) return pct;
  const frac = num(e.data, 'retrace', 'retraceFraction', 'bounceFraction', 'fraction');
  return frac != null ? (frac <= 1.5 ? frac * 100 : frac) : null;
}

/** "Will run the highs" while long with the retrace under 50%: both pools and the fail price, by distance. */
export const liquidityRun: ChatRule = (message, ctx) => {
  const m = matchLiquidityRun(message);
  if (!m) return null;
  const th = thresholdsOf(ctx);
  const wanted = m.side === 'highs' ? 'long' : 'short';
  for (const { position, status } of heldFor(message, ctx)) {
    if (position.direction !== wanted) continue;
    const sym = priceSym(position.instrument);
    const maxAge = th.structureMaxAgeHours * HOUR;
    const stall = recentEvents(ctx, 'retrace_quality', [sym], maxAge).find((e) => {
      // A stall that favors the position (a held dip while long) is not the tell.
      if (e.bias === sign(position.direction)) return false;
      const r = retracePct(e);
      return r != null ? r < th.liquidityRunRetraceMaxPct : /under_50|stalled/.test(e.kind);
    });
    if (!stall) continue;
    const S = shownValues();
    const pools = recentEvents(ctx, 'liquidity_pool', [sym], maxAge).filter((e) => e.level != null);
    const above = pools.filter((e) => e.level! > status.mark).sort((a, b) => a.level! - b.level!)[0];
    const below = pools.filter((e) => e.level! < status.mark).sort((a, b) => b.level! - a.level!)[0];
    const dist = (level: number): number => (Math.abs(level - status.mark) / status.mark) * 100;
    const failDir = position.direction === 'long' ? 'down' : 'up';
    const sides: string[] = [];
    if (above) sides.push(`buy stops ${S(fmtPctAbs(dist(above.level!)))} up`);
    if (below) sides.push(`sell stops ${S(fmtPctAbs(dist(below.level!)))} down`);
    sides.push(`fail price ${S(fmtPctAbs(status.distancePct))} ${failDir}`);
    const r = retracePct(stall);
    const stalled = r != null ? `the retrace is ${S(fmtNum(Math.round(r)))}% of the leg` : 'the retrace is stalled under half the leg';
    const map = above && below ? `Liquidity sits both sides: ${sides.join(', ')}.` : `Mapped from here: ${sides.join(', ')}.`;
    return fire(ctx, {
      pattern: 'liquidity_run', episodeKey: position.id, trigger: chatTrigger(ctx), effect: 'none',
      text: `${cap(position.direction)} ${position.instrument} and ${stalled}. ${map} Order of arrival decides, not the thesis.`,
      evidence: {
        phrase: m.phrase, positionId: position.id, mark: status.mark, retraceEventId: stall.id, retracePct: r,
        buyStops: above ? { eventId: above.id, level: above.level, pct: dist(above.level!) } : null,
        sellStops: below ? { eventId: below.id, level: below.level, pct: dist(below.level!) } : null,
        failPrice: status.failPrice, failDistancePct: status.distancePct, shown: S.all,
      },
    });
  }
  return null;
};

/* ───────────────────────── hedge_the_decision ───────────────────────── */

const INDEX_SYMS = ['NQ', 'ES', 'YM', 'RTY'];
const hedgeLine = (sym: string): string => `Long and short the same ${INDEX_SYMS.includes(sym) ? 'index' : 'instrument'} is flat plus fees.`;
const HEDGE_ACTION = "Cut size or close; don't cancel the trade.";

/** Asks about the other side while holding the same instrument. */
export const hedgeTheDecisionChat: ChatRule = (message, ctx) => {
  for (const { position } of heldFor(message, ctx)) {
    const phrase = matchOppositeSide(message, position.direction);
    if (!phrase) continue;
    const sym = priceSym(position.instrument);
    return fire(ctx, {
      pattern: 'hedge_the_decision', episodeKey: position.id, trigger: chatTrigger(ctx), effect: 'none',
      text: `You're ${position.direction} ${position.instrument} and asking about the other side. ${hedgeLine(sym)} ${HEDGE_ACTION}`,
      evidence: { phrase, positionId: position.id, held: position.direction, instrument: position.instrument, shown: [] },
    });
  }
  return null;
};

/** Drafts the opposite ticket on the account that already holds the position. */
export const hedgeTheDecisionTicket: TicketRule = (t, ctx) => {
  const sym = priceSym(t.instrument);
  const held = ctx.positions.find((p) => p.position.accountId === t.accountId && priceSym(p.position.instrument) === sym && p.position.direction !== t.direction && p.position.ticketId !== t.ref);
  if (!held) return null;
  return fire(ctx, {
    pattern: 'hedge_the_decision', episodeKey: held.position.id, trigger: ticketTrigger(t), effect: 'block',
    text: `${cap(t.direction)} ${t.instrument} ticket against your open ${held.position.instrument} ${held.position.direction} on ${t.accountId}. ${hedgeLine(sym)} ${HEDGE_ACTION}`,
    evidence: { positionId: held.position.id, held: held.position.direction, ticketDirection: t.direction, accountId: t.accountId, shown: [t.accountId] },
  });
};

/* ───────────────────────── cross_account_offset ───────────────────────── */

/** Opposite exposure on another account, as found by the sizing workstream's hedging detector: blocked with the clause. */
export const crossAccountOffset: TicketRule = (t, ctx) => {
  const hit = ctx.hedgeViolations
    .filter((v) => v.accountA === t.accountId || v.accountB === t.accountId)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
  if (!hit) return null;
  const mine = hit.accountA === t.accountId;
  const other = mine ? hit.accountB : hit.accountA;
  const otherInstrument = mine ? hit.instrumentB : hit.instrumentA;
  const firm = ctx.accountRules?.find((a) => a.id === t.accountId)?.firm ?? ctx.accountRules?.find((a) => a.id === other)?.firm ?? null;
  const quote = clauseQuote(hit.clause);
  const S = shownValues();
  S(quote);
  S(t.accountId);
  S(other);
  const attributed = firm && !quote.toLowerCase().startsWith(firm.toLowerCase()) ? `${firm}: "${quote}".` : `Clause: "${quote}".`;
  return fire(ctx, {
    pattern: 'cross_account_offset', episodeKey: `${[t.accountId, other].sort().join('|')}:${priceSym(t.instrument)}:${localDay(ctx)}`,
    trigger: ticketTrigger(t), effect: 'block',
    text: `Blocked: ${t.direction} ${t.instrument} on ${t.accountId} is opposite exposure to ${otherInstrument} on ${other}. ${attributed} One direction across accounts, or one account flat.`,
    evidence: { violation: hit, otherAccount: other, firm, shown: S.all },
  });
};

/* ───────────────────────── late_night_idea ───────────────────────── */

function lateNight(ctx: GuardrailContext, syms: string[], what: string, trigger: Trigger, citedCatalystId: string | null): GuardrailFiring | null {
  const { from, to, catalystWithinHours } = ctx.profile.circuitBreakers.lateNight;
  if (!inWindow(ctx.now, from, to, ctx.tz)) return null;
  const horizon = catalystWithinHours * HOUR;
  const cited = ctx.catalysts.find((c) => c.id === citedCatalystId);
  if (cited && Math.abs(ms(cited.scheduledAt) - ctx.now) <= horizon) return null;
  const ahead = upcomingCatalysts(ctx, syms);
  if (ahead.some((c) => ms(c.scheduledAt) - ctx.now <= horizon)) return null;
  const th = thresholdsOf(ctx);
  const episodeKey = `night:${localNight(ctx)}`;
  const misses = ctx.priorFirings.filter((f) => f.pattern === 'late_night_idea' && f.episodeKey === episodeKey).length + 1;
  const S = shownValues();
  const clock = S(hhmm(ctx.now, ctx.tz));
  const within = S(fmtNum(catalystWithinHours));
  const next = ahead[0];
  const evidence = { localTime: hhmm(ctx.now, ctx.tz), tz: ctx.tz, window: { from, to }, catalystWithinHours, misses, nextCatalyst: next ? { id: next.id, name: next.name, at: next.scheduledAt } : null, symbols: syms };
  if (trigger.kind === 'ticket' && misses >= th.lateNightMissesBeforeWatch) {
    return fire(ctx, {
      pattern: 'late_night_idea', episodeKey, stage: 'watch', trigger, effect: 'downgrade_to_watch',
      text: `${countWord(misses)} asks tonight and still no scheduled catalyst inside ${within} hours. Saved as a watch, not a trade. It keeps until ${S(to)}.`,
      evidence: { ...evidence, shown: S.all },
    });
  }
  const nextClause = next ? ` Next on the calendar is ${next.name}, ${S(fmtElapsed(hoursUntil(ctx, next.scheduledAt)))} out.` : '';
  return fire(ctx, {
    pattern: 'late_night_idea', episodeKey, stage: 'ask', trigger, effect: trigger.kind === 'ticket' ? 'block' : 'none',
    text: `It's ${clock} and ${what} has no scheduled catalyst inside ${within} hours.${nextClause} Name the catalyst, or it saves as a watch.`,
    evidence: { ...evidence, shown: S.all },
  });
}

export const lateNightTicket: TicketRule = (t, ctx) => lateNight(ctx, [priceSym(t.instrument)], `this ${t.instrument} ${t.direction}`, ticketTrigger(t), t.catalystId);
export const lateNightChat: ChatRule = (message, ctx) => {
  const idea = matchTradeIdea(message);
  if (!idea) return null;
  const syms = mentionedPriceSymbols(message);
  return lateNight(ctx, syms, syms.length > 0 ? `this ${syms.join('/')} idea` : 'this idea', chatTrigger(ctx), null);
};

/* ───────────────────────── regret_loop ───────────────────────── */

/** Exit compared to a later, better price: the month's plan-capture versus override-capture, one line. */
export const regretLoop: ChatRule = (message, ctx) => {
  const phrase = matchRegret(message);
  if (!phrase) return null;
  const lastClosed = ctx.tickets.filter((t) => t.closedAt && ctx.now - ms(t.closedAt) <= 7 * DAY).sort((a, b) => ms(b.closedAt!) - ms(a.closedAt!))[0];
  const line = captureLine(ctx.ledger);
  const S = shownValues();
  if (line) S(line);
  return fire(ctx, {
    pattern: 'regret_loop', episodeKey: lastClosed ? `exit:${lastClosed.id}` : `day:${localDay(ctx)}`, trigger: chatTrigger(ctx), effect: 'none',
    text: line ?? 'No exits scored this month yet, so there is no capture number to settle it. The next size comes from the engine either way.',
    evidence: { phrase, planCapturePct: ctx.ledger.planCapturePct, overrideCapturePct: ctx.ledger.overrideCapturePct, lastClosedTicketId: lastClosed?.id ?? null, shown: S.all },
  });
};

/* ───────────────────────── research_as_permission ───────────────────────── */

const factLabel = (kind: string): string => (/13[-_ ]?f/i.test(kind) ? '13F' : cap(kind.replace(/[_-]+/g, ' ')));
const RESTATED = /\brestat|\breaffirm|\breiterat|\bexisting\b|\bpreviously announced\b|\bnot new\b/i;

/** A stale 13F, a restated buyback or "everyone is long" offered as a reason: stamp the age, ask for the catalyst. */
export const researchAsPermission: ChatRule = (message, ctx) => {
  const th = thresholdsOf(ctx);
  const kinds = matchLaggedKinds(message);
  const S = shownValues();
  for (const kind of kinds) {
    const want = kind.replace(/_/g, '');
    const syms = mentionedPriceSymbols(message);
    const facts = ctx.laggedFacts
      .filter((f) => f.kind.toLowerCase().replace(/[^a-z0-9]/g, '').includes(want))
      .sort((a, b) => Number(syms.some((s) => b.text.includes(s))) - Number(syms.some((s) => a.text.includes(s))) || ms(b.publishedAt) - ms(a.publishedAt));
    const fact = facts[0];
    const periodMs = fact ? Date.parse(fact.periodEnd) : NaN;
    if (!fact || Number.isNaN(periodMs)) {
      return fire(ctx, {
        pattern: 'research_as_permission', episodeKey: `${kind}:undated:${localDay(ctx)}`, trigger: chatTrigger(ctx), effect: 'none',
        text: `No as-of date on file for that ${factLabel(kind)}, so it isn't evidence yet. Name the catalyst.`,
        evidence: { kind, factId: fact?.id ?? null, shown: [] },
      });
    }
    const days = Math.floor((ctx.now - periodMs) / DAY);
    if (days < th.laggedFactStaleDays) continue;
    const restated = /buyback/i.test(fact.kind) && RESTATED.test(fact.text);
    const stamp = restated
      ? `${factLabel(fact.kind)} is a restatement of the ${S(shortDate(fact.periodEnd))} authorization, ${S(fmtNum(days))} days old.`
      : `${factLabel(fact.kind)} is as of ${S(shortDate(fact.periodEnd))}, ${S(fmtNum(days))} days stale.`;
    return fire(ctx, {
      pattern: 'research_as_permission', episodeKey: `fact:${fact.id}`, trigger: chatTrigger(ctx), effect: 'none',
      text: `${stamp} ${restated ? 'No new money in it.' : "That's where they were, not where they are."} Name the catalyst.`,
      evidence: { kind, factId: fact.id, periodEnd: fact.periodEnd, publishedAt: fact.publishedAt, source: fact.source, daysStale: days, restated, shown: S.all },
    });
  }
  const crowd = matchCrowd(message);
  if (!crowd) return null;
  return fire(ctx, {
    pattern: 'research_as_permission', episodeKey: `crowd:${localDay(ctx)}`, trigger: chatTrigger(ctx), effect: 'none',
    text: 'A crowd is positioning, not a catalyst. Name the catalyst.',
    evidence: { phrase: crowd, shown: [] },
  });
};

/* ───────────────────────── catalyst_hold ───────────────────────── */

/** An open position whose window crosses a Tier-1 event with implied move above room. */
export const catalystHoldPosition: PositionRule = ({ position, status }, ctx) => {
  const ticket: Ticket | undefined = ctx.tickets.find((t) => t.id === position.ticketId);
  const sym = priceSym(position.instrument);
  const inWin = status.catalystInWindow;
  const cat = inWin
    ? ctx.catalysts.find((c) => c.id === inWin.id)
    : ticket ? upcomingCatalysts(ctx, [sym]).find((c) => c.tier === 1 && ms(c.scheduledAt) <= ms(ticket.timeStop)) : undefined;
  const tier = inWin?.tier ?? cat?.tier;
  if (tier !== 1) return null;
  const id = inWin?.id ?? cat!.id, name = inWin?.name ?? cat!.name, at = inWin?.at ?? cat!.scheduledAt;
  if (ms(at) < ctx.now) return null;
  const isCatalystTrade = ticket?.reason.kind === 'catalyst' && ticket.reason.catalystId === id;
  if (isCatalystTrade && position.units <= ticket.size.engineMaxUnits) return null;
  const implied = cat?.impliedMovePct ?? null;
  const S = shownValues();
  const head = `${position.instrument} ${position.direction} is open into ${name} at ${S(etClock(at))}`;
  const base = { positionId: position.id, catalystId: id, catalystAt: at, impliedMovePct: implied, impliedMoveSource: cat?.impliedMoveSource ?? null, failDistancePct: status.distancePct, isCatalystTrade, shown: S.all };
  const trigger: Trigger = { kind: 'position', ref: position.id };
  const episodeKey = `${position.id}:${id}`;
  if (implied == null) {
    return fire(ctx, {
      pattern: 'catalyst_hold', episodeKey, stage: 'unpriced', trigger, effect: 'none',
      text: `${head} with no implied move on file; fail price is ${S(fmtPctAbs(status.distancePct))} away. Unpriced is not safe. Flat before the print, or get the implied move first.`,
      evidence: base,
    });
  }
  if (Math.abs(implied) < Math.abs(status.distancePct)) return null;
  return fire(ctx, {
    pattern: 'catalyst_hold', episodeKey, trigger, effect: 'block',
    text: `${head}: implied move ±${S(fmtPctAbs(implied))}, fail price ${S(fmtPctAbs(status.distancePct))} away. The hold is blocked. Flat before the print, or re-enter as the catalyst trade at survivable size.`,
    evidence: base,
  });
};

/** The same rule at ticket time, from the sizing result: allowed only as the catalyst trade at survivable size. */
export const catalystHoldTicket: TicketRule = (t, ctx) => {
  const sizing = sizingFor(ctx, t.accountId, t.instrument);
  const inWin = sizing?.catalystInWindow;
  if (!sizing || !inWin) return null;
  const cat = ctx.catalysts.find((c) => c.id === inWin.id);
  if (!(cat ? cat.tier === 1 : sizing.worstMove.basis === 'tier1_implied')) return null;
  const implied = inWin.impliedMovePct ?? cat?.impliedMovePct ?? null;
  const isCatalystTrade = t.catalystId === inWin.id;
  const over = t.units != null && t.units > sizing.maxUnits;
  if (isCatalystTrade && !over && !sizing.blocked) return null;
  const reaches = implied != null && sizing.failDistancePct != null && Math.abs(implied) >= Math.abs(sizing.failDistancePct);
  if (!isCatalystTrade && !reaches && !sizing.blocked) return null;
  const S = shownValues();
  const when = cat ? ` at ${S(etClock(cat.scheduledAt))}` : '';
  const numbers = [implied != null ? `implied move ±${S(fmtPctAbs(implied))}` : null, sizing.failDistancePct != null ? `fail price ${S(fmtPctAbs(sizing.failDistancePct))} away` : null].filter(Boolean).join(', ');
  const survivable = sizing.maxUnits > 0 ? ` (${S(fmtUnits(t.instrument, sizing.maxUnits))})` : '';
  const text = isCatalystTrade && over
    ? `This is the ${inWin.name} trade, but ${S(fmtUnits(t.instrument, t.units!))} is over the survivable ${S(fmtUnits(t.instrument, sizing.maxUnits))}. Blocked at that size. Take the engine's number or lower.`
    : `This ticket's window crosses ${inWin.name}${when}${numbers ? `: ${numbers}` : ''}. Blocked as a hold. Time-stop it before the print, or make it the catalyst trade at survivable size${survivable}.`;
  return fire(ctx, {
    pattern: 'catalyst_hold', episodeKey: `${t.ref}:${inWin.id}`, trigger: ticketTrigger(t), effect: 'block', text,
    evidence: { catalystId: inWin.id, impliedMovePct: implied, failDistancePct: sizing.failDistancePct, sizingBlocked: sizing.blocked, blockReason: sizing.blockReason, isCatalystTrade, units: t.units, engineMaxUnits: sizing.maxUnits, sizingAsOf: sizing.asOf, shown: S.all },
  });
};

/* ───────────────────────── circuit breakers ───────────────────────── */

const OVERRIDE_LABEL: Record<OverrideKind, string> = {
  size_up: 'size up', held_through_invalidation: 'held through invalidation', held_through_time_stop: 'held through time stop',
  skipped_scale_out: 'skipped scale-out', added_to_loser: 'added to a loser', early_exit: 'early exit', moved_stop: 'moved stop', other: 'off-plan',
};

/** Tickets that broke their plan on the local day of `now`, with the first break of each. */
export function planBreakingToday(ctx: GuardrailContext): Array<{ ticketId: string; instrument: string; kind: OverrideKind }> {
  const today = localDay(ctx);
  const isToday = (t: string): boolean => ms(t) <= ctx.now && localDayOf(ctx, t) === today;
  const out: Array<{ ticketId: string; instrument: string; kind: OverrideKind }> = [];
  for (const t of ctx.tickets) {
    const o = t.overrides.filter((x) => isToday(x.ts)).sort((a, b) => ms(a.ts) - ms(b.ts))[0];
    if (o) out.push({ ticketId: t.id, instrument: t.instrument, kind: o.kind });
    else if (t.closedAt && isToday(t.closedAt) && t.result && !t.result.followedPlan) out.push({ ticketId: t.id, instrument: t.instrument, kind: t.result.deductions[0]?.kind ?? 'other' });
  }
  return out;
}
const localDayOf = (ctx: GuardrailContext, t: string): string => localDay({ ...ctx, now: ms(t) });

/** Three plan-breaking trades in a day: read-only for the rest of the session, with the reason. */
export function circuitBreaker(ctx: GuardrailContext, trigger: Trigger = { kind: 'session', ref: `session:${localDay(ctx)}` }): GuardrailFiring | null {
  const limit = ctx.profile.circuitBreakers.planBreakingTradesPerDay;
  const breaks = planBreakingToday(ctx);
  if (breaks.length < limit) return null;
  const S = shownValues();
  const ledger = ledgerClause(ctx.ledger);
  if (ledger) S(ledger);
  if (breaks.length > 6) S(fmtNum(breaks.length));
  const list = breaks.slice(0, 4).map((b) => `${b.instrument} ${OVERRIDE_LABEL[b.kind]}`).join(', ');
  return fire(ctx, {
    pattern: 'circuit_breaker', episodeKey: `day:${localDay(ctx)}`, trigger, effect: 'read_only',
    text: `${countWord(breaks.length)} plan-breaking trades today: ${list}${breaks.length > 4 ? ' and more' : ''}. ${ledger ? `${cap(ledger)}. ` : ''}Desk is read-only for the rest of the session; it reopens tomorrow.`,
    evidence: { limit, count: breaks.length, breaks, ledger: ctx.ledger, shown: S.all },
  });
}
export const circuitBreakerTicket: TicketRule = (t, ctx) => circuitBreaker(ctx, ticketTrigger(t));

/** A single-session gain above 30% of a Vest account: claim before the next catalyst. */
export function claimPrompts(ctx: GuardrailContext): GuardrailFiring[] {
  const out: GuardrailFiring[] = [];
  for (const s of ctx.accountStates) {
    const rules = ctx.accountRules?.find((a) => a.id === s.accountId);
    const isVest = /vest/i.test(rules?.firm ?? s.accountId);
    const limit = rules?.claimPromptGainPct ?? (isVest ? ctx.profile.circuitBreakers.vestClaimGainPct : null);
    if (limit == null || !s.active || s.dayStartBalance <= 0) continue;
    const pct = (s.dayPnl / s.dayStartBalance) * 100;
    if (pct <= limit) continue;
    const S = shownValues();
    S(s.accountId);
    const next = upcomingCatalysts(ctx)[0];
    const nextLine = next ? `Next catalyst is ${next.name} at ${S(etClock(next.scheduledAt))}, ${S(fmtElapsed(hoursUntil(ctx, next.scheduledAt)))} out. Claim before it.` : 'Claim before the next catalyst.';
    out.push(fire(ctx, {
      pattern: 'claim_prompt', episodeKey: `${s.accountId}:${localDay(ctx)}`, trigger: { kind: 'session', ref: s.accountId }, effect: 'none',
      text: `${s.accountId} is up ${S(fmtSignedPct(pct, 0))} this session (${S(signedUsd(s.dayPnl))}). ${nextLine}`,
      evidence: { accountId: s.accountId, gainPct: pct, dayPnl: s.dayPnl, dayStartBalance: s.dayStartBalance, limitPct: limit, stateAsOf: s.asOf, nextCatalyst: next ? { id: next.id, name: next.name, at: next.scheduledAt } : null, shown: S.all },
    }));
  }
  return out;
}

/** The 15-minute rule after a stop-out. The timer is the tickets engine's; this only words it and blocks. */
export const reentryCooldown: TicketRule = (t, ctx) => {
  const cd = (ctx.reentry ?? []).find((r) => !r.cleared && priceSym(r.instrument) === priceSym(t.instrument) && r.direction === t.direction && (!r.accountId || r.accountId === t.accountId) && ms(r.stoppedAt) <= ctx.now && ms(r.until) > ctx.now);
  if (!cd) return null;
  const S = shownValues();
  const ago = S(fmtElapsed((ctx.now - ms(cd.stoppedAt)) / HOUR));
  const left = S(fmtElapsed((ms(cd.until) - ctx.now) / HOUR));
  return fire(ctx, {
    pattern: 'reentry_cooldown', episodeKey: `${priceSym(t.instrument)}:${t.direction}:${cd.stoppedAt}`, trigger: ticketTrigger(t), effect: 'block',
    text: `Stopped out of ${t.instrument} ${t.direction} ${ago} ago. Same instrument, same direction reopens in ${left}. Sooner only with a new catalyst or a new structure confirmation.`,
    evidence: { cooldown: cd, cooldownMin: ctx.profile.circuitBreakers.reentryCooldownMin, shown: S.all },
  });
};

export const TICKET_RULES: TicketRule[] = [circuitBreakerTicket, crossAccountOffset, catalystHoldTicket, reentryCooldown, hedgeTheDecisionTicket, lateNightTicket, bottomCallTicket, sizeCreep];
export const CHAT_RULES: ChatRule[] = [bottomCallChat, holdTheWinner, squeezeAsStrength, liquidityRun, hedgeTheDecisionChat, regretLoop, researchAsPermission, lateNightChat];
export const POSITION_RULES: PositionRule[] = [thinFailPrice, catalystHoldPosition];
