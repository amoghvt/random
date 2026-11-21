'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { Fill, OverrideKind, OverridePrompt, Ticket } from '@desk/contracts';
import { api } from '@/lib/api';
import { dayTimeET, fmtPrice, fmtSignedUsd, fmtUnits, num, pretty, timeET } from '@/lib/format';
import { keyOf, patchCache, revalidate, useApi } from '@/lib/store';
import { Btn, Card, Chip, ErrorLine, Field, Loading, Sheet, Stale, type Tone } from './ui';

const STATUS: Record<Ticket['status'], Tone> = { watch: 'warn', planned: 'info', open: 'good', closed: 'mute', cancelled: 'mute' };
const FILL_KINDS: ReadonlyArray<{ value: Fill['kind']; label: string }> = [
  { value: 'entry', label: 'Entry filled' }, { value: 'scale_out', label: 'Scale-out' }, { value: 'add', label: 'Added size' }, { value: 'stop', label: 'Stopped out' }, { value: 'exit', label: 'Exit' },
];
const OVERRIDES: OverrideKind[] = ['held_through_invalidation', 'held_through_time_stop', 'skipped_scale_out', 'added_to_loser', 'size_up', 'early_exit', 'moved_stop', 'other'];
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Failed');

function FillSheet({ ticket, onDone, onClose }: { ticket: Ticket; onDone: (t: Ticket) => void; onClose: () => void }) {
  const [kind, setKind] = useState<Fill['kind']>(ticket.status === 'open' ? 'scale_out' : 'entry');
  const [price, setPrice] = useState('');
  const [units, setUnits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = num(price), u = num(units);
    if (p === undefined || u === undefined) { setError('Price and size are required.'); return; }
    setBusy(true);
    try {
      onDone(await api('POST /api/tickets/:id/fill', { params: { id: ticket.id }, body: { fill: { ts: new Date().toISOString(), price: p, units: u, kind, source: 'manual' } } }));
    } catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Record a fill">
      <form onSubmit={submit} className="space-y-3" data-testid="fill-form">
        <Field label="What filled"><select className="inp" value={kind} onChange={(e) => setKind(e.target.value as Fill['kind'])}>{FILL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fill price"><input className="inp" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="Size filled" hint={`ticket ${fmtUnits(ticket.size.units)}`}><input className="inp" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} /></Field>
        </div>
        {error && <ErrorLine error={error} />}
        <Btn kind="primary" block type="submit" disabled={busy}>Record fill</Btn>
      </form>
    </Sheet>
  );
}

function CloseSheet({ ticket, onDone, onClose }: { ticket: Ticket; onDone: (t: Ticket) => void; onClose: () => void }) {
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = num(price);
    if (p === undefined) { setError('Exit price is required.'); return; }
    setBusy(true);
    try { onDone(await api('POST /api/tickets/:id/close', { params: { id: ticket.id }, body: { price: p, ts: new Date().toISOString() } })); } catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Close the trade">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Exit price" error={error}><input className="inp" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Btn kind="primary" block type="submit" disabled={busy}>Close and score</Btn>
      </form>
    </Sheet>
  );
}

