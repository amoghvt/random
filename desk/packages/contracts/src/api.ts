/**
 * HTTP contract between apps/api and apps/web. The UI never computes a size or a call;
 * it renders these views. All routes are under /api and require the session cookie
 * (POST /api/auth/login) except /api/health and /api/hooks/*.
 */
import type {
  AccountRules, AccountState, BiasCall, Brief, CalibrationBucket, Candle, Catalyst, ChatMessage, GuardrailFiring,
  HedgeViolation, Headline, JournalNote, Notification, OverrideLedger, Position, PositionStatus, Profile, Quote,
  SizingResult, StructureEvent, Ticket, TicketDraft, Timeframe, WatcherUpdate, BaseRate, Fill, OverrideKind,
} from './schemas';

export interface Stamped<T> { value: T | null; asOf: string | null; source: string | null; stale: boolean; age: string | null }

export interface RatesStrip {
  y2: Stamped<number>; y10: Stamped<number>; y30: Stamped<number>;
  /** Change in bp over 1h and 1d. */
  y2Chg1hBp: number | null; y10Chg1hBp: number | null; y2Chg1dBp: number | null; y10Chg1dBp: number | null;
  spread2s10sBp: number | null;
  fed: { hike: Stamped<number>; cut: Stamped<number>; hold: Stamped<number>; meeting: string | null };
}

export interface NowView {
  asOf: string;
  /** Intraday call for the primary instrument (NQ). */
  primary: BiasCall | null;
  /** Current calls across instruments and horizons. */
  calls: BiasCall[];
  updates: WatcherUpdate[];
  rates: RatesStrip;
  quotes: Record<string, Quote & { stale: boolean; age: string }>;
  nextCatalyst: Pick<Catalyst, 'id' | 'name' | 'tier' | 'scheduledAt' | 'consensus' | 'prior' | 'unit'> | null;
  headlines: Headline[];
  session: { killSwitch: boolean; readOnly: boolean; readOnlyReason: string | null; quietHours: boolean };
  feedHealth: Array<{ feed: string; ok: boolean; lastOk: string | null; error: string | null; live: boolean; lastPoll?: string }>;
}

export interface PositionRow { position: Position; status: PositionStatus | null; ticket: Ticket | null; nextTarget: { price: number; fraction: number } | null }
export interface AccountRow {
  rules: AccountRules; state: AccountState;
  floorUsd: number; roomUsd: number;
  payoutLine: string; consistencyLine: string | null;
  nextDeadline: { what: string; at: string } | null;
  claimableUsd: number | null;
  /** Set after a single-session gain above the firm's claim threshold. */
  claimPrompt?: string | null;
  /** Nearer-limit room after the cushion: what a ticket may risk. */
  usableUsd?: number;
  /** Why the account cannot be sized (unverified rule, no room); null when it can. */
  blockReason?: string | null;
}
export interface PositionsView { asOf: string; positions: PositionRow[]; accounts: AccountRow[]; hedgeViolations: HedgeViolation[] }

export interface TicketPreview {
  ok: boolean;
  /** Validation errors, worded as the guardrail would say them. */
  errors: Array<{ field: string; message: string }>;
  sizing: SizingResult | null;
  guardrails: GuardrailFiring[];
  /** 'watch' when a guardrail downgrades the ticket. */
  wouldSaveAs: 'planned' | 'watch' | 'blocked';
  reentryCooldownUntil: string | null;
}
export interface TicketSaveResult extends TicketPreview { ticket: Ticket | null }

export interface TicketFillBody { fill: Fill }
export interface TicketOverrideBody { kind: OverrideKind; reason: string }
export interface OverridePrompt { ticket: Ticket; livePnlUsd: number | null; ledger: OverrideLedger; text: string }

export interface JournalView {
  asOf: string;
  adherence20: number | null; adherenceCount: number;
  pnl20Usd: number | null;
  calibration: { buckets: CalibrationBucket[]; n: number; updatedAt: string | null; source: 'replay' | 'live' | 'mixed' };
  ledger: OverrideLedger;
  trades: Ticket[]; calls: BiasCall[]; events: GuardrailFiring[]; notes: JournalNote[];
  baseRates: BaseRate[];
  guardrailScorecard: Array<{ pattern: string; fired: number; complied: number; overrode: number; savedUsd: number; costUsd: number; retired: boolean }>;
}

