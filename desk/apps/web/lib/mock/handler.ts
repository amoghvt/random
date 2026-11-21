/** In-browser stand-in for the API, used only when built with NEXT_PUBLIC_MOCK=1. Typed against `ApiRoutes`. */
import type { ApiRoutes, ChartView, GuardrailFiring, Ticket, TicketDraft, TicketPreview, Timeframe } from '@desk/contracts';
import * as fx from './fixtures';

type RouteKey = keyof ApiRoutes;
interface Ctx<K extends RouteKey> {
  params: Record<string, string>;
  query: Record<string, string | number | undefined>;
  body: ApiRoutes[K] extends { body: infer B } ? B : undefined;
  now: number;
}
type Handlers = { [K in Exclude<RouteKey, 'GET /api/stream' | 'POST /api/hooks/tradingview' | 'POST /api/import/tradingview-csv'>]: (c: Ctx<K>) => ApiRoutes[K]['res'] };

const state = fx.initialState();

class MockHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown, min = 3): v is string => typeof v === 'string' && v.trim().length >= min;

function preview(d: TicketDraft, now: number): TicketPreview {
  const errors: TicketPreview['errors'] = [];
  const guardrails: GuardrailFiring[] = [];
  const reason = obj(d.reason), entry = obj(d.entry), inv = obj(d.invalidation);
  const targets = Array.isArray(d.targets) ? d.targets.map(obj) : [];
  if (!d.accountId) errors.push({ field: 'accountId', message: 'Pick the account. Size comes from its rules.' });
  if (!d.instrument) errors.push({ field: 'instrument', message: 'Pick the instrument.' });
  const hasReason = (reason.kind === 'catalyst' && isText(reason.catalystId, 1)) || (reason.kind === 'structure' && isText(reason.setupEventId, 1));
  if (!hasReason) errors.push({ field: 'reason', message: 'No catalyst, no trade. Pick a catalyst or a confirmed setup.' });
  if (!isText(entry.text)) errors.push({ field: 'entry', message: 'Entry needs a trigger: a price, a time or a condition. Never “now”.' });
  else if (entry.kind === 'price' && !isNum(entry.price)) errors.push({ field: 'entry', message: 'Price trigger needs the price.' });
  else if (entry.kind === 'time' && !isText(entry.at, 10)) errors.push({ field: 'entry', message: 'Time trigger needs the time.' });
  if (targets.length !== 3 || !targets.every((t) => isNum(t.price) && isNum(t.fraction))) errors.push({ field: 'targets', message: 'Exits are written before entry: three targets with fractions.' });
  if (!isNum(inv.price) || !isText(inv.reason)) errors.push({ field: 'invalidation', message: 'One invalidation: the price and why it kills the thesis.' });
  if (!isText(d.timeStop, 10)) errors.push({ field: 'timeStop', message: 'Time stop: the latest time the thesis is still valid.' });

  const sizing = d.accountId && d.instrument ? fx.mockSizing(now, d.accountId, d.instrument, d.direction) : null;
  const cpi = fx.catalysts(now).find((c) => c.id === 'cat_cpi')!;
  if (isText(d.timeStop, 10) && Date.parse(d.timeStop) > Date.parse(cpi.scheduledAt) && d.accountId.startsWith('vest')) {
    guardrails.push({
      id: 'gf_preview_hold', ts: new Date(now).toISOString(), pattern: 'catalyst_hold', episodeKey: 'preview_hold',
      text: 'This cannot survive CPI (Oct) at any size above $18K; the catalyst trade is the branch trade at $45K after the print.',
      blocks: true, effect: 'block', trigger: { kind: 'ticket', ref: 'draft' }, evidence: {}, followUp: null,
    });
  }
  const blocked = errors.length > 0 || guardrails.some((g) => g.blocks);
  return { ok: !blocked, errors, sizing, guardrails, wouldSaveAs: blocked ? 'blocked' : 'planned', reentryCooldownUntil: null };
}

const allTickets = (now: number): Ticket[] => [...state.saved, ...fx.tickets(now)];
function ticketById(id: string, now: number): Ticket {
  const t = allTickets(now).find((x) => x.id === id);
  if (!t) throw new MockHttpError(404, 'Ticket not found');
  return t;
}
function mutateTicket(id: string, now: number, fn: (t: Ticket) => Ticket): Ticket {
  const next = fn(ticketById(id, now));
  state.saved = [next, ...state.saved.filter((x) => x.id !== id)];
  return next;
}