/** The override costs a prompt: the server's text, the plan, live P&L, the ledger. Then a one-line reason. */
function OverrideSheet({ ticket, onDone, onClose }: { ticket: Ticket; onDone: (t: Ticket) => void; onClose: () => void }) {
  const prompt = useApi('GET /api/tickets/:id/override-prompt', { params: { id: ticket.id } });
  const [kind, setKind] = useState<OverrideKind>('held_through_time_stop');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p: OverridePrompt | undefined = prompt.data;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) { setError('One line: why.'); return; }
    setBusy(true);
    try { onDone(await api('POST /api/tickets/:id/override', { params: { id: ticket.id }, body: { kind, reason: reason.trim() } })); } catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Override the plan">
      {!p ? (prompt.error ? <ErrorLine error={prompt.error} retry={() => void prompt.refresh()} /> : <Loading />) : (
        <form onSubmit={submit} className="space-y-3" data-testid="override-form">
          <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[15px]" data-testid="override-prompt">{p.text}</p>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-mute">Live P&L</dt><dd className="text-lg font-bold">{p.livePnlUsd != null ? fmtSignedUsd(p.livePnlUsd) : '—'}</dd></div>
            <div><dt className="text-xs text-mute">Overrides, month to date</dt><dd className="text-lg font-bold">{fmtSignedUsd(p.ledger.monthToDateUsd)} <span className="text-xs font-normal text-mute">× {p.ledger.instances}</span></dd></div>
            <div><dt className="text-xs text-mute">Plan targets</dt><dd>{p.ticket.targets.map((t) => fmtPrice(t.price)).join(' / ')}</dd></div>
            <div><dt className="text-xs text-mute">Invalid · time stop</dt><dd>{fmtPrice(p.ticket.invalidation.price)} · {timeET(p.ticket.timeStop)}</dd></div>
          </dl>
          <Field label="What you are overriding"><select className="inp" value={kind} onChange={(e) => setKind(e.target.value as OverrideKind)}>{OVERRIDES.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></Field>
          <Field label="One line: why" error={error}><input className="inp" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="override-reason" /></Field>
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={onClose}>Keep the plan</Btn>
            <Btn kind="danger" className="flex-1" type="submit" disabled={busy || reason.trim().length < 3} data-testid="override-submit">Log override</Btn>
          </div>
        </form>
      )}
    </Sheet>
  );
}

