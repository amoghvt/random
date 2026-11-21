/** Test fixtures only (reads profile.yaml from disk; not imported by engine code). Everything built here is synthetic unless a test loads recorded candles. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  ET, Profile, fromZoned, iso,
  type AccountState, type Catalyst, type GuardrailFiring, type OverrideLedger, type Position, type PositionStatus, type SizingResult,
  type StructureEvent, type Ticket, type TicketDraft,
} from '@desk/contracts';
import type { GuardrailContext } from './context';

export const PROFILE: Profile = Profile.parse(parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../profile.yaml'), 'utf8')));

/** Epoch ms of an ET wall-clock time. */
export const et = (y: number, m: number, d: number, hh = 0, mm = 0): number => fromZoned(y, m, d, hh, mm, ET);

export const EMPTY_LEDGER: OverrideLedger = { monthToDateUsd: 0, instances: 0, lastPaidAt: null, planCapturePct: null, overrideCapturePct: null };
export const syntheticLedger: OverrideLedger = { monthToDateUsd: -6400, instances: 7, lastPaidAt: '2026-11-06T15:00:00.000Z', planCapturePct: 61, overrideCapturePct: 23 };

export function makeCtx(now: number, over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    now, tz: PROFILE.timezone, profile: PROFILE, ledger: syntheticLedger, tickets: [], positions: [], structure: [], catalysts: [],
    candles: { d1: {} }, hedgeViolations: [], laggedFacts: [], priorFirings: [], accountStates: [], medianNotional20: null, ...over,
  };
}

export function syntheticDraft(over: Partial<TicketDraft> = {}): TicketDraft {
  return {
    accountId: 'mffu-builder-50k', instrument: 'NQ', direction: 'long',
    reason: { kind: 'structure', setupEventId: 'se_synthetic' }, entry: { kind: 'condition', text: 'reclaim of the 15m swing high' },
    targets: [], invalidation: {}, timeStop: '', ...over,
  };
}

export function syntheticSizing(over: Partial<SizingResult> = {}): SizingResult {
  return {
    accountId: 'mffu-builder-50k', instrument: 'NQ', direction: 'long', asOf: '2026-11-17T15:59:00.000Z', blocked: false, blockReason: null,
    maxUnits: 8, notionalUsd: 8 * 20 * 27000, leverage: null, failPrice: 26800, failDistancePts: 200, failDistancePct: 0.74,
    worstMove: { pct: 0.6, pts: 162, basis: 'p95_window', text: 'synthetic' },
    room: { toDrawdownUsd: 2000, toDailyLimitUsd: null, usableUsd: 1600, cushionPct: 20, binding: 'drawdown' },
    catalystInWindow: null, notes: [], payoutNote: null, inputs: { synthetic: true }, ...over,
  };
}

export function syntheticTicket(now: number, over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tk_synthetic', createdAt: iso(now - 3 * 3_600_000), accountId: 'mffu-builder-50k', instrument: 'NQ', direction: 'long',
    reason: { kind: 'structure', setupEventId: 'se_synthetic' }, entry: { kind: 'price', text: 'reclaim of 27,000', price: 27000 },
    size: { engineMaxUnits: 3, units: 3, notionalUsd: 3 * 20 * 27000, leverage: null, failPrice: 26900 },
    targets: [{ price: 27050, fraction: 1 / 3 }, { price: 27130, fraction: 1 / 3 }, { price: 27250, fraction: 1 / 3 }],
    invalidation: { price: 26950, reason: 'loses the reclaimed swing low' }, timeStop: iso(now + 4 * 3_600_000),
    holdThroughCatalyst: { flag: false, catalystId: null }, status: 'open', fills: [], overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: null,
    ...over,
  };
}

export function syntheticHeld(now: number, pos: Partial<Position> = {}, status: Partial<PositionStatus> = {}): { position: Position; status: PositionStatus } {
  const position: Position = { id: 'pos_synthetic', accountId: 'mffu-builder-50k', ticketId: 'tk_synthetic', instrument: 'NQ', direction: 'long', units: 3, entryPrice: 27000, openedAt: iso(now - 2 * 3_600_000), liquidationPrice: null, leverage: null, ...pos };
  return {
    position,
    status: { positionId: position.id, asOf: iso(now - 30_000), mark: 27090, pnlUsd: 5400, failPrice: 26819, distancePts: 271, distancePct: 1.0, status: 'Safe', atr1m: 14, nextLockOrSnapshot: null, catalystInWindow: null, line: 'synthetic', ...status },
  };
}

export function syntheticCatalyst(at: number, over: Partial<Catalyst> = {}): Catalyst {
  return {
    id: 'cat_synthetic_cpi', code: 'CPI', name: 'CPI', tier: 1, scheduledAt: iso(at), instruments: ['NQ', 'ES'], consensus: null, prior: null, whisper: null,
    impliedMovePct: 1.8, impliedMoveSource: 'historical', history: [], predictionOdds: [], matrix: null, status: 'upcoming', resolution: null,
    source: 'synthetic', asOf: iso(at - 86_400_000), ...over,
  };
}

export function syntheticEvent(now: number, over: Partial<StructureEvent>): StructureEvent {
  return { id: 'se_synthetic', detector: 'swing', kind: 'synthetic', instrument: 'NQ', tf: '1m', ts: iso(now - 600_000), level: null, bias: 0, confidence: 0.7, text: 'synthetic event', data: {}, confirmedSetup: false, ...over };
}

export function syntheticState(now: number, over: Partial<AccountState> = {}): AccountState {
  return { accountId: 'vest-instant', asOf: iso(now - 2 * 3_600_000), active: true, balance: 5000, equity: 5000, highWaterBalance: 5000, dayStartBalance: 5000, dayPnl: 0, cyclePnl: 0, bestDayPnlInCycle: 0, qualifyingDaysInCycle: 0, cycleStartedAt: null, payoutsTaken: 0, lastTradeAt: null, ...over };
}

/** Numbers and clock times in a firing's text that are not among the values the rule recorded as shown. */
export function inventedNumbers(f: GuardrailFiring): string[] {
  const shown = [...((f.evidence.shown as string[] | undefined) ?? []), f.evidence.repeat === true ? f.text : ''].join(' | ');
  const tokens = f.text.replace(/\b(?:T[123]|13F|20-trade|1-minute)\b/g, '').match(/\d(?:[\d,]*\d)?(?:[.:]\d+)?/g) ?? [];
  return tokens.filter((t) => !shown.includes(t));
}
