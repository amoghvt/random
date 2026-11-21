'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { Catalyst, ScenarioBranch } from '@desk/contracts';
import { countdown, dayET, dayKeyET, dayTimeET, fmtBp, fmtPct, fmtPrice, fmtShare, fmtUnits, timeET } from '@/lib/format';
import { useApi, useNow } from '@/lib/store';
import { Btn, Card, Chip, Empty, ErrorLine, LinkBtn, Loading, Stale } from './ui';

const JUST_RESOLVED_MS = 30 * 60_000;
const val = (x: number | null | undefined, unit?: string): string => (x == null ? '—' : `${x}${unit ? ` ${unit}` : ''}`);
const pct = (x: number | null | undefined): string => (x == null ? '—' : fmtPct(x));

export function useCatalysts() {
  return useApi('GET /api/catalysts', { query: { days: 7, past: 1 } }, 60_000);
}
export function isHot(c: Catalyst, now: number): boolean {
  if (c.status === 'live') return true;
  return c.status === 'resolved' && c.resolution != null && now > 0 && now - Date.parse(c.resolution.resolvedAt) < JUST_RESOLVED_MS;
}

function StatusChip({ c, now }: { c: Catalyst; now: number }) {
  if (c.status === 'live') return <Chip tone="bad"><span className="pulse h-1.5 w-1.5 rounded-full bg-down" />Live</Chip>;
  if (c.status === 'resolved') return <Chip tone={isHot(c, now) ? 'warn' : 'mute'}>Resolved{c.resolution?.actual != null ? ` ${c.resolution.actual}` : ''}</Chip>;
  return null;
}