export function TicketDetail({ id }: { id: string }) {
  const q = useApi('GET /api/tickets/:id', { params: { id } }, 30_000);
  const [sheet, setSheet] = useState<'fill' | 'close' | 'override' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const key = keyOf('GET /api/tickets/:id', { params: { id } });
  if (!q.data) return <Card title="Ticket">{q.error ? <ErrorLine error={q.error} retry={() => void q.refresh()} /> : <Loading lines={5} />}</Card>;
  const { ticket: t, ledger, events } = q.data;
  const done = (next: Ticket) => {
    patchCache<'GET /api/tickets/:id'>(key, (prev) => ({ ...prev, ticket: next }));
    setSheet(null);
    void q.refresh();
    void revalidate(keyOf('GET /api/positions'));
  };
  const cancel = async () => {
    try { done(await api('POST /api/tickets/:id/cancel', { params: { id } })); } catch (e) { setError(errText(e)); }
    setConfirmCancel(false);
  };
  const live = t.status === 'open' || t.status === 'planned' || t.status === 'watch';
  const r = t.result;
  return (
    <div className="space-y-3" data-testid="ticket-detail">
      <Stale since={q.staleSince} error={q.error} />
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold"><span className={t.direction === 'long' ? 'text-up' : 'text-down'}>{t.direction === 'long' ? 'Long' : 'Short'}</span> {t.instrument}</h1>
            <p className="text-sm text-mute">{t.accountId} · created {dayTimeET(t.createdAt)}</p>
          </div>
          <Chip tone={STATUS[t.status]}>{t.status}</Chip>
        </div>
        <dl className="mt-3 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-mute">Reason</dt>
          <dd>{t.reason.kind === 'catalyst'
            ? <Link className="text-info underline" href={`/catalysts?id=${encodeURIComponent(t.reason.catalystId)}`}>Catalyst {t.reason.catalystId}{t.reason.branchId ? ` · ${t.reason.branchId}` : ''}</Link>
            : `Confirmed setup ${t.reason.setupEventId}`}</dd>
          <dt className="text-mute">Entry</dt><dd>{t.entry.text}{t.entry.price != null && ` · ${fmtPrice(t.entry.price)}`}</dd>
          <dt className="text-mute">Size</dt><dd><span className="font-semibold">{fmtUnits(t.size.units)}</span> of engine max {fmtUnits(t.size.engineMaxUnits)}{t.size.leverage != null && ` · ${t.size.leverage}x`}</dd>
          <dt className="text-mute">Fail price</dt><dd className="text-down">{t.size.failPrice != null ? fmtPrice(t.size.failPrice) : '—'}</dd>
          <dt className="text-mute">Targets</dt><dd className="flex min-w-0 flex-wrap gap-x-3">{t.targets.map((x, i) => <span key={i} className="whitespace-nowrap">T{i + 1} {fmtPrice(x.price)} <span className="text-xs text-mute">{Math.round(x.fraction * 100)}%</span></span>)}</dd>
          <dt className="text-mute">Invalid</dt><dd>{fmtPrice(t.invalidation.price)} · {t.invalidation.reason}</dd>
          <dt className="text-mute">Time stop</dt><dd>{dayTimeET(t.timeStop)}</dd>
          {t.holdThroughCatalyst.flag && <><dt className="text-mute">Catalyst</dt><dd className="text-down">Held through {t.holdThroughCatalyst.catalystId ?? 'a catalyst'}</dd></>}
        </dl>
        {live && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Btn kind="primary" onClick={() => setSheet('fill')} data-testid="fill-btn">Record fill</Btn>
            {t.status === 'open' ? <Btn onClick={() => setSheet('close')} data-testid="close-btn">Close trade</Btn> : <Btn onClick={() => setConfirmCancel(true)}>Cancel ticket</Btn>}
            <Btn kind="danger" className="col-span-2" onClick={() => setSheet('override')} data-testid="override-btn">Override the plan</Btn>
          </div>
        )}
        {confirmCancel && <div className="mt-2 flex gap-2"><Btn kind="danger" className="flex-1" onClick={() => void cancel()}>Cancel the ticket</Btn><Btn className="flex-1" onClick={() => setConfirmCancel(false)}>Keep it</Btn></div>}
        {error && <ErrorLine error={error} />}
      </Card>

      {r && (
        <Card title="Result">
          <div className="flex items-end justify-between">
            <div><p className="text-[11px] uppercase tracking-wide text-mute">Plan adherence</p><p className="text-4xl font-bold">{r.adherence}</p></div>
            <div className="text-right"><p className="text-[11px] uppercase tracking-wide text-mute">P&L</p><p className={`text-xl font-semibold ${r.pnlUsd < 0 ? 'text-down' : 'text-up'}`}>{fmtSignedUsd(r.pnlUsd)}</p></div>
          </div>
          <p className="mt-2 text-sm">Exit {fmtPrice(r.exitPrice)} · captured {r.capturePct ?? '—'}% of the available move · after exit: best {r.mfeAfterExitPct ?? '—'}%, worst {r.maeAfterExitPct ?? '—'}%</p>
          {r.deductions.map((d, i) => <p key={i} className="text-sm text-warn">−{d.points} {pretty(d.kind)}</p>)}
        </Card>
      )}

      <Card title="Fills">
        {t.fills.length === 0 ? <p className="text-sm text-mute">No fills recorded.</p> : (
          <ul className="space-y-1 text-sm">{t.fills.map((x, i) => <li key={i} className="flex justify-between gap-2"><span>{pretty(x.kind)} · {fmtUnits(x.units)} @ {fmtPrice(x.price)}</span><span className="text-mute">{timeET(x.ts)} · {pretty(x.source)}</span></li>)}</ul>
        )}
      </Card>

      <Card title="Override ledger, month to date">
        <p data-testid="ledger"><span className="text-2xl font-bold">{fmtSignedUsd(ledger.monthToDateUsd)}</span> <span className="text-sm text-mute">across {ledger.instances} · last one that paid {ledger.lastPaidAt ? dayTimeET(ledger.lastPaidAt) : 'never'}</span></p>
        <p className="mt-1 text-sm">Plan exits captured {ledger.planCapturePct ?? '—'}% of available moves; overrides {ledger.overrideCapturePct ?? '—'}%.</p>
        {t.overrides.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            {t.overrides.map((o, i) => <li key={i}><span className="text-warn">{pretty(o.kind)}</span> · “{o.reason}” <span className="text-mute">{timeET(o.ts)}{o.pnlImpactUsd != null && ` · ${fmtSignedUsd(o.pnlImpactUsd)}`}</span></li>)}
          </ul>
        )}
      </Card>

      {events.length > 0 && (
        <Card title="Watcher events while live">
          <ul className="space-y-2 text-sm">{events.map((e) => <li key={e.id}>{e.text} <span className="text-xs text-mute">{e.tf} · {timeET(e.ts)}</span></li>)}</ul>
        </Card>
      )}

      {sheet === 'fill' && <FillSheet ticket={t} onDone={done} onClose={() => setSheet(null)} />}
      {sheet === 'close' && <CloseSheet ticket={t} onDone={done} onClose={() => setSheet(null)} />}
      {sheet === 'override' && <OverrideSheet ticket={t} onDone={done} onClose={() => setSheet(null)} />}
    </div>
  );
}
