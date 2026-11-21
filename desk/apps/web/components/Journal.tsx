'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { Brief, JournalView } from '@desk/contracts';
import { api } from '@/lib/api';
import { callText, dayTimeET, fmtProb, fmtSignedUsd, fmtUsd, pretty } from '@/lib/format';
import { keyOf, patchCache, useApi } from '@/lib/store';
import { Btn, Card, Chip, Empty, ErrorLine, Loading, Segmented, Stale } from './ui';

type Cal = JournalView['calibration'];

/** Predicted probability against realized hit rate, one dot per bucket. The dashed diagonal is perfect calibration. */
export function CalibrationChart({ cal }: { cal: Cal }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 340, H = 210, L = 34, R = 10, T = 14, B = 28;
  const x0 = 0.5, x1 = 0.85, y0 = 0.3, y1 = 1;
  const px = (p: number) => L + ((p - x0) / (x1 - x0)) * (W - L - R);
  const py = (p: number) => T + (1 - (Math.min(y1, Math.max(y0, p)) - y0) / (y1 - y0)) * (H - T - B);
  const scored = cal.buckets.filter((b) => b.realized != null && b.n > 0);
  const a = active != null ? cal.buckets[active] : undefined;
  return (
    <figure data-testid="calibration">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Calibration: predicted probability against realized hit rate in ${scored.length} buckets, ${cal.n} calls, source ${cal.source}`}>
        {[0.4, 0.6, 0.8, 1].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={py(g)} y2={py(g)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={L - 6} y={py(g) + 4} textAnchor="end" fontSize="11" fill="var(--color-mute)">{Math.round(g * 100)}%</text>
          </g>
        ))}
        {[0.5, 0.6, 0.7, 0.8].map((g) => <text key={g} x={px(g)} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--color-mute)">{g.toFixed(2)}</text>)}
        <text x={W - R} y={H - 10} textAnchor="end" fontSize="11" fill="var(--color-dim)">predicted</text>
        <line x1={px(x0)} y1={py(x0)} x2={px(x1)} y2={py(x1)} stroke="var(--color-mute)" strokeWidth="1.5" strokeDasharray="4 4" />
        {cal.buckets.map((b, i) => b.realized == null || b.n === 0 ? null : (
          <g key={i} tabIndex={0} role="button" aria-label={`Bucket ${fmtProb(b.lo)} to ${fmtProb(b.hi)}: predicted ${fmtProb(b.predicted)}, realized ${fmtProb(b.realized)}, n ${b.n}`}
            onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} onClick={() => setActive(i)} style={{ outline: 'none', cursor: 'pointer' }}>
            <line x1={px(b.predicted)} x2={px(b.predicted)} y1={py(b.predicted)} y2={py(b.realized)} stroke="var(--color-info)" strokeWidth="2" opacity="0.5" />
            <circle cx={px(b.predicted)} cy={py(b.realized)} r={active === i ? 7 : 5} fill="var(--color-info)" stroke="var(--color-panel)" strokeWidth="2" />
            <text x={px(b.predicted)} y={py(Math.max(b.realized, b.predicted)) - 10} textAnchor="middle" fontSize="11" fill="var(--color-ink)">{b.n}</text>
            <rect x={px(b.predicted) - 20} y={T} width="40" height={H - T - B} fill="transparent" />
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 min-h-10 text-xs text-mute" aria-live="polite">
        {a && a.realized != null
          ? <span className="text-ink">{fmtProb(a.lo)}–{fmtProb(a.hi)}: predicted {fmtProb(a.predicted)}, realized {fmtProb(a.realized)}, n = {a.n}</span>
          : <>Dots: realized hit rate per bucket; the number above is n. Dashed line: perfect calibration. Above the line is underconfident, below is overconfident.</>}
      </figcaption>
      <details className="mt-1 text-sm">
        <summary className="min-h-11 cursor-pointer py-2 text-info">Table</summary>
        <table className="w-full text-right">
          <thead className="text-[11px] uppercase text-mute"><tr><th scope="col" className="text-left font-medium">Bucket</th><th scope="col" className="font-medium">Predicted</th><th scope="col" className="font-medium">Realized</th><th scope="col" className="font-medium">n</th></tr></thead>
          <tbody>
            {cal.buckets.map((b, i) => (
              <tr key={i} className="border-t border-line"><th scope="row" className="py-1 text-left font-normal">{fmtProb(b.lo)}–{fmtProb(b.hi)}</th><td>{fmtProb(b.predicted)}</td><td>{b.realized != null ? fmtProb(b.realized) : '—'}</td><td>{b.n}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function BriefView({ kind }: { kind: Brief['kind'] }) {
  const q = useApi('GET /api/briefs/latest', { query: { kind } });
  const title = kind === 'weekly' ? 'Weekly review' : kind === 'morning' ? 'Morning brief' : 'Post-close recap';
  if (q.data === undefined) return <Card title={title}>{q.error ? <ErrorLine error={q.error} retry={() => void q.refresh()} /> : <Loading />}</Card>;
  const b = q.data;
  if (!b) return <Card title={title}><Empty>{kind === 'weekly' ? 'No weekly review yet. It is written Sunday 18:00.' : kind === 'morning' ? 'No brief yet. It is written at 06:30 local.' : 'No recap yet. It is written at 16:30 ET.'}</Empty></Card>;
  return (
    <article data-testid={`brief-${kind}`} className="space-y-3">
      <Stale since={q.staleSince} error={q.error} />
      <Card title={title} right={<span className="text-xs text-mute">{b.forDay} · written {dayTimeET(b.ts)}</span>}>
        <div className="space-y-4">
          {b.sections.map((s) => (
            <section key={s.key}>
              <h3 className="text-sm font-semibold">{s.title}</h3>
              <ul className="mt-1 space-y-1 text-[15px] leading-snug">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </section>
          ))}
        </div>
        {b.citations.length > 0 && (
          <details className="mt-4 border-t border-line pt-2 text-xs text-mute">
            <summary className="min-h-11 cursor-pointer py-2">Sources and as-of times · {b.citations.length}</summary>
            <ul className="space-y-0.5">{b.citations.map((c, i) => <li key={i}>{c.label} · {c.source} · {dayTimeET(c.asOf)}</li>)}</ul>
          </details>
        )}
      </Card>
    </article>
  );
}

type ListKind = 'trades' | 'calls' | 'events' | 'notes';
const has = (q: string, ...parts: Array<string | undefined | null>): boolean => q === '' || parts.some((p) => p?.toLowerCase().includes(q));

function Lists({ j }: { j: JournalView }) {
  const [kind, setKind] = useState<ListKind>('trades');
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const trades = j.trades.filter((t) => has(q, t.instrument, t.accountId, t.status, t.direction, t.reason.kind));
  const calls = j.calls.filter((c) => has(q, c.instrument, callText(c.call), c.horizon, ...c.facts));
  const events = j.events.filter((e) => has(q, pretty(e.pattern), e.text, e.followUp?.action));
  const notes = j.notes.filter((n) => has(q, n.text, ...n.tags));
  const count = { trades: trades.length, calls: calls.length, events: events.length, notes: notes.length }[kind];
  return (
    <Card title="Journal">
      <Segmented label="Journal list" value={kind} onChange={setKind} options={[{ value: 'trades', label: 'Trades' }, { value: 'calls', label: 'Calls' }, { value: 'events', label: 'Events' }, { value: 'notes', label: 'Notes' }]} />
      <input className="inp mt-2" type="search" placeholder={`Filter ${kind}`} aria-label={`Filter ${kind}`} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="journal-filter" />
      <p className="mt-2 text-xs text-mute">{count} {kind}</p>
      <ul className="divide-y divide-line" data-testid={`list-${kind}`}>
        {kind === 'trades' && trades.map((t) => (
          <li key={t.id}>
            <Link href={`/ticket?id=${encodeURIComponent(t.id)}`} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[15px]"><span className={t.direction === 'long' ? 'text-up' : 'text-down'}>{t.direction === 'long' ? 'Long' : 'Short'}</span> {t.instrument} <span className="text-mute">· {t.accountId}</span></span>
                <span className="block text-xs text-mute">{dayTimeET(t.createdAt)} · {t.status}{t.overrides.length > 0 && ` · ${t.overrides.length} override${t.overrides.length > 1 ? 's' : ''}`}{t.result?.capturePct != null && ` · captured ${t.result.capturePct}%`}</span>
              </span>
              {t.result ? (
                <span className="shrink-0 text-right"><span className="block text-lg font-bold">{t.result.adherence}</span><span className={`block text-xs ${t.result.pnlUsd < 0 ? 'text-down' : 'text-up'}`}>{fmtSignedUsd(t.result.pnlUsd)}</span></span>
              ) : <Chip>{t.status}</Chip>}
            </Link>
          </li>
        ))}
        {kind === 'calls' && calls.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-[15px]">{c.instrument} · {callText(c.call)} <span className="font-semibold">{fmtProb(c.probability)}</span></span>
              <span className="block truncate text-xs text-mute">{dayTimeET(c.createdAt)} · {c.horizon} · {c.facts[0]}</span>
            </span>
            <span className="shrink-0 text-right text-sm">
              {c.outcome ? <><Chip tone={c.outcome.correct == null ? 'mute' : c.outcome.correct ? 'good' : 'bad'}>{c.outcome.correct == null ? 'Unscored' : c.outcome.correct ? 'Right' : 'Wrong'}</Chip><span className="mt-0.5 block text-xs text-mute">{c.outcome.movePct >= 0 ? '+' : '−'}{Math.abs(c.outcome.movePct).toFixed(2)}%</span></> : <Chip>Open</Chip>}
            </span>
          </li>
        ))}
        {kind === 'events' && events.map((e) => (
          <li key={e.id} className="py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-mute">{pretty(e.pattern)} · {dayTimeET(e.ts)}</p>
            <p className="mt-0.5 text-[15px] leading-snug">{e.text}</p>
            {e.followUp && <p className="mt-0.5 text-xs text-mute">{e.followUp.action ?? 'no action logged'}{e.followUp.outcomeUsd != null && ` · ${fmtSignedUsd(e.followUp.outcomeUsd)}`}</p>}
          </li>
        ))}
        {kind === 'notes' && notes.map((n) => (
          <li key={n.id} className="py-2.5">
            <p className="text-[15px] leading-snug">{n.text}</p>
            <p className="mt-0.5 text-xs text-mute">{dayTimeET(n.ts)} · {n.source}{n.tags.length > 0 && ` · ${n.tags.join(', ')}`}</p>
          </li>
        ))}
      </ul>
      {count === 0 && <Empty>{q ? 'Nothing matches.' : `No ${kind} yet.`}</Empty>}
    </Card>
  );
}

function AddNote() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const note = await api('POST /api/journal/notes', { body: { text: text.trim() } });
      patchCache<'GET /api/journal'>(keyOf('GET /api/journal'), (j) => ({ ...j, notes: [note, ...j.notes] }));
      setText('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    setBusy(false);
  };
  return (
    <Card title="Add a note">
      <form onSubmit={submit} className="space-y-2" data-testid="note-form">
        <textarea className="inp" rows={2} placeholder="What you saw, in your words" aria-label="Note" value={text} onChange={(e) => setText(e.target.value)} />
        {error && <ErrorLine error={error} />}
        <Btn kind="primary" type="submit" disabled={busy || text.trim().length === 0}>Save note</Btn>
      </form>
    </Card>
  );
}

export type JournalTab = 'journal' | 'weekly' | 'morning' | 'recap';

export function JournalScreen({ view }: { view: JournalTab }) {
  const q = useApi('GET /api/journal', null, 120_000);
  const j = q.data;
  const nav = (
    <nav aria-label="Journal pages" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
      {([['journal', 'Journal'], ['weekly', 'Weekly review'], ['morning', 'Morning brief'], ['recap', 'Recap']] as const).map(([v, label]) => (
        <Link key={v} href={v === 'journal' ? '/journal/' : `/journal?view=${v}`} aria-current={view === v ? 'page' : undefined} data-testid={`journal-nav-${v}`}
          className={`flex min-h-10 shrink-0 items-center rounded-full border px-3.5 text-sm ${view === v ? 'border-info bg-info/10 font-semibold text-ink' : 'border-line text-mute'}`}>{label}</Link>
      ))}
    </nav>
  );
  if (view !== 'journal') return <div className="space-y-3">{nav}<BriefView kind={view} /></div>;
  if (!j) return <div className="space-y-3">{nav}<Card title="Plan adherence">{q.error ? <ErrorLine error={q.error} retry={() => void q.refresh()} /> : <Loading />}</Card></div>;
  return (
    <div className="space-y-3" data-testid="journal-screen">
      <Stale since={q.staleSince} error={q.error} />
      <Card>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-mute">Plan adherence · last {j.adherenceCount} trades</p>
            <p className="text-6xl font-bold leading-none" data-testid="adherence">{j.adherence20 != null ? Math.round(j.adherence20) : '—'}<span className="ml-1 text-xl font-normal text-mute">/ 100</span></p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-mute">P&L, same trades</p>
            <p className={`text-lg font-semibold ${j.pnl20Usd != null && j.pnl20Usd < 0 ? 'text-down' : ''}`}>{j.pnl20Usd != null ? fmtSignedUsd(j.pnl20Usd) : '—'}</p>
          </div>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-sm">
          Overrides <span className="font-semibold">{fmtSignedUsd(j.ledger.monthToDateUsd)}</span> month to date across {j.ledger.instances}. Plan exits captured <span className="font-semibold">{j.ledger.planCapturePct ?? '—'}%</span> of available moves; overrides <span className="font-semibold">{j.ledger.overrideCapturePct ?? '—'}%</span>.
        </p>
      </Card>
      {nav}
      <Card title="Calibration" right={<span className="text-xs text-mute"><Chip tone={j.calibration.source === 'live' ? 'good' : 'warn'}>{j.calibration.source}</Chip> n = {j.calibration.n}</span>}>
        {j.calibration.n === 0 ? <Empty>No scored calls yet.</Empty> : <CalibrationChart cal={j.calibration} />}
        <p className="mt-1 text-xs text-mute">
          {j.calibration.source === 'replay' ? 'Replay: calls scored over recorded history, not live calls.' : j.calibration.source === 'mixed' ? 'Mixed: replay and live calls.' : 'Live calls only.'}
          {j.calibration.updatedAt && ` Updated ${dayTimeET(j.calibration.updatedAt)}.`}
        </p>
      </Card>
      <Lists j={j} />
      <AddNote />
      <Card title="Base rates">
        {j.baseRates.length === 0 ? <Empty>No base rates yet.</Empty> : (
          <ul className="divide-y divide-line">
            {j.baseRates.map((b, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0"><span className="block text-sm">{pretty(b.pattern)} <span className="text-mute">· {b.instrument} {b.tf}</span></span><span className="block text-xs text-mute">{b.definition}</span></span>
                <span className="shrink-0 text-right"><span className="block text-lg font-bold">{Math.round(b.hitRate * 100)}%</span><span className="block text-xs text-mute">n = {b.n} · {b.windowDays}d</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Guardrail scorecard">
        {j.guardrailScorecard.length === 0 ? <Empty>No firings yet.</Empty> : (
          <table className="w-full text-right text-[13px]" data-testid="scorecard">
            <thead className="text-[11px] uppercase text-mute"><tr><th scope="col" className="pb-1 text-left font-medium">Pattern</th><th scope="col" className="font-medium">Fired</th><th scope="col" className="font-medium">Kept</th><th scope="col" className="font-medium">Saved</th><th scope="col" className="font-medium">Cost</th></tr></thead>
            <tbody>
              {j.guardrailScorecard.map((g) => (
                <tr key={g.pattern} className="border-t border-line">
                  <th scope="row" className="py-1.5 text-left font-normal">{pretty(g.pattern)}{g.retired && <span className="ml-1 text-xs text-mute">retired</span>}</th>
                  <td>{g.fired}</td><td>{g.complied}/{g.complied + g.overrode}</td><td>{fmtUsd(g.savedUsd)}</td><td>{fmtUsd(g.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
