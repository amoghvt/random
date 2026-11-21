'use client';
import { useState, type FormEvent } from 'react';
import type { AccountRow, PositionRow, PositionsView } from '@desk/contracts';
import { api } from '@/lib/api';
import { countdown, dayTimeET, fmtPct, fmtPrice, fmtSignedUsd, fmtUnits, fmtUsd, num, timeET } from '@/lib/format';
import { keyOf, setCache, useApi, useNow } from '@/lib/store';
import { Btn, Card, Chip, Empty, ErrorLine, Field, LinkBtn, Loading, Segmented, Sheet, Stale, type Tone } from './ui';

const STATUS_TONE: Record<string, Tone> = { Safe: 'good', Thin: 'warn', Critical: 'bad' };
const KEY = keyOf('GET /api/positions');
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Failed');
const store = (v: PositionsView): void => setCache<'GET /api/positions'>(KEY, v);

export function usePositions() {
  return useApi('GET /api/positions', null, 30_000);
}

function Row({ r, account, onOpen }: { r: PositionRow; account: string; onOpen: () => void }) {
  const { position: p, status: s, ticket, nextTarget } = r;
  return (
    <li>
      <button type="button" onClick={onOpen} data-testid="position-row" className="block w-full py-3 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[15px]">
            <span className={`font-semibold ${p.direction === 'long' ? 'text-up' : 'text-down'}`}>{p.direction === 'long' ? 'Long' : 'Short'}</span>{' '}
            <span className="font-semibold">{p.instrument}</span> <span className="text-mute">· {account}</span>
          </span>
          {s ? <Chip tone={STATUS_TONE[s.status] ?? 'mute'}>{s.status}</Chip> : <Chip>No status</Chip>}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <div><span className="text-mute">P&L </span><span className={`text-lg font-bold ${s && s.pnlUsd < 0 ? 'text-down' : s && s.pnlUsd > 0 ? 'text-up' : ''}`}>{s ? fmtSignedUsd(s.pnlUsd) : '—'}</span></div>
          <div className="text-right"><span className="text-mute">To fail </span><span className="font-semibold">{s ? `${fmtPrice(s.distancePts)} pts · ${s.distancePct.toFixed(2)}%` : '—'}</span></div>
          <div className="text-mute">Next out <span className="text-ink">{nextTarget ? `${fmtPrice(nextTarget.price)} (${Math.round(nextTarget.fraction * 100)}%)` : '—'}</span></div>
          <div className="text-right text-mute">Time stop <span className="text-ink">{ticket ? timeET(ticket.timeStop) : '—'}</span></div>
        </div>
      </button>
    </li>
  );
}

