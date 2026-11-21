/** Morning brief: the seven sections of spec section 12, in order. Pure. */
import {
  BIAS_TEXT, DAY, ageLabel, dayKey, fromZoned, fmtNum, zoned,
  type AccountRow, type BiasCall, type Brief, type Catalyst, type Headline,
} from '@desk/contracts';
import {
  Cites, callKey, callLine, catalystLine, ensureDot, etStamp, makeBrief, monthDay, px, quoteText, signed, signedUsd,
  sortCalls, staleTag, usd, yieldText, type BriefSection,
} from './common';
import type { MorningCtx, PositionLine } from './types';

export const MORNING_SECTIONS = ['call', 'overnight', 'catalysts', 'positions', 'accounts', 'one_thing', 'reads'] as const;

const ASIA = ['N225', 'HSI', 'SSEC', 'KOSPI', 'AXJO', 'TWII', 'NIFTY'];
const EUROPE = ['DAX', 'FTSE', 'STOXX50', 'STOXX600', 'CAC'];
/** The position monitor runs on the 60 s loop; a status older than 3x that is flagged. */
const POSITION_CADENCE_SEC = 60;

function callLines(ctx: MorningCtx, cites: Cites): string[] {
  if (ctx.calls.length === 0) return ['No calls on file.'];
  return sortCalls(ctx.calls, ctx.profile.instruments.primary).map((c) => {
    cites.add(callKey(c), 'bias engine', c.createdAt);
    return callLine(c, ctx.now);
  });
}

function overnightLines(ctx: MorningCtx, cites: Cites): string[] {
  const { now, quotes, rates } = ctx;
  const lines: string[] = [];
  for (const [name, syms] of [['Asia', ASIA], ['Europe', EUROPE]] as const) {
    const have = syms.filter((s) => quotes[s]);
    if (have.length) lines.push(`${name}: ${have.map((s) => quoteText(s, quotes[s], now, cites)).join(', ')}.`);
  }
  lines.push(`Rates: ${yieldText('10Y', rates?.y10, rates?.y10Chg1dBp, now, cites)}, ${yieldText('2Y', rates?.y2, rates?.y2Chg1dBp, now, cites)}.`);
  lines.push(`${[['DXY', 'DXY'], ['oil', 'CL'], ['BTC', 'BTC'], ['VIX', 'VIX']].map(([name, sym]) => quoteText(name!, quotes[sym!], now, cites)).join(', ')}.`);

  const nq = quotes.NQ;
  const fv = ctx.nqFairValue;
  if (!nq) lines.push('NQ futures: no data.');
  else {
    cites.add('NQ', nq.source, nq.asOf);
    const tag = staleTag(nq, now);
    if (fv) {
      cites.add('NQ fair value', fv.source, fv.asOf);
      const d = nq.price - fv.value;
      lines.push(`NQ ${px(nq.price)}${tag} vs fair value ${px(fv.value)}${staleTag(fv, now)}: ${signed(d, 0)} pts (${signed((d / fv.value) * 100, 2)}%).`);
    } else if (nq.prevClose !== null && nq.prevClose !== 0) {
      lines.push(`NQ ${px(nq.price)}${tag} vs prior close ${px(nq.prevClose)}: ${signed((nq.price / nq.prevClose - 1) * 100, 2)}%. No fair-value input; this is the prior close, not fair value.`);
    } else lines.push(`NQ ${px(nq.price)}${tag}. Fair value and prior close: no data.`);
  }
  for (const n of ctx.heldOvernight ?? []) {
    cites.add(`held ${n.id}`, 'notifications', n.ts);
    lines.push(`Held overnight (${n.class}, ${etStamp(n.ts, now)}): ${n.lines.join(' ')}`);
  }
  return lines;
}

/** Catalysts from the start of the trader's local day through the next 24 hours. */
export function catalystsToday(ctx: Pick<MorningCtx, 'now' | 'profile' | 'catalysts'>): Catalyst[] {
  const tz = ctx.profile.timezone;
  const z = zoned(ctx.now, tz);
  const from = fromZoned(z.year, z.month, z.day, 0, 0, tz);
  return ctx.catalysts
    .filter((c) => { const t = Date.parse(c.scheduledAt); return t >= from && t < ctx.now + DAY; })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || a.tier - b.tier);
}

