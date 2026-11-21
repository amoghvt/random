/** Ticket sizing: the largest size that survives the worst plausible path on one account (spec section 7). Pure. */
import {
  INSTRUMENTS, MIN, fmtNum, fmtSignedUsd, fmtUsd, hhmm, instrument, iso, ms, notionalUsd, pnlUsd,
  type AccountRules, type Catalyst, type Direction, type EventCode, type InstrumentSpec, type Position, type SizingResult,
} from '@desk/contracts';
import { accountRoom, isUnverifiedText, type AccountStateInput } from './room';
import { etLabel, inFlatWindow, nextFlatten, weekendLockAt } from './session';
import { tier1InWindow, worstPlausibleMove, type CandleSet } from './worst';

/** Smallest ticket the engine treats as tradable on notional-sized instruments (perps, stocks), USD. */
export const MIN_NOTIONAL_USD = 100;
/** Releases a news-trading ban applies to (MFFU T1 list: FOMC, FOMC minutes, employment report, CPI). */
export const NEWS_BAN_CODES: EventCode[] = ['CPI', 'CORE_CPI', 'NFP', 'UNEMPLOYMENT', 'FOMC', 'FOMC_MINUTES'];
/** Flat this long either side of a banned release. */
export const NEWS_BAN_PAD_MS = 2 * MIN;

export interface SizeRequest {
  rules: AccountRules; state: AccountStateInput;
  instrument: string; direction: Direction; price: number;
  /** Epoch ms. */
  entryAt: number; holdUntil: number; now: number;
  catalysts: Catalyst[];
  /** Set when the ticket is the catalyst's own branch trade. */
  isCatalystTrade?: { catalystId: string };
  candles: CandleSet;
  /** T1, T2, T3 prices, for the payout note. */
  targets?: number[];
  /** Open positions (any account); the ones on this account reserve room. */
  openPositions?: Position[];
}

/** The smaller contract on the same underlying that the account may trade (MNQ for NQ). */
function microOf(spec: InstrumentSpec, rules: AccountRules): InstrumentSpec | null {
  return Object.values(INSTRUMENTS).find((i) => i.kind === 'future' && i.priceSymbol === spec.symbol && i.symbol !== spec.symbol && i.pointValue < spec.pointValue && rules.instruments.includes(i.symbol)) ?? null;
}
/** maxContracts is in minis; a micro gets the point-value ratio (10 MNQ per NQ). */
function contractCap(spec: InstrumentSpec, rules: AccountRules): number | null {
  const cap = rules.leverage.maxContracts;
  if (cap === null) return null;
  const parent = INSTRUMENTS[spec.priceSymbol];
  return parent && parent.symbol !== spec.symbol && parent.pointValue > spec.pointValue ? cap * Math.round(parent.pointValue / spec.pointValue) : cap;
}
function branchTradeText(c: Catalyst): string {
  const b = [...(c.matrix?.branches ?? [])].filter((x) => x.trade !== null).sort((x, y) => y.probability - x.probability)[0];
  return b?.trade ? `${b.trade.direction} ${b.trade.instrument}, ${b.trade.entry.text}` : 'not written yet (no matrix branch with a trade)';
}
const plural = (n: number, word: string): string => `${['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n)} more ${word}${n === 1 ? '' : 's'}`;