export interface ChartView {
  symbol: string; tf: Timeframe; asOf: string | null; stale: boolean;
  candles: Candle[];
  ema: { e20: Array<{ t: number; v: number }>; e50: Array<{ t: number; v: number }>; e200: Array<{ t: number; v: number }> };
  levels: StructureEvent[];
  failPrices: Array<{ positionId: string; accountId: string; price: number }>;
}

export interface AskBody { text: string; checkLive?: boolean }
export interface AskReply { message: ChatMessage; guardrails: GuardrailFiring[]; engine: 'llm' | 'rules' }

export interface PushSubscribeBody { endpoint: string; keys: { p256dh: string; auth: string } }

export interface ManualPositionBody { accountId: string; instrument: string; direction: 'long' | 'short'; units: number; entryPrice: number; liquidationPrice?: number | null; leverage?: number | null; ticketId?: string | null }
export interface AccountStateBody { balance: number; equity?: number; active?: boolean; dayStartBalance?: number; cyclePnl?: number; bestDayPnlInCycle?: number; qualifyingDaysInCycle?: number; payoutsTaken?: number; startingBalance?: number }

export interface TradingViewWebhook { secret: string; symbol: string; tf?: Timeframe; price?: number; time?: string; o?: number; h?: number; l?: number; c?: number; v?: number; message?: string }

/** Route table. `:id` are path params. */
export interface ApiRoutes {
  'GET /api/health': { res: { ok: boolean; version: string; lastLoop: string | null; killSwitch: boolean } };
  'POST /api/auth/login': { body: { token: string }; res: { ok: boolean } };
  'GET /api/now': { res: NowView };
  'POST /api/refresh': { res: NowView };
  'GET /api/catalysts': { query: { days?: number; past?: number }; res: Catalyst[] };
  'GET /api/catalysts/:id': { res: Catalyst };
  'GET /api/positions': { res: PositionsView };
  'POST /api/positions': { body: ManualPositionBody; res: PositionsView };
  'DELETE /api/positions/:id': { res: PositionsView };
  'PUT /api/accounts/:id/state': { body: AccountStateBody; res: AccountRow };
  'GET /api/accounts': { res: AccountRow[] };
  'POST /api/tickets/preview': { body: TicketDraft; res: TicketPreview };
  'POST /api/tickets': { body: TicketDraft; res: TicketSaveResult };
  'GET /api/tickets': { query: { status?: string }; res: Ticket[] };
  'GET /api/tickets/:id': { res: { ticket: Ticket; ledger: OverrideLedger; events: StructureEvent[] } };
  'POST /api/tickets/:id/fill': { body: TicketFillBody; res: Ticket };
  'GET /api/tickets/:id/override-prompt': { res: OverridePrompt };
  'POST /api/tickets/:id/override': { body: TicketOverrideBody; res: Ticket };
  'POST /api/tickets/:id/close': { body: { price: number; ts?: string }; res: Ticket };
  'POST /api/tickets/:id/cancel': { res: Ticket };
  'GET /api/journal': { res: JournalView };
  'POST /api/journal/notes': { body: { text: string; tags?: string[] }; res: JournalNote };
  'GET /api/briefs/latest': { query: { kind: 'morning' | 'recap' | 'weekly' }; res: Brief | null };
  'GET /api/ask/history': { res: ChatMessage[] };
  'POST /api/ask': { body: AskBody; res: AskReply };
  'GET /api/charts/:symbol': { query: { tf?: Timeframe }; res: ChartView };
  'GET /api/notifications': { res: Notification[] };
  'POST /api/notifications/:id/tap': { res: { ok: boolean } };
  'GET /api/push/key': { res: { publicKey: string | null } };
  'POST /api/push/subscribe': { body: PushSubscribeBody; res: { ok: boolean } };
  'POST /api/push/test': { res: { ok: boolean; sent: number } };
  'GET /api/profile': { res: Profile };
  'PUT /api/profile': { body: Profile; res: Profile };
  'GET /api/admin/kill': { res: { killSwitch: boolean } };
  'POST /api/admin/kill': { body: { on: boolean }; res: { killSwitch: boolean } };
  'POST /api/hooks/tradingview': { body: TradingViewWebhook; res: { ok: boolean } };
  'POST /api/import/tradingview-csv': { body: { symbol: string; tf: Timeframe; csv: string }; res: { ok: boolean; bars: number } };
  /** Server-sent events: `update` (WatcherUpdate), `call` (BiasCall), `notification` (Notification), `now` (NowView). */
  'GET /api/stream': { res: never };
}