function Detail({ r, account, onClose }: { r: PositionRow; account: string; onClose: () => void }) {
  const { position: p, status: s, ticket } = r;
  const detail = useApi(ticket ? 'GET /api/tickets/:id' : null, ticket ? { params: { id: ticket.id } } : null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    try { store(await api('DELETE /api/positions/:id', { params: { id: p.id } })); onClose(); } catch (e) { setError(errText(e)); }
  };
  const l = detail.data?.ledger;
  return (
    <Sheet open onClose={onClose} title={`${p.direction === 'long' ? 'Long' : 'Short'} ${p.instrument} · ${account}`}>
      <div className="space-y-3 text-sm">
        {s && <p className="text-[15px]">{s.line}</p>}
        <dl className="grid grid-cols-2 gap-2">
          <div><dt className="text-xs text-mute">Size</dt><dd className="font-semibold">{fmtUnits(p.units)}{p.leverage != null ? ` · ${p.leverage}x` : ''}</dd></div>
          <div><dt className="text-xs text-mute">Entry</dt><dd className="font-semibold">{fmtPrice(p.entryPrice)}</dd></div>
          <div><dt className="text-xs text-mute">Mark</dt><dd className="font-semibold">{s ? fmtPrice(s.mark) : '—'} {s && <span className="text-xs font-normal text-mute">as of {timeET(s.asOf)}</span>}</dd></div>
          <div><dt className="text-xs text-mute">Fail price</dt><dd className="font-semibold text-down">{s ? fmtPrice(s.failPrice) : '—'}</dd></div>
          {s?.nextLockOrSnapshot && <div><dt className="text-xs text-mute">{s.nextLockOrSnapshot.what}</dt><dd className="font-semibold">{dayTimeET(s.nextLockOrSnapshot.at)}</dd></div>}
          {s?.catalystInWindow && <div><dt className="text-xs text-mute">Catalyst in window</dt><dd className="font-semibold text-down">{s.catalystInWindow.name} · {timeET(s.catalystInWindow.at)}</dd></div>}
        </dl>
        {ticket ? (
          <>
            <div className="rounded-xl border border-line p-3">
              <p className="text-xs uppercase tracking-wide text-mute">Ticket · {ticket.status}</p>
              <p className="mt-1">Targets {ticket.targets.map((t) => fmtPrice(t.price)).join(' / ')}</p>
              <p>Invalid {fmtPrice(ticket.invalidation.price)} · {ticket.invalidation.reason}</p>
              <p>Time stop {dayTimeET(ticket.timeStop)}</p>
            </div>
            <div className="rounded-xl border border-line p-3" data-testid="override-ledger">
              <p className="text-xs uppercase tracking-wide text-mute">Override ledger, month to date</p>
              {l ? (
                <p className="mt-1"><span className="text-lg font-bold">{fmtSignedUsd(l.monthToDateUsd)}</span> across {l.instances} · plan exits captured {l.planCapturePct ?? '—'}%, overrides {l.overrideCapturePct ?? '—'}%</p>
              ) : detail.error ? <ErrorLine error={detail.error} /> : <Loading lines={1} />}
            </div>
            <LinkBtn kind="primary" block href={`/ticket?id=${encodeURIComponent(ticket.id)}`}>Open ticket</LinkBtn>
          </>
        ) : <p className="text-mute">No ticket. This position is untracked against a plan.</p>}
        <LinkBtn block href={`/chart?symbol=${encodeURIComponent(p.instrument)}`}>Chart with the fail price</LinkBtn>
        {confirm
          ? <div className="flex gap-2"><Btn kind="danger" className="flex-1" onClick={() => void remove()} data-testid="remove-confirm">Remove from the desk</Btn><Btn className="flex-1" onClick={() => setConfirm(false)}>Keep</Btn></div>
          : <Btn kind="quiet" block onClick={() => setConfirm(true)} data-testid="remove-position">Remove position</Btn>}
        <p className="text-xs text-mute">Removing only stops tracking it here. The desk places no orders.</p>
        {error && <ErrorLine error={error} />}
      </div>
    </Sheet>
  );
}