/** Consistency and payout implication of a win of `winUsd` today (and `win3Usd` at T3). */
export function payoutNote(rules: AccountRules, state: AccountStateInput, winUsd: number, win3Usd?: number): string {
  const p = rules.payout;
  const day = state.dayPnl + winUsd;
  const sessionPct = state.dayStartBalance > 0 ? ((state.dayPnl + (win3Usd ?? winUsd)) / state.dayStartBalance) * 100 : 0;
  const claim = rules.claimPromptGainPct !== null && sessionPct > rules.claimPromptGainPct ? ` A full target is a +${sessionPct.toFixed(0)}% session: claim before the next catalyst.` : '';
  if (p.consistencyPct === null) {
    if (isUnverifiedText(p.text)) return `A ${fmtSignedUsd(day)} day at T1; payout rules for ${rules.name} are unverified, confirm in the firm dashboard.`;
    const terms = p.bufferUsd !== null ? `no consistency limit, claimable above the ${fmtUsd(p.bufferUsd)} buffer` : 'claimable the same day, no cap and no schedule';
    return `A ${fmtSignedUsd(day)} day at T1: ${terms}.${claim}`;
  }
  const share = (dayPnl: number, win: number): number | null => {
    const cycle = state.cyclePnl + win;
    return cycle > 0 ? (Math.max(state.bestDayPnlInCycle, dayPnl) / cycle) * 100 : null;
  };
  const s1 = share(day, winUsd);
  if (s1 === null) return `A ${fmtSignedUsd(day)} day today leaves the cycle at ${fmtSignedUsd(state.cyclePnl + winUsd)}; nothing to request.`;
  let action: string;
  if (s1 > p.consistencyPct) {
    const need = Math.max(state.bestDayPnlInCycle, day) / (p.consistencyPct / 100) - (state.cyclePnl + winUsd);
    action = `over the ${p.consistencyPct}% limit, needs ${fmtSignedUsd(need)} on other days before a request`;
  } else {
    const left = p.qualifyingDays === null ? 0 : Math.max(0, p.qualifyingDays - state.qualifyingDaysInCycle - (day > 0 ? 1 : 0));
    action = left > 0 ? `request after ${plural(left, 'green day')}` : `inside the ${p.consistencyPct}% limit, request is open`;
  }
  let text = `A ${fmtSignedUsd(day)} day today puts your best day at ${s1.toFixed(0)}% of this cycle; ${action}.`;
  if (win3Usd !== undefined) {
    const s3 = share(state.dayPnl + win3Usd, win3Usd);
    if (s3 !== null) text += ` T3 (${fmtSignedUsd(state.dayPnl + win3Usd)}) puts it at ${s3.toFixed(0)}%.`;
  }
  return text + claim;
}