export function positionText(p: PositionLine, now: number, cites?: Cites): string {
  const { position: pos, status: st, ticket } = p;
  const head = `${pos.instrument} ${pos.direction} on ${pos.accountId}`;
  let state = 'status: no data';
  if (st) {
    cites?.add(`position ${pos.instrument} ${pos.accountId}`, 'position monitor', st.asOf);
    state = `${st.status}, fail ${px(st.failPrice)} is ${fmtNum(Math.abs(st.distancePts), 0)} pts (${Math.abs(st.distancePct).toFixed(2)}%) away, P&L ${signedUsd(st.pnlUsd)}${staleTag({ asOf: st.asOf, cadenceSec: POSITION_CADENCE_SEC }, now)}`;
  }
  let plan = 'No ticket attached: no plan on file.';
  if (ticket) {
    cites?.add(`ticket ${ticket.instrument} ${ticket.accountId}`, 'ticket', ticket.createdAt);
    const targets = ticket.targets.map((t) => `${px(t.price)} (${Math.round(t.fraction * 100)}%)`).join(', ');
    plan = `Plan today: targets ${targets}; invalidation ${px(ticket.invalidation.price)}; time stop ${etStamp(ticket.timeStop, now)}.`;
  }
  const cat = st?.catalystInWindow ? ` ${st.catalystInWindow.name} (T${st.catalystInWindow.tier}) at ${etStamp(st.catalystInWindow.at, now)} is inside the window.` : '';
  return `${head}: ${state}. ${plan}${cat}`;
}

function positionLines(ctx: MorningCtx, cites: Cites): string[] {
  const lines = ctx.positions.map((p) => positionText(p, ctx.now, cites));
  for (const t of ctx.tickets.filter((x) => x.status === 'planned' || x.status === 'watch')) {
    cites.add(`ticket ${t.instrument} ${t.accountId}`, 'ticket', t.createdAt);
    lines.push(`${t.status === 'watch' ? 'Watch' : 'Planned'}: ${t.instrument} ${t.direction} on ${t.accountId}, entry: ${t.entry.text}; invalidation ${px(t.invalidation.price)}; time stop ${etStamp(t.timeStop, ctx.now)}.`);
  }
  return lines.length ? lines : ['No open positions, no live tickets.'];
}

/** One account as a line: balance, room, claimable, payout and consistency math, deadlines. */
export function accountLine(a: AccountRow, now: number, cites?: Cites): string {
  cites?.add(`account ${a.rules.id}`, 'account state', a.state.asOf);
  cites?.add(`rules ${a.rules.id}`, a.rules.source.origin, a.rules.source.asOf);
  const parts = [
    `${a.rules.id}: balance ${usd(a.state.balance)}, room ${usd(a.roomUsd)}, claimable ${a.claimableUsd === null ? 'no data' : usd(a.claimableUsd)}.`,
    ensureDot(a.payoutLine),
  ];
  if (a.consistencyLine) parts.push(ensureDot(a.consistencyLine));
  if (a.nextDeadline) parts.push(`Next: ${a.nextDeadline.what}, ${etStamp(a.nextDeadline.at, now)}.`);
  if (a.rules.inactivityDays !== null && a.state.lastTradeAt) {
    const due = Date.parse(a.state.lastTradeAt) + a.rules.inactivityDays * DAY;
    parts.push(`Inactivity deadline ${monthDay(due)} (last trade ${monthDay(a.state.lastTradeAt)}).`);
  }
  return `${parts.join(' ')} (state ${ageLabel(a.state.asOf, now)} old)`;
}

function accountLines(ctx: MorningCtx, cites: Cites): string[] {
  const active = ctx.accounts.filter((a) => a.state.active);
  const lines = active.length ? active.map((a) => accountLine(a, ctx.now, cites)) : ['No active accounts on file.'];
  if (ctx.ruleDiffs.length === 0) lines.push('No rule change overnight.');
  for (const d of ctx.ruleDiffs) {
    cites.add(`rule change ${d.firm}`, d.url, d.detectedAt);
    lines.push(`Rule change, ${d.firm} (${d.accountIds.join(', ') || 'no account mapped'}): ${ensureDot(d.summary)} Detected ${etStamp(d.detectedAt, ctx.now)}.`);
  }
  return lines;
}

/** The single trade the engine would take: the highest-probability live call that carries a trade. */
export function oneThing(calls: BiasCall[], primary: string[], now: number): BiasCall | null {
  const live = sortCalls(calls, primary).filter((c) => c.trade !== null && c.call !== 'no_edge' && Date.parse(c.expiresAt) > now);
  return live.sort((a, b) => b.probability - a.probability)[0] ?? null;
}

