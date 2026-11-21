/** State diff and autonomous updates: plain text, at most 280 characters, numbers first; never the same observation twice. */
import { BIAS_TEXT, INSTRUMENTS, hashId, hhmm, iso, type BiasCall, type Position, type StructureEvent, type Ticket, type WatcherUpdate } from '@desk/contracts';
import { pxFor } from './core';

export const UPDATE_MAX_CHARS = 280;
/** Minimum confidence for an event to count as touching a position or ticket. */
export const TOUCH_MIN_CONFIDENCE = 0.55;
/** Minimum confidence for a general-interest update with nothing open. */
export const GENERAL_MIN_CONFIDENCE = 0.7;
/** An event level or the price within this fraction of a plan or kill level touches it. */
export const NEAR_LEVEL_PCT = 0.001;
const MAX_REMEMBERED_IDS = 5000;

export interface WatcherState {
  /** Ids of every event already seen (bounded). */
  eventIds: string[];
  /** Highest severity already pushed per observation key. */
  observations: Record<string, number>;
}
export const emptyWatcherState = (): WatcherState => ({ eventIds: [], observations: {} });

/** Events whose id was not in the previous run. Accepts the previous id list or the previous state. */
export function diffEvents(prev: Iterable<string> | WatcherState | null | undefined, events: StructureEvent[]): StructureEvent[] {
  const ids = new Set<string>(!prev ? [] : 'eventIds' in (prev as WatcherState) ? (prev as WatcherState).eventIds : (prev as Iterable<string>));
  return events.filter((e) => !ids.has(e.id));
}

export interface UpdateInput {
  now: number; instrument: string;
  /** New events from `diffEvents`. */
  events: StructureEvent[];
  allEvents: StructureEvent[];
  lastPrice: number;
  call: BiasCall | null;
  positions: Position[]; tickets: Ticket[];
  prevState: WatcherState | null | undefined;
  /** General-interest updates are allowed for the primary instrument only. Default: the instrument tracks NQ. */
  primary?: boolean;
}

const under = (s: string): string => INSTRUMENTS[s]?.priceSymbol ?? s;
const same = (a: string, b: string): boolean => under(a) === under(b);
const obsKey = (e: StructureEvent): string => (typeof e.data.obsKey === 'string' ? e.data.obsKey : `${e.detector}|${e.kind}|${e.tf}|${e.level ?? ''}`);
const severity = (e: StructureEvent): number => (typeof e.data.severity === 'number' ? e.data.severity : e.confidence);
const shortOf = (e: StructureEvent): string => (typeof e.data.short === 'string' ? e.data.short : e.text.replace(/\.$/, ''));
const near = (a: number | null | undefined, b: number | undefined): boolean => a != null && b !== undefined && Math.abs(a - b) <= NEAR_LEVEL_PCT * b;

function fractionWord(f: number): string {
  if (Math.abs(f - 0.5) < 0.02) return 'Half';
  if (Math.abs(f - 1 / 3) < 0.02) return 'One-third';
  if (Math.abs(f - 0.25) < 0.02) return 'Quarter';
  if (f >= 0.98) return 'All';
  return `${Math.round(f * 100)}%`;
}

function ticketLine(t: Ticket): string {
  const px = pxFor(t.instrument);
  if (t.status === 'open') {
    const done = t.fills.filter((f) => f.kind === 'scale_out').length;
    const next = t.targets[done];
    if (next) return `${fractionWord(next.fraction)} off at ${px(next.price)} per ticket.`;
  }
  return `Invalidation ${px(t.invalidation.price)} per ticket.`;
}

interface Scored { e: StructureEvent; key: string; sev: number; positionIds: string[]; ticketIds: string[]; biasKill: boolean; rank: number }

/** Joins the parts in priority order, dropping optional ones until the text fits; a hard cut is the last resort. */
function fit(head: string, optional: Array<{ text: string; keep: number }>): string {
  const parts = optional.filter((p) => p.text);
  for (;;) {
    const text = [head, ...parts.map((p) => p.text)].join(' ');
    if (text.length <= UPDATE_MAX_CHARS) return text;
    if (!parts.length) return `${text.slice(0, UPDATE_MAX_CHARS - 1).trimEnd()}…`;
    const drop = parts.reduce((m, p) => (p.keep < m.keep ? p : m));
    parts.splice(parts.indexOf(drop), 1);
  }
}

/**
 * One update per tick at most. It is generated when a new state change touches an open position, a live ticket
 * or the bias call's kill level, or (primary instrument only) when the event is high-confidence on its own.
 * A repeat of an observation already pushed is dropped; the same observation at a higher severity is pushed.
 */