export function sizeTrade(req: SizeRequest): SizingResult {
  const { rules, state, now, price, entryAt, holdUntil } = req;
  const spec = instrument(req.instrument);
  const futures = spec.pointValue > 0;
  const room = accountRoom(rules, state, now);
  const worst = worstPlausibleMove({ instrument: req.instrument, price, entryAt, holdUntil, now, catalysts: req.catalysts, candles: req.candles, rules });
  const blocks: string[] = [];
  const notes: string[] = [...room.notes];
  const firm = rules.firm;

  if (!state.active) blocks.push(`${rules.name} has no live numbers. Enter balance and equity before sizing.`);
  if (room.blockReason) blocks.push(room.blockReason);
  if (!rules.instruments.includes(req.instrument)) blocks.push(`${req.instrument} is not on file for ${rules.name}.`);

  // Session rules.
  const lock = weekendLockAt(rules, req.instrument, entryAt);
  const lockText = rules.session.weekendLock;
  if (lock?.inside && lockText) blocks.push(`No new ${req.instrument} during the ${firm} weekend lock (${lockText.fromET} to ${lockText.toET} ET). Lock lifts ${etLabel(lock.to)}.`);
  const flat = nextFlatten(rules, entryAt);
  if (inFlatWindow(rules, entryAt)) blocks.push(`${rules.name}: session is shut. Flat by ${rules.session.flattenByET} ET, no entries until the 18:00 ET reopen.`);
  else if (flat !== null && holdUntil > flat) blocks.push(`${rules.name}: hold to ${etLabel(holdUntil)} runs through the ${rules.session.flattenByET} ET flatten. Set the time stop at or before ${hhmm(flat)} ET.`);

  // Prohibited practices.
  const newsBan = rules.prohibited.find((r) => r.rule === 'news_trading');
  if (newsBan) {
    const hit = tier1InWindow(req.catalysts, req.instrument, entryAt - NEWS_BAN_PAD_MS, holdUntil + NEWS_BAN_PAD_MS).find((c) => NEWS_BAN_CODES.includes(c.code));
    if (hit) blocks.push(`${rules.name} bans news trading and ${hit.name} at ${hhmm(ms(hit.scheduledAt))} ET is inside the window. Flat 2 minutes either side. Clause: "${newsBan.clause}"`);
  }
  const scalp = rules.prohibited.find((r) => r.rule === 'micro_scalping' && r.minHoldSec !== undefined);
  if (scalp?.minHoldSec !== undefined && holdUntil - entryAt < scalp.minHoldSec * 1000) blocks.push(`${firm}: a ${Math.round((holdUntil - entryAt) / 1000)}s hold is under the ${scalp.minHoldSec}s micro-scalp line.`);
  if (rules.prohibited.some((r) => r.rule === 'stop_entry_orders')) notes.push(`No stop-entry orders on ${firm}: the trigger needs a limit or a manual fill.`);

  // Room left after what is already open on this account (no credit for offsetting positions).
  const measured = !Number.isNaN(worst.pct) && worst.pct > 0;
  if (!measured) blocks.push(worst.text);
  const mine = (req.openPositions ?? []).filter((p) => p.accountId === rules.id);
  const reserveUsd = measured ? mine.reduce((s, p) => s + notionalUsd(p.instrument, p.units, instrument(p.instrument).priceSymbol === spec.priceSymbol ? price : p.entryPrice) * (worst.pct / 100), 0) : 0;
  const usableUsd = Math.max(0, room.usableUsd - reserveUsd);
  const rawUsd = usableUsd / (1 - room.cushionPct / 100);
  if (reserveUsd > 0) notes.push(`Open positions on ${rules.name} already hold ${fmtUsd(reserveUsd)} of room on this worst case; ${fmtUsd(usableUsd)} left.`);

  // Size = room / worst move.
  let maxUnits = 0, notional = 0, failDistancePts: number | null = null;
  const micro = futures ? microOf(spec, rules) : null;
  const fitText = (movePts: number): string => {
    if (!futures) return `${fmtUsd(usableUsd / (movePts / price))} notional`;
    const n = Math.floor(usableUsd / (movePts * spec.pointValue));
    if (n >= 1 || !micro) return `${n} ${spec.symbol}`;
    return `${Math.floor(usableUsd / (movePts * micro.pointValue))} ${micro.symbol}`;
  };
  if (measured) {
    if (futures) {
      const lossPer = worst.pts * spec.pointValue;
      maxUnits = Math.floor(usableUsd / lossPer);
      const cap = contractCap(spec, rules);
      if (cap !== null && maxUnits > cap) { maxUnits = cap; notes.push(`Capped at ${cap} ${spec.symbol} by the ${rules.name} contract limit.`); }
      if (maxUnits === 0 && micro) notes.push(`0 ${spec.symbol}; ${Math.floor(usableUsd / (worst.pts * micro.pointValue))} ${micro.symbol} fits.`);
      notional = notionalUsd(req.instrument, maxUnits, price);
      failDistancePts = maxUnits > 0 ? rawUsd / (maxUnits * spec.pointValue) : null;
    } else {
      notional = Math.floor(usableUsd / (worst.pct / 100));
      const cap = rules.leverage.caps[req.instrument];
      if (cap !== undefined && state.equity > 0 && notional > cap * state.equity) { notional = Math.floor(cap * state.equity); notes.push(`Capped at ${cap}x by the ${firm} ${req.instrument} leverage cap.`); }
      maxUnits = notional;
      failDistancePts = notional > 0 ? (rawUsd / notional) * price : null;
    }
  }

  // Tier-1 catalyst inside the window.
  const cat = worst.catalyst;
  const isCatTrade = cat !== null && req.isCatalystTrade?.catalystId === cat.id;
  if (cat && measured) {
    const when = `${hhmm(ms(cat.scheduledAt))} ET`;
    if (cat.impliedMovePct === null) {
      if (isCatTrade) notes.push(`${cat.name} has no implied move on file: sized on the window p95 only.`);
      else blocks.push(`${cat.name} at ${when} is inside the window with no implied move on file. Flat before it or wait for the number.`);
    } else {
      const impliedPts = (cat.impliedMovePct / 100) * price;
      const lossAtMin = futures ? impliedPts * spec.pointValue : MIN_NOTIONAL_USD * (cat.impliedMovePct / 100);
      const x = fitText(impliedPts);
      if (lossAtMin > usableUsd && !isCatTrade) blocks.push(`This cannot survive ${cat.name} at any size above ${x}; the catalyst trade is ${branchTradeText(cat)} at ${x}.`);
      else if (isCatTrade) notes.push(`Catalyst trade: ${x} survives the ${cat.impliedMovePct.toFixed(2)}% implied move of ${cat.name} at ${when}.`);
      else notes.push(`${cat.name} at ${when} is inside the window; the size carries its ${cat.impliedMovePct.toFixed(2)}% implied move.`);
    }
  }
  if (rules.leverage.eventCutText) {
    const ev = tier1InWindow(req.catalysts, req.instrument, Math.min(now, entryAt), holdUntil)[0];
    if (ev) notes.push(`${firm} cuts leverage around ${ev.name}; the cut lifts ${hhmm(ms(ev.scheduledAt) + MIN)} ET. Cut size is not on file: check the cap before entry.`);
  }
  if (rules.markDivergencePts) notes.push(`The ${room.cushionPct}% cushion covers ${firm} marks ${rules.markDivergencePts[0]} to ${rules.markDivergencePts[1]} pts off CME.`);

  if (blocks.length === 0 && (futures ? maxUnits < 1 : notional < MIN_NOTIONAL_USD)) {
    const least = futures ? `one ${spec.symbol} (${fmtUsd(worst.pts * spec.pointValue)})` : `a ${fmtUsd(MIN_NOTIONAL_USD)} ticket`;
    const alt = notes.find((n) => n.startsWith(`0 ${spec.symbol};`));
    blocks.push(`Room ${fmtUsd(usableUsd)} is under ${least} on a ${fmtNum(worst.pts, 0)}-pt worst case.${alt ? ` ${alt}` : ''}`);
  }

  const blocked = blocks.length > 0;
  if (blocked) { for (const b of blocks.slice(1)) notes.unshift(`Also: ${b}`); maxUnits = 0; notional = 0; failDistancePts = null; }
  const sign = req.direction === 'long' ? -1 : 1;
  const leverage = !blocked && state.equity > 0 ? notional / state.equity : null;
  const targets = req.targets ?? [];
  const win = (target: number | undefined): number | undefined => (target === undefined || blocked ? undefined : pnlUsd(req.instrument, maxUnits, price, target, req.direction));
  const win1 = win(targets[0]);

  return {
    accountId: rules.id, instrument: req.instrument, direction: req.direction, asOf: iso(now),
    blocked, blockReason: blocks[0] ?? null,
    maxUnits, notionalUsd: notional, leverage,
    failPrice: failDistancePts === null ? null : price + sign * failDistancePts,
    failDistancePts, failDistancePct: failDistancePts === null ? null : (failDistancePts / price) * 100,
    worstMove: { pct: measured ? worst.pct : 0, pts: measured ? worst.pts : 0, basis: worst.basis, text: worst.text },
    room: { toDrawdownUsd: room.toDrawdownUsd, toDailyLimitUsd: room.toDailyLimitUsd, usableUsd, cushionPct: room.cushionPct, binding: room.binding },
    catalystInWindow: cat ? { id: cat.id, name: cat.name, impliedMovePct: cat.impliedMovePct } : null,
    notes,
    payoutNote: win1 === undefined ? null : payoutNote(rules, state, win1, win(targets[2])),
    inputs: {
      price, entryAt: iso(entryAt), holdUntil: iso(holdUntil), now: iso(now), isCatalystTrade: req.isCatalystTrade ?? null, targets,
      state, rulesSource: rules.source, floorUsd: Number.isNaN(room.floorUsd) ? null : room.floorUsd, unverified: room.unverified, reserveUsd,
      worst: { windowMin: worst.windowMin, ...worst.components },
      catalystIds: req.catalysts.map((c) => c.id), openPositionIds: (req.openPositions ?? []).map((p) => p.id),
      candles: Object.fromEntries(Object.entries(req.candles).map(([k, cs]) => [k, { n: cs.length, lastT: cs.length ? iso(cs[cs.length - 1]!.t) : null, source: cs[0]?.source ?? null }])),
    },
  };
}

/** The trader may size down, never up. Returns the units the ticket may carry: 0 when blocked, whole contracts for futures. */
export function clampUnits(requested: number | undefined, result: SizingResult): number {
  if (result.blocked) return 0;
  if (requested === undefined || !Number.isFinite(requested)) return result.maxUnits;
  const units = Math.max(0, Math.min(requested, result.maxUnits));
  return instrument(result.instrument).pointValue > 0 ? Math.floor(units) : units;
}