function oneThingLines(ctx: MorningCtx, today: Catalyst[], cites: Cites): string[] {
  const c = oneThing(ctx.calls, ctx.profile.instruments.primary, ctx.now);
  if (c && c.trade) {
    cites.add(callKey(c), 'bias engine', c.createdAt);
    const t = c.trade;
    const size = t.size ? ` Size ${fmtNum(t.size.units, 0)} units${t.size.failPrice === null ? '' : `, fail ${px(t.size.failPrice)}`}.` : '';
    return [
      `${BIAS_TEXT[c.call]} ${t.instrument} ${c.probability.toFixed(2)}: ${t.direction} on ${t.entry.text}. Targets ${t.targets.map((x) => px(x.price)).join(' / ')}. Invalidation ${px(t.invalidation.price)} (${t.invalidation.reason}). Time stop: ${ensureDot(t.timeStop.text)}${t.accountId ? ` Account ${t.accountId}.` : ''}${size}`,
    ];
  }
  const next = today.find((x) => x.status !== 'resolved' && Date.parse(x.scheduledAt) > ctx.now);
  if (next) {
    cites.add(`catalyst ${next.name}`, next.source, next.asOf);
    return [`No edge until ${next.name} at ${etStamp(next.scheduledAt, ctx.now)}.`];
  }
  const later = ctx.calls.map((x) => x.nextCatalyst).filter((x): x is NonNullable<typeof x> => x !== null && Date.parse(x.at) > ctx.now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  return [later ? `No edge until ${later.name} at ${etStamp(later.at, ctx.now)}.` : 'No edge. No catalyst on the calendar today.'];
}

const DIR_TEXT = { '1': 'risk-on', '0': 'direction unclear', '-1': 'risk-off' } as const;
export function headlineLine(h: Headline, now: number, cites?: Cites): string {
  cites?.add(`headline ${h.id}`, h.source, h.ts);
  const whom = h.symbols.length ? ` for ${h.symbols.slice(0, 3).join(', ')}` : '';
  return `[${h.impact}] ${h.title} (${h.source}, ${etStamp(h.ts, now)}). Why: ${h.category}, ${DIR_TEXT[String(h.direction) as keyof typeof DIR_TEXT]}${whom}.`;
}
/** Three headlines at most, highest impact first, newest first within an impact score. */
export function topReads(headlines: Headline[], n = 3): Headline[] {
  const seen = new Set<string>();
  return [...headlines].sort((a, b) => b.impact - a.impact || Date.parse(b.ts) - Date.parse(a.ts))
    .filter((h) => (seen.has(h.dedupeKey) ? false : (seen.add(h.dedupeKey), true))).slice(0, n);
}

/** What makes a regenerated brief worth replacing the 06:30 one: a call, a consensus, a position status, a rule. */
function material(ctx: MorningCtx, today: Catalyst[]): string[] {
  return [
    ...ctx.calls.map((c) => `call|${c.instrument}|${c.horizon}|${c.id}|${c.call}|${c.probability.toFixed(2)}`).sort(),
    ...today.map((c) => `cat|${c.id}|${c.consensus}|${c.whisper}|${c.status}`),
    ...ctx.positions.map((p) => `pos|${p.position.id}|${p.status?.status ?? 'none'}`).sort(),
    ...ctx.tickets.map((t) => `tkt|${t.id}|${t.status}`).sort(),
    ...ctx.ruleDiffs.map((d) => `rule|${d.id}`).sort(),
  ];
}

export function morningBrief(ctx: MorningCtx): Brief {
  const cites = new Cites();
  const today = catalystsToday(ctx);
  const reads = topReads(ctx.headlines);
  const sections: BriefSection[] = [
    { key: 'call', title: 'The call', lines: callLines(ctx, cites) },
    { key: 'overnight', title: 'Overnight', lines: overnightLines(ctx, cites) },
    { key: 'catalysts', title: 'Catalysts today', lines: today.length ? today.map((c) => catalystLine(c, ctx.now, cites)) : ['No catalysts today.'] },
    { key: 'positions', title: 'Positions and tickets', lines: positionLines(ctx, cites) },
    { key: 'accounts', title: 'Accounts', lines: accountLines(ctx, cites) },
    { key: 'one_thing', title: 'The one thing', lines: oneThingLines(ctx, today, cites) },
    { key: 'reads', title: 'Reads worth two minutes', lines: reads.length ? reads.map((h) => headlineLine(h, ctx.now, cites)) : ['No headlines worth two minutes.'] },
  ];
  return makeBrief('morning', ctx.now, dayKey(ctx.now, ctx.profile.timezone), sections, cites, material(ctx, today));
}

/**
 * True when the regenerated brief differs materially from the one already sent (or there is none).
 * Quotes ticking and ages rolling do not count; the id hashes only calls, consensus, statuses and rules.
 */
export function briefChanged(prev: Brief | null, next: Brief): boolean {
  return prev === null || prev.kind !== next.kind || prev.forDay !== next.forDay || prev.id !== next.id;
}