export function generateUpdates(input: UpdateInput): { updates: WatcherUpdate[]; state: WatcherState } {
  const prev = input.prevState ?? emptyWatcherState();
  const px = pxFor(input.instrument);
  const observations = { ...prev.observations };
  const seen = new Set(prev.eventIds);
  for (const e of input.allEvents) seen.add(e.id);
  for (const e of input.events) seen.add(e.id);
  const eventIds = [...seen].slice(-MAX_REMEMBERED_IDS);

  const positions = input.positions.filter((p) => same(p.instrument, input.instrument));
  const tickets = input.tickets.filter((t) => (t.status === 'open' || t.status === 'planned') && same(t.instrument, input.instrument));
  const call = input.call && same(input.call.instrument, input.instrument) ? input.call : null;
  const kill = call?.killCondition.level;
  const killSide = call?.killCondition.side;
  const priceAtKill = kill !== undefined && (near(input.lastPrice, kill) || (killSide === 'above' ? input.lastPrice >= kill : killSide === 'below' ? input.lastPrice <= kill : false));
  const primary = input.primary ?? under(input.instrument) === 'NQ';

  const scored: Scored[] = [];
  for (const e of input.events) {
    if (!same(e.instrument, input.instrument) || e.detector === 'swing') continue;
    const key = obsKey(e), sev = severity(e);
    if ((observations[key] ?? -Infinity) >= sev) continue;
    const material = e.confidence >= TOUCH_MIN_CONFIDENCE;
    const positionIds = material ? positions.map((p) => p.id) : [];
    const ticketIds = tickets.filter((t) => material || [t.entry.price, t.invalidation.price, ...t.targets.map((x) => x.price)].some((lvl) => near(e.level, lvl) || near(e.levelHi, lvl))).map((t) => t.id);
    const spansKill = kill !== undefined && e.level != null && e.levelHi != null && Math.min(e.level, e.levelHi) <= kill && kill <= Math.max(e.level, e.levelHi);
    const biasKill = kill !== undefined && (near(e.level, kill) || near(e.levelHi, kill) || spansKill || (material && priceAtKill));
    if (!positionIds.length && !ticketIds.length && !biasKill && !(primary && e.confidence >= GENERAL_MIN_CONFIDENCE)) continue;
    const adverse = positions.some((p) => e.bias !== 0 && (p.direction === 'long') !== (e.bias === 1));
    scored.push({ e, key, sev, positionIds, ticketIds, biasKill, rank: (biasKill ? 3 : 0) + (adverse ? 2 : 0) + (positionIds.length || ticketIds.length ? 1 : 0) + (e.confirmedSetup ? 1 : 0) + e.confidence });
  }
  if (!scored.length) return { updates: [], state: { eventIds, observations } };
  scored.sort((a, b) => b.rank - a.rank || (a.e.id < b.e.id ? -1 : 1));
  const lead = scored[0]!;
  const second = scored.find((s) => s !== lead && s.key !== lead.key && s.e.detector !== lead.e.detector);
  const used = second ? [lead, second] : [lead];
  for (const s of used) observations[s.key] = s.sev;

  const usedIds = new Set(used.map((s) => s.e.id));
  const peer = [...input.allEvents].reverse().find((e) => e.detector === 'divergence' && same(e.instrument, input.instrument) && !usedIds.has(e.id));
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const callLine = !call ? '' : priceAtKill
    ? `Kill level ${px(kill!)} reached: ${BIAS_TEXT[call.call]}, ${call.probability.toFixed(2)} under review.`
    : `Call unchanged: ${BIAS_TEXT[call.call]}, ${call.probability.toFixed(2)}, expires ${hhmm(call.expiresAt)} ET.`;
  const openTicket = tickets.find((t) => positions.some((p) => p.ticketId === t.id)) ?? tickets.find((t) => t.status === 'open') ?? tickets[0];
  const text = fit(`${input.instrument} ${px(input.lastPrice)}, ${shortOf(lead.e)}.`, [
    { text: second ? `${cap(shortOf(second.e))}.` : '', keep: 1 },
    { text: peer ? `${cap(shortOf(peer))}.` : '', keep: 0 },
    { text: callLine, keep: 3 },
    { text: openTicket ? ticketLine(openTicket) : '', keep: 2 },
  ]);
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const update: WatcherUpdate = {
    id: hashId('wu', input.instrument, lead.key, lead.sev, lead.e.id),
    ts: iso(input.now), instrument: input.instrument, text,
    eventIds: used.map((s) => s.e.id),
    touches: { positionIds: uniq(used.flatMap((s) => s.positionIds)), ticketIds: uniq(used.flatMap((s) => s.ticketIds)), biasKill: used.some((s) => s.biasKill) },
    dedupeKey: lead.key, severity: lead.sev,
  };
  return { updates: [update], state: { eventIds, observations } };
}
