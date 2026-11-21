import type {
  AccountRules, AccountState, Candle, Catalyst, GuardrailFiring, HedgeViolation, LaggedFact, OverrideLedger, Position,
  PositionStatus, Profile, SizingResult, StructureEvent, Ticket, TicketDraft, Direction,
} from '@desk/contracts';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { FlushState } from './flush';

/** Re-entry timer state. Computed by the tickets engine after a stop-out; the guardrail only words it. */
export interface ReentryCooldown {
  accountId?: string; instrument: string; direction: Direction;
  stoppedAt: string; until: string;
  /** True when a new catalyst or a new structure confirmation exists; the 15-minute rule then does not apply. */
  cleared: boolean;
}

/** A read the journal scored as correct ("called the Nov 6 low"). Journal-derived; never typed in here. */
export interface CorrectRead { ts: string; instrument: string; what: string; sourceId: string }

/**
 * Everything a guardrail may look at. Plain data, serializable, so a firing can be replayed.
 * Guardrails read the trader's own inputs; market facts arrive pre-computed by the other engines.
 */
export interface GuardrailContext {
  now: number;
  /** IANA zone for "local" rules (late night, the session day). */
  tz: string;
  profile: Profile;
  ledger: OverrideLedger;
  /** Recent tickets from the journal, any status. */
  tickets: Ticket[];
  positions: Array<{ position: Position; status: PositionStatus }>;
  structure: StructureEvent[];
  catalysts: Catalyst[];
  /** Keyed by price symbol (NQ for NQ, MNQ and NQ-PERP). */
  candles: { d1: Record<string, Candle[]>; m1?: Record<string, Candle[]> };
  /** From the sizing workstream's hedging detector, for the ticket being checked. */
  hedgeViolations: HedgeViolation[];
  /** Sizing engine output for the ticket being checked. */
  sizing?: SizingResult;
  laggedFacts: LaggedFact[];
  /** Firings already logged; drives once-per-episode. */
  priorFirings: GuardrailFiring[];
  /** Output of `findFlushes` per price symbol when the caller pre-computes it; otherwise derived from `candles.d1`. */
  confirmationDays?: Record<string, FlushState[]>;
  accountStates: AccountState[];
  /** Median notional of the last 20 trades; null until there are trades to take a median of. */
  medianNotional20: number | null;
  accountRules?: Array<Pick<AccountRules, 'id' | 'firm' | 'claimPromptGainPct'>>;
  reentry?: ReentryCooldown[];
  correctReads?: CorrectRead[];
  thresholds?: Partial<Thresholds>;
}

export const thresholdsOf = (ctx: GuardrailContext): Thresholds => ({ ...DEFAULT_THRESHOLDS, ...ctx.thresholds });

/** The ticket fields the rules need, from either a saved ticket or a draft. */
export interface TicketInput {
  ref: string; saved: boolean;
  accountId: string; instrument: string; direction: Direction;
  units: number | null; notionalUsd: number | null; engineMaxUnits: number | null;
  catalystId: string | null;
}
export type TicketLike = Ticket | TicketDraft;
