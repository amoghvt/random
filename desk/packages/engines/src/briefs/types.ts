/** Inputs to the brief and Ask builders. Everything is precomputed by other engines and passed in. */
import type {
  AccountRow, BiasCall, CalibrationBucket, Catalyst, Datum, GuardrailFiring, Headline, Notification, OverrideLedger,
  MemoryHit, Position, PositionStatus, Profile, Quote, RatesStrip, RuleDiff, StructureEvent, Ticket,
} from '@desk/contracts';

export interface PositionLine { position: Position; status: PositionStatus | null; ticket: Ticket | null }

export interface MorningCtx {
  now: number;
  profile: Profile;
  /** Current calls across instruments and horizons. */
  calls: BiasCall[];
  /** Latest quotes keyed by symbol (N225, HSI, DAX, FTSE, DXY, CL, BTC, VIX, NQ, ...). */
  quotes: Record<string, Quote>;
  rates: RatesStrip | null;
  /** NQ fair value when a feed supplies one; without it the brief compares to the prior close and says so. */
  nqFairValue?: Datum | null;
  catalysts: Catalyst[];
  positions: PositionLine[];
  /** Planned and watch tickets not yet open. */
  tickets: Ticket[];
  accounts: AccountRow[];
  /** Firm-rule diffs detected since the last brief. */
  ruleDiffs: RuleDiff[];
  headlines: Headline[];
  /** Notifications held during quiet hours, released with the brief. */
  heldOvernight?: Notification[];
}

export interface RecapCtx {
  now: number;
  profile: Profile;
  /** The day's calls, with `outcome` set where resolved. */
  calls: BiasCall[];
  quotes: Record<string, Quote>;
  /** Catalysts resolved today. */
  resolved: Catalyst[];
  /** Tickets closed today (adherence and overrides are read from them). */
  closedTickets: Ticket[];
  ledger: OverrideLedger | null;
  /** As-of of the journal aggregates (ledger, adherence). */
  journalAsOf: string;
  tomorrow: Catalyst[];
}

export type GuardrailScoreRow = { pattern: string; fired: number; complied: number; overrode: number; savedUsd: number; costUsd: number; retired: boolean };

export interface WeeklyCtx {
  now: number;
  profile: Profile;
  calibration: { buckets: CalibrationBucket[]; n: number; updatedAt: string | null; source: string };
  ledger: OverrideLedger | null;
  /** Trade counts behind the two capture figures, when the journal supplies them. */
  captureCounts?: { plan: number; override: number };
  scorecard: GuardrailScoreRow[];
  /** The week's calls with outcomes. */
  calls: BiasCall[];
  /** The week's catalysts, for the catalyst type of each call. */
  catalysts: Catalyst[];
  /** The week's guardrail firings. */
  firings: GuardrailFiring[];
  journalAsOf: string;
  nextWeek: Catalyst[];
  /** Weight changes proposed by the bias engine's re-fit, with the evidence. */
  weightChanges?: Array<{ factor: string; from: number; to: number; evidence: string }>;
  /** Minutes blocked around a Tier-1 release. Default 60 before (the T-60 alert), 45 after (first move not trusted). */
  tier1Window?: { beforeMin: number; afterMin: number };
}

export type { MemoryHit } from '@desk/contracts';

export interface AskCtx {
  now: number;
  profile: Profile;
  calls: BiasCall[];
  rates: RatesStrip | null;
  quotes: Record<string, Quote>;
  /** Upcoming and live catalysts, soonest first or not; sorted here. */
  catalysts: Catalyst[];
  positions: PositionLine[];
  accounts: AccountRow[];
  headlines: Headline[];
  ledger: OverrideLedger | null;
  journalAsOf?: string;
  /** Chart-watcher events; a confirmed setup is the only structure signal that creates an edge. */
  structure?: StructureEvent[];
  memoryHits: MemoryHit[];
}