const handlers: Handlers = {
  'GET /api/health': () => ({ ok: true, version: 'mock', lastLoop: null, killSwitch: state.killSwitch }),
  'POST /api/auth/login': () => ({ ok: true }),
  'GET /api/now': (c) => fx.nowView(c.now, state),
  'POST /api/refresh': (c) => fx.nowView(c.now, state),
  'GET /api/catalysts': (c) => fx.catalysts(c.now),
  'GET /api/catalysts/:id': (c) => {
    const cat = fx.catalysts(c.now).find((x) => x.id === c.params.id);
    if (!cat) throw new MockHttpError(404, 'Catalyst not found');
    return cat;
  },
  'GET /api/positions': (c) => fx.positionsView(c.now, state),
  'POST /api/positions': (c) => {
    state.manual.push({
      id: `pos_manual_${state.manual.length + 1}`, accountId: c.body.accountId, ticketId: c.body.ticketId ?? null, instrument: c.body.instrument, direction: c.body.direction,
      units: c.body.units, entryPrice: c.body.entryPrice, openedAt: new Date(c.now).toISOString(), liquidationPrice: c.body.liquidationPrice ?? null, leverage: c.body.leverage ?? null,
    });
    return fx.positionsView(c.now, state);
  },
  'DELETE /api/positions/:id': (c) => {
    state.removed.add(c.params.id ?? '');
    state.manual = state.manual.filter((p) => p.id !== c.params.id);
    return fx.positionsView(c.now, state);
  },
  'PUT /api/accounts/:id/state': (c) => {
    state.balances[c.params.id ?? ''] = c.body.balance;
    const row = fx.accountRows(c.now, state).find((a) => a.rules.id === c.params.id);
    if (!row) throw new MockHttpError(404, 'Account not found');
    return row;
  },
  'GET /api/accounts': (c) => fx.accountRows(c.now, state),
  'POST /api/tickets/preview': (c) => preview(c.body, c.now),
  'POST /api/tickets': (c) => {
    const p = preview(c.body, c.now);
    if (!p.ok || !p.sizing) return { ...p, ticket: null };
    const d = c.body;
    const units = Math.min(d.units ?? p.sizing.maxUnits, p.sizing.maxUnits);
    const ticket: Ticket = {
      id: `tkt_mock_${state.saved.length + 1}`, createdAt: new Date(c.now).toISOString(), accountId: d.accountId, instrument: d.instrument, direction: d.direction,
      reason: d.reason as Ticket['reason'], entry: d.entry as Ticket['entry'], targets: d.targets as Ticket['targets'], invalidation: d.invalidation as Ticket['invalidation'], timeStop: d.timeStop as string,
      size: { engineMaxUnits: p.sizing.maxUnits, units, notionalUsd: p.sizing.notionalUsd, leverage: p.sizing.leverage, failPrice: p.sizing.failPrice },
      holdThroughCatalyst: { flag: false, catalystId: null }, status: 'planned', fills: [], overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: p.sizing, notes: d.notes,
    };
    state.saved.unshift(ticket);
    return { ...p, ticket };
  },
  'GET /api/tickets': (c) => allTickets(c.now).filter((t) => !c.query.status || t.status === c.query.status),
  'GET /api/tickets/:id': (c) => ({ ticket: ticketById(c.params.id ?? '', c.now), ledger: fx.ledger(c.now), events: fx.structureEvents(c.now).slice(2, 4) }),
  'POST /api/tickets/:id/fill': (c) => mutateTicket(c.params.id ?? '', c.now, (t) => ({ ...t, status: t.status === 'planned' || t.status === 'watch' ? 'open' : t.status, fills: [...t.fills, c.body.fill] })),
  'GET /api/tickets/:id/override-prompt': (c) => {
    const ticket = ticketById(c.params.id ?? '', c.now);
    return {
      ticket, livePnlUsd: 146, ledger: fx.ledger(c.now),
      text: 'Overrides are −$6,400 month to date across 7 instances; the last one that paid was Nov 6. Plan says one-third off at 27,000. That is 62 points away.',
    };
  },
  'POST /api/tickets/:id/override': (c) => mutateTicket(c.params.id ?? '', c.now, (t) => ({ ...t, overrides: [...t.overrides, { ts: new Date(c.now).toISOString(), kind: c.body.kind, reason: c.body.reason, pnlImpactUsd: null }] })),
  'POST /api/tickets/:id/close': (c) => mutateTicket(c.params.id ?? '', c.now, (t) => ({ ...t, status: 'closed', closedAt: c.body.ts ?? new Date(c.now).toISOString() })),
  'POST /api/tickets/:id/cancel': (c) => mutateTicket(c.params.id ?? '', c.now, (t) => ({ ...t, status: 'cancelled' })),
  'GET /api/journal': (c) => ({ ...fx.journalView(c.now, state), trades: allTickets(c.now) }),
  'POST /api/journal/notes': (c) => {
    const note = { id: `note_${state.notes.length + 1}`, ts: new Date(c.now).toISOString(), text: c.body.text, tags: c.body.tags ?? [], source: 'trader' as const };
    state.notes.unshift(note);
    return note;
  },
  'GET /api/briefs/latest': (c) => fx.brief(c.now, c.query.kind === 'recap' ? 'recap' : c.query.kind === 'weekly' ? 'weekly' : 'morning'),
  'GET /api/ask/history': (c) => (state.chat ??= fx.chatHistory(c.now)),
  'POST /api/ask': (c) => {
    const chat = (state.chat ??= fx.chatHistory(c.now));
    const ts = new Date(c.now).toISOString();
    const asOf = new Date(c.now - (c.body.checkLive ? 5_000 : 4 * 60_000)).toISOString();
    chat.push({ id: `m${chat.length + 1}`, ts, role: 'trader', text: c.body.text });
    const hold = /hold|fully/i.test(c.body.text);
    const message = {
      id: `m${chat.length + 1}`, ts, role: 'desk' as const, asOf,
      text: hold
        ? 'Plan says one-third off at 27,000; NQ is 27,062, 62 points away. Current call: Lean short NQ, 0.62, expires 15:30 ET. Kill: 15m close above 27,215.'
        : 'NQ 27,062, −0.41%. 10Y 4.95%, +9 bp in 1h. Current call: Lean short NQ, 0.62, expires 15:30 ET. Kill: 15m close above 27,215 with SOX green.',
      citations: [{ label: 'NQ 27,062', source: 'mock', asOf }, { label: '10Y 4.95%', source: 'mock', asOf }],
    };
    chat.push(message);
    const guardrails: GuardrailFiring[] = hold ? [{
      id: 'gf_chat_hold', ts, pattern: 'hold_the_winner', episodeKey: 'chat_hold_tkt_open',
      text: 'Hold-the-winner. Overrides are −$6,400 MTD across 7 instances. Take the third at 27,000.',
      blocks: false, effect: 'none', trigger: { kind: 'chat', ref: message.id }, evidence: {}, followUp: null,
    }] : [];
    return { message, guardrails, engine: 'rules' };
  },
  'GET /api/charts/:symbol': (c): ChartView => {
    const tf = (c.query.tf ?? '15m') as Timeframe;
    const symbol = c.params.symbol ?? 'NQ';
    const candles = fx.syntheticCandles(c.now, symbol, tf);
    const ema = (n: number) => {
      const k = 2 / (n + 1);
      let v = candles[0]?.c ?? 0;
      return candles.map((x) => ({ t: x.t, v: (v = x.c * k + v * (1 - k)) }));
    };
    const isNq = symbol === 'NQ';
    return {
      symbol, tf, asOf: new Date(c.now - 60_000).toISOString(), stale: false, candles, ema: { e20: ema(20), e50: ema(50), e200: ema(200) },
      levels: isNq ? fx.structureEvents(c.now) : [],
      failPrices: isNq ? [{ positionId: 'pos_vest_nq', accountId: 'vest-instant', price: 27_340 }] : [],
    };
  },
  'GET /api/notifications': (c) => fx.notifications(c.now),
  'POST /api/notifications/:id/tap': () => ({ ok: true }),
  'GET /api/push/key': () => ({ publicKey: null }),
  'POST /api/push/subscribe': () => ({ ok: true }),
  'POST /api/push/test': () => ({ ok: true, sent: 0 }),
  'GET /api/profile': () => fx.profile(state),
  'PUT /api/profile': (c) => {
    state.memos = c.body.memos;
    return fx.profile(state);
  },
  'GET /api/admin/kill': () => ({ killSwitch: state.killSwitch }),
  'POST /api/admin/kill': (c) => {
    state.killSwitch = c.body.on;
    return { killSwitch: state.killSwitch };
  },
};

export async function mockApi(route: string, opts: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown }): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  const handler = (handlers as Record<string, ((c: Ctx<RouteKey>) => unknown) | undefined>)[route];
  if (!handler) throw new MockHttpError(404, `No mock for ${route}`);
  // JSON round trip: callers get plain data they cannot mutate into the mock state, as over HTTP.
  const out = handler({ params: opts.params ?? {}, query: opts.query ?? {}, body: opts.body as never, now: Date.now() });
  return JSON.parse(JSON.stringify(out)) as unknown;
}