function AccountCard({ a }: { a: AccountRow }) {
  const now = useNow();
  const [edit, setEdit] = useState(false);
  const [balance, setBalance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const positions = usePositions();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const b = num(balance);
    if (b === undefined) { setError('Enter the balance as a number.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api('PUT /api/accounts/:id/state', { params: { id: a.rules.id }, body: { balance: b } });
      await positions.refresh();
      setEdit(false);
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  const d = a.nextDeadline;
  return (
    <li className="py-3" data-testid="account-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-semibold">{a.rules.name}{!a.state.active && <span className="ml-2 text-xs font-normal text-mute">inactive</span>}</span>
        <span className="shrink-0 text-lg font-bold">{fmtUsd(a.state.balance)}</span>
      </div>
      <p className="text-xs text-mute">Room {fmtUsd(a.roomUsd)} to the floor at {fmtUsd(a.floorUsd)} · day {fmtSignedUsd(a.state.dayPnl)} · balance as of {dayTimeET(a.state.asOf)}</p>
      <p className="mt-1.5 text-sm">{a.payoutLine}{a.claimableUsd != null && a.claimableUsd > 0 && <Chip tone="good" className="ml-2">Claimable {fmtUsd(a.claimableUsd)}</Chip>}</p>
      {a.consistencyLine && <p className="mt-1 text-sm text-warn">{a.consistencyLine}</p>}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-sm text-mute">{d ? <>{d.what} <span className="text-ink">{dayTimeET(d.at)}</span>{now > 0 && Date.parse(d.at) > now && ` · ${countdown(Date.parse(d.at) - now)}`}</> : 'No deadline.'}</p>
        {!edit && <Btn kind="quiet" className="!min-h-9 shrink-0 !px-2" onClick={() => { setBalance(String(a.state.balance)); setEdit(true); }} data-testid="edit-balance">Set balance</Btn>}
      </div>
      {edit && (
        <form onSubmit={save} className="mt-2 flex items-end gap-2">
          <div className="flex-1"><Field label="Real balance, USD" error={error}><input className="inp" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} aria-label={`Balance for ${a.rules.name}`} /></Field></div>
          <Btn kind="primary" type="submit" disabled={busy}>Save</Btn>
          <Btn onClick={() => setEdit(false)}>Cancel</Btn>
        </form>
      )}
    </li>
  );
}

function AddPosition({ accounts, onClose }: { accounts: AccountRow[]; onClose: () => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.rules.id ?? '');
  const account = accounts.find((a) => a.rules.id === accountId);
  const [instrument, setInstrument] = useState(account?.rules.instruments[0] ?? '');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [units, setUnits] = useState('');
  const [entry, setEntry] = useState('');
  const [liq, setLiq] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const perp = account?.rules.venue === 'perp';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = num(units), p = num(entry);
    if (!accountId || !instrument || u === undefined || p === undefined) { setError('Account, instrument, size and entry price are required.'); return; }
    setBusy(true);
    try {
      store(await api('POST /api/positions', { body: { accountId, instrument, direction, units: u, entryPrice: p, liquidationPrice: num(liq) ?? null } }));
      onClose();
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  return (
    <Sheet open onClose={onClose} title="Add a position you hold">
      <form onSubmit={submit} className="space-y-3" data-testid="add-position-form">
        <Field label="Account">
          <select className="inp" value={accountId} onChange={(e) => { setAccountId(e.target.value); setInstrument(accounts.find((a) => a.rules.id === e.target.value)?.rules.instruments[0] ?? ''); }}>
            {accounts.map((a) => <option key={a.rules.id} value={a.rules.id}>{a.rules.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Instrument">
            <select className="inp" value={instrument} onChange={(e) => setInstrument(e.target.value)}>
              {(account?.rules.instruments ?? []).map((i) => <option key={i}>{i}</option>)}
            </select>
          </Field>
          <Field label="Direction"><Segmented label="Direction" value={direction} onChange={setDirection} options={[{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} /></Field>
          <Field label={perp ? 'Size, USD notional' : 'Size, contracts'}><input className="inp" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} /></Field>
          <Field label="Entry price"><input className="inp" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /></Field>
        </div>
        {perp && <Field label="Venue liquidation price" hint="optional"><input className="inp" inputMode="decimal" value={liq} onChange={(e) => setLiq(e.target.value)} /></Field>}
        <p className="text-xs text-mute">This records a position you already hold so the monitor can track its fail price. It sizes nothing.</p>
        {error && <ErrorLine error={error} />}
        <Btn kind="primary" block type="submit" disabled={busy}>Add position</Btn>
      </form>
    </Sheet>
  );
}

export function PositionsList({ compact = false }: { compact?: boolean }) {
  const pos = usePositions();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const v = pos.data;
  if (!v) return <Card title="Positions">{pos.error ? <ErrorLine error={pos.error} retry={() => void pos.refresh()} /> : <Loading />}</Card>;
  const name = (id: string): string => v.accounts.find((a) => a.rules.id === id)?.rules.name ?? id;
  const openRow = v.positions.find((r) => r.position.id === open);
  return (
    <div className="space-y-3" data-testid="positions-screen">
      <Stale since={pos.staleSince} error={pos.error} />
      {v.hedgeViolations.map((h, i) => (
        <div key={i} role="alert" data-testid="hedge-violation" className="rounded-2xl border border-down/60 bg-down/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-down">Rule violation · cross-account hedge</p>
          <p className="mt-1 text-[15px]">{h.text}</p>
          <p className="mt-1 text-xs text-mute">Clause: “{h.clause}”</p>
        </div>
      ))}
      <Card title={`Open positions · ${v.positions.length}`} right={<span className="text-xs text-mute">as of {timeET(v.asOf)}</span>}>
        {v.positions.length === 0 ? <Empty>Flat on every account.</Empty> : (
          <ul className="-my-3 divide-y divide-line">
            {v.positions.map((r) => <Row key={r.position.id} r={r} account={name(r.position.accountId)} onOpen={() => setOpen(r.position.id)} />)}
          </ul>
        )}
        <Btn kind="ghost" block className="mt-4" onClick={() => setAdding(true)} disabled={v.accounts.length === 0} data-testid="add-position">Add a position</Btn>
      </Card>
      {!compact && (
        <Card title="Accounts · payout and consistency">
          {v.accounts.length === 0 ? <Empty>No accounts configured.</Empty> : <ul className="-my-3 divide-y divide-line">{v.accounts.map((a) => <AccountCard key={a.rules.id} a={a} />)}</ul>}
        </Card>
      )}
      {openRow && <Detail r={openRow} account={name(openRow.position.accountId)} onClose={() => setOpen(null)} />}
      {adding && <AddPosition accounts={v.accounts} onClose={() => setAdding(false)} />}
    </div>
  );
}
export { fmtPct as _fmtPct };