export function CatalystTimeline({ compact = false }: { compact?: boolean }) {
  const list = useCatalysts();
  const now = useNow();
  if (!list.data) return <Card title="Next 7 days">{list.error ? <ErrorLine error={list.error} retry={() => void list.refresh()} /> : <Loading />}</Card>;
  const items = [...list.data].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const days = new Map<string, Catalyst[]>();
  for (const c of items) days.set(dayKeyET(c.scheduledAt), [...(days.get(dayKeyET(c.scheduledAt)) ?? []), c]);
  return (
    <div data-testid="timeline">
      <Stale since={list.staleSince} error={list.error} />
      {!compact && <h1 className="mb-3 text-xs font-semibold uppercase tracking-wider text-mute">Next 7 days · Tier 1 in red</h1>}
      {items.length === 0 && <Empty>No catalysts in the next 7 days.</Empty>}
      <ol className="space-y-4">
        {[...days.entries()].map(([day, cs]) => (
          <li key={day}>
            <p className="mb-1 text-sm font-semibold">{dayET(cs[0]!.scheduledAt)}</p>
            <ol className="ml-1.5 border-l border-line">
              {cs.map((c) => {
                const left = Date.parse(c.scheduledAt) - now;
                const t1 = c.tier === 1;
                return (
                  <li key={c.id} className="relative pl-5">
                    <span aria-hidden="true" className={`absolute -left-[5px] top-[18px] h-2.5 w-2.5 rounded-full ${t1 ? 'bg-down' : c.tier === 2 ? 'bg-mute' : 'border border-dim bg-bg'}`} />
                    <Link href={`/catalysts?id=${encodeURIComponent(c.id)}`} data-testid="catalyst-row" data-tier={c.tier} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className={`block truncate text-[15px] ${t1 ? 'font-semibold text-down' : c.tier === 3 ? 'text-mute' : ''}`}>{c.name}</span>
                        <span className="block text-xs text-mute">
                          {timeET(c.scheduledAt)} · Tier {c.tier}
                          {c.consensus != null && ` · cons ${val(c.consensus, c.unit)}`}
                          {c.impliedMovePct != null && ` · ±${c.impliedMovePct}%`}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-sm">
                        {c.status === 'upcoming' ? <span className="font-semibold">{now > 0 && left > 0 ? countdown(left) : '—'}</span> : <StatusChip c={c} now={now} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Branch({ b, c, matched }: { b: ScenarioBranch; c: Catalyst; matched: boolean }) {
  const t = b.trade;
  return (
    <tbody data-testid="matrix-branch" className={`block border-t border-line py-3 first:border-t-0 sm:table-row-group ${matched ? 'bg-info/10' : ''}`}>
      <tr className="block sm:table-row">
        <th scope="row" className="block text-left align-top sm:table-cell sm:w-24 sm:py-2 sm:pr-3">
          <span className="text-base font-semibold">{b.label}</span>
          {matched && <Chip tone="info" className="ml-2">Matched</Chip>}
        </th>
        <Cell label="Prob">
          <span className="font-semibold">{fmtShare(b.probability)}</span> <span className="text-xs text-mute">{b.probabilitySource.replace('_', ' ')}</span>
        </Cell>
        <Cell label="Rates">{b.ratesRead.text} <span className="text-xs text-mute">(2Y {fmtBp(b.ratesRead.y2Bp)}, 10Y {fmtBp(b.ratesRead.y10Bp)})</span></Cell>
        <Cell label="Index">{b.indexRead.text} <span className="text-xs text-mute">(15m {pct(b.indexRead.m15Pct)}, 1h {pct(b.indexRead.h1Pct)}, close {pct(b.indexRead.closePct)})</span></Cell>
        <Cell label="Trade">
          {t ? (
            <>
              <span className={t.direction === 'long' ? 'text-up' : 'text-down'}>{t.direction === 'long' ? 'Long' : 'Short'}</span> {t.instrument}. {t.entry.text}.
              {' '}T {t.targets.map((x) => fmtPrice(x.price)).join(' / ')}. Invalid {fmtPrice(t.invalidation.price)}.
            </>
          ) : <span className="text-mute">{b.noTradeReason ?? 'No edge, stand aside'}</span>}
        </Cell>
        <Cell label="Size">
          {t?.size ? <>{fmtUnits(t.size.units)}{t.size.leverage != null && ` · ${t.size.leverage}x`}{t.size.failPrice != null && <span className="text-xs text-mute"> · fail {fmtPrice(t.size.failPrice)}</span>}</> : <span className="text-mute">{t ? 'Sized on the ticket' : '—'}</span>}
          {t && <Link href={`/ticket?catalyst=${encodeURIComponent(c.id)}&branch=${encodeURIComponent(b.id)}`} className="ml-2 inline-block py-1 text-info underline">Ticket</Link>}
        </Cell>
      </tr>
      <tr className="block sm:table-row"><td colSpan={6} className="block pt-1 text-xs text-mute sm:table-cell sm:pb-2">{b.secondOrder}</td></tr>
    </tbody>
  );
}
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <td className="grid grid-cols-[3.25rem_1fr] gap-2 pt-1.5 text-sm sm:table-cell sm:py-2 sm:pr-3 sm:align-top">
      <span className="text-xs uppercase tracking-wide text-mute sm:hidden">{label}</span>
      <span>{children}</span>
    </td>
  );
}

function Matrix({ c }: { c: Catalyst }) {
  const m = c.matrix;
  if (!m) return <Card title="Scenario matrix"><Empty>{c.tier === 3 ? 'Tier 3: shown, not planned.' : 'Matrix not generated yet. It runs at 20:00 ET the day before and again at 06:00 ET.'}</Empty></Card>;
  return (
    <Card title="Scenario matrix" right={<span className="text-xs text-mute">ref {fmtPrice(m.referencePrice)} · {dayTimeET(m.generatedAt)}</span>}>
      <table className="block w-full sm:table" data-testid="matrix">
        <thead className="hidden text-left text-[11px] uppercase tracking-wide text-mute sm:table-header-group">
          <tr>{['Branch', 'Prob', 'Rates read', 'Index read', 'Trade', 'Size'].map((h) => <th key={h} scope="col" className="pb-1 pr-3 font-medium">{h}</th>)}</tr>
        </thead>
        {m.branches.map((b) => <Branch key={b.id} b={b} c={c} matched={c.resolution?.branchId === b.id} />)}
      </table>
      {m.regimeNotes.length > 0 && <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-mute">{m.regimeNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Card>
  );
}

function History({ c }: { c: Catalyst }) {
  if (c.history.length === 0) return <Card title="Historical reactions"><Empty>No recorded instances.</Empty></Card>;
  return (
    <Card title={`Historical reactions · last ${c.history.length}`}>
      <table className="w-full text-right text-[13px]" data-testid="history">
        <thead className="text-[11px] uppercase text-mute">
          <tr><th scope="col" className="pb-1 text-left font-medium">Date</th><th scope="col" className="font-medium">Act</th><th scope="col" className="font-medium">Cons</th><th scope="col" className="font-medium">5m</th><th scope="col" className="font-medium">1h</th><th scope="col" className="font-medium">Close</th><th scope="col" className="font-medium">Rev</th></tr>
        </thead>
        <tbody>
          {c.history.map((h) => (
            <tr key={h.date} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal text-mute">{h.date.slice(2)}</th>
              <td>{val(h.actual)}</td><td className="text-mute">{val(h.consensus)}</td>
              <td>{pct(h.m5Pct)}</td><td>{pct(h.h1Pct)}</td><td>{pct(h.closePct)}</td>
              <td className={h.firstMoveReversed ? 'text-warn' : 'text-mute'}>{h.firstMoveReversed == null ? '—' : h.firstMoveReversed ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-mute">Moves are for the primary instrument. Rev: the first 5-minute move reversed.</p>
    </Card>
  );
}

function Odds({ c }: { c: Catalyst }) {
  if (c.predictionOdds.length === 0) return <Card title="Prediction markets"><Empty>No market listed for this event.</Empty></Card>;
  return (
    <Card title="Prediction markets">
      <div className="space-y-4">
        {c.predictionOdds.map((m) => (
          <div key={m.id}>
            <p className="text-sm">{m.title} <span className="text-xs text-mute">· {m.venue} · as of {timeET(m.asOf)}</span></p>
            <ul className="mt-2 space-y-1.5">
              {m.outcomes.map((o) => (
                <li key={o.label} className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-sm">
                  <span>{o.label}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-raise"><span className="block h-full rounded-full bg-info" style={{ width: `${Math.round(o.prob * 100)}%` }} /></span>
                  <span className="text-right font-semibold">{fmtShare(o.prob)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Full-screen while the release is live or just resolved: the print, the matched branch, the clock. */
function ReactionClock({ c, onDismiss }: { c: Catalyst; onDismiss: () => void }) {
  const now = useNow();
  const from = Date.parse(c.resolution?.resolvedAt ?? c.scheduledAt);
  const b = c.matrix?.branches.find((x) => x.id === c.resolution?.branchId) ?? null;
  const r = c.reaction;
  return (
    <div role="dialog" aria-modal="true" aria-label={`${c.name} reaction clock`} data-testid="reaction-clock"
      className="fixed inset-0 z-40 overflow-y-auto bg-bg px-[calc(16px+var(--sal))] pb-[calc(24px+var(--sab))] pt-[calc(16px+var(--sat))]">
      <div className="mx-auto max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <Chip tone="bad">{c.status === 'live' ? 'Live' : 'Just resolved'} · Tier {c.tier}</Chip>
          <Btn kind="quiet" onClick={onDismiss} data-testid="clock-dismiss">Full card</Btn>
        </div>
        <div>
          <p className="text-sm text-mute">{c.name} · {timeET(c.scheduledAt)}</p>
          <p className="text-4xl font-bold leading-tight">
            {c.resolution?.actual != null ? val(c.resolution.actual, c.unit) : 'Waiting for the print'}
            {c.resolution?.actual != null && <span className="ml-2 text-lg font-normal text-mute">vs {val(c.consensus)}</span>}
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-4 text-center">
          <p className="text-xs uppercase tracking-wider text-mute">{c.resolution ? 'Since the print' : 'Since the scheduled time'}</p>
          <p className="text-6xl font-bold" data-testid="clock">{now > 0 ? countdown(now - from) : '—'}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
            <div><p className="text-xs uppercase text-mute">5 min</p><p className="text-2xl font-semibold">{pct(r?.m5Pct)}</p></div>
            <div><p className="text-xs uppercase text-mute">15 min</p><p className="text-2xl font-semibold">{pct(r?.m15Pct)}</p></div>
          </div>
          {r && <p className="mt-3 text-sm">{r.verdict && <Chip tone={r.verdict === 'normal' ? 'mute' : 'warn'} className="mr-2">{r.verdict}</Chip>}{r.text}</p>}
        </div>
        {b ? (
          <div className="rounded-2xl border border-info/50 bg-info/10 p-4">
            <p className="text-xs uppercase tracking-wider text-mute">Matched branch · {b.label} · {fmtShare(b.probability)} going in</p>
            <p className="mt-1 text-sm">{b.ratesRead.text}. {b.indexRead.text}.</p>
            <p className="mt-1 text-sm text-mute">{b.secondOrder}</p>
            {b.trade
              ? <LinkBtn kind="primary" block className="mt-3" href={`/ticket?catalyst=${encodeURIComponent(c.id)}&branch=${encodeURIComponent(b.id)}`}>Open the branch ticket</LinkBtn>
              : <p className="mt-3 text-base font-semibold">{b.noTradeReason ?? 'No edge, stand aside'}</p>}
          </div>
        ) : <p className="text-sm text-mute">{c.resolution ? 'No branch matched.' : 'The branch is matched when the print lands.'}</p>}
        {c.matrix && <p className="text-[15px]">{c.matrix.whatIWouldDo}</p>}
        {c.history.length > 0 && <History c={c} />}
      </div>
    </div>
  );
}

export function CatalystCard({ id }: { id: string }) {
  const list = useCatalysts();
  const one = useApi('GET /api/catalysts/:id', { params: { id } }, 30_000);
  const now = useNow();
  const [dismissed, setDismissed] = useState(false);
  const c = one.data ?? list.data?.find((x) => x.id === id);
  if (!c) return <Card title="Catalyst">{one.error ? <ErrorLine error={one.error} retry={() => void one.refresh()} /> : <Loading />}</Card>;
  const left = Date.parse(c.scheduledAt) - now;
  return (
    <div className="space-y-3" data-testid="catalyst-card">
      {isHot(c, now) && !dismissed && <ReactionClock c={c} onDismiss={() => setDismissed(true)} />}
      <Link href="/catalysts/" className="inline-flex min-h-11 items-center text-sm text-info">‹ Timeline</Link>
      <Stale since={one.staleSince} error={one.error} />
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className={`text-xl font-bold ${c.tier === 1 ? 'text-down' : ''}`}>{c.name}</h1>
            <p className="text-sm text-mute">{dayTimeET(c.scheduledAt)} · {c.instruments.join(', ')}</p>
          </div>
          <div className="shrink-0 text-right">
            <Chip tone={c.tier === 1 ? 'bad' : 'mute'}>Tier {c.tier}</Chip>
            <p className="mt-1 text-xl font-bold">{c.status === 'upcoming' ? (now > 0 && left > 0 ? countdown(left) : '—') : <StatusChip c={c} now={now} />}</p>
          </div>
        </div>
        {c.matrix
          ? <p className="mt-3 rounded-xl border border-line bg-bg px-3 py-2 text-[15px] leading-snug" data-testid="one-line">{c.matrix.whatIWouldDo}</p>
          : <p className="mt-3 text-sm text-mute">No plan line: the engine has no matrix for this event.</p>}
        <dl className="mt-3 grid grid-cols-4 gap-2 text-sm">
          {([['Cons', val(c.consensus)], ['Prior', val(c.prior)], ['Whisper', val(c.whisper)], ['Implied', c.impliedMovePct != null ? `±${c.impliedMovePct}%` : '—']] as const).map(([k, v]) => (
            <div key={k}><dt className="text-[11px] uppercase tracking-wide text-mute">{k}</dt><dd className="font-semibold">{v}</dd></div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-mute">
          {c.unit && `${c.unit} · `}{c.impliedMoveSource && `implied move from ${c.impliedMoveSource} · `}source {c.source}, as of {dayTimeET(c.asOf)}
        </p>
        {c.adhoc && <p className="mt-2 text-sm">Analog: {c.adhoc.analog}</p>}
        {isHot(c, now) && dismissed && <Btn kind="ghost" className="mt-3" onClick={() => setDismissed(false)}>Reaction clock</Btn>}
        {c.reaction && !isHot(c, now) && <p className="mt-3 text-sm">Reaction: 5m {pct(c.reaction.m5Pct)}, 15m {pct(c.reaction.m15Pct)}. {c.reaction.text}</p>}
      </Card>
      <Matrix c={c} />
      <History c={c} />
      <Odds c={c} />
    </div>
  );
}
