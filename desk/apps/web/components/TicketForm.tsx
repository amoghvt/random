'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StructureEvent, TicketDraft, TicketPreview, TicketReason, TradePlan } from '@desk/contracts';
import { api } from '@/lib/api';
import { chartSymbol, countdown, dayTimeET, fmtPrice, fmtUnits, fmtUsd, fmtUsdCompact, fromLocalInput, num, pretty, timeET, toLocalInput } from '@/lib/format';
import { useApi, useNow } from '@/lib/store';
import { useCatalysts } from './Catalysts';
import { Btn, Card, Chip, ErrorLine, Field, Guardrail, Segmented, Stat } from './ui';

type EntryKind = 'price' | 'time' | 'condition';
interface Form {
  reasonKind: 'catalyst' | 'structure'; catalystId: string; branchId: string; setupEventId: string;
  instrument: string; direction: 'long' | 'short'; accountId: string;
  entryKind: EntryKind; entryText: string; entryPrice: string; entryAt: string;
  /** null takes the engine size; a number is a reduction. */
  units: number | null;
  targets: Array<{ price: string; pct: string }>;
  invPrice: string; invReason: string; timeStop: string; notes: string;
}
const THIRD = '33.3';
const EMPTY: Form = {
  reasonKind: 'catalyst', catalystId: '', branchId: '', setupEventId: '', instrument: '', direction: 'long', accountId: '',
  entryKind: 'condition', entryText: '', entryPrice: '', entryAt: '', units: null,
  targets: [{ price: '', pct: THIRD }, { price: '', pct: THIRD }, { price: '', pct: THIRD }],
  invPrice: '', invReason: '', timeStop: '', notes: '',
};
const pctOf = (fraction: number): string => (Math.abs(fraction - 1 / 3) < 0.002 ? THIRD : String(Math.round(fraction * 1000) / 10));
const fractionOf = (pct: string): number | undefined => {
  const n = num(pct);
  return n === undefined ? undefined : Math.abs(n - 33.3) < 0.06 ? 1 / 3 : n / 100;
};

function fromPlan(plan: TradePlan, reason?: TicketReason): Partial<Form> {
  return {
    instrument: plan.instrument, direction: plan.direction, ...(plan.accountId ? { accountId: plan.accountId } : {}),
    entryKind: plan.entry.kind, entryText: plan.entry.text, entryPrice: plan.entry.price != null ? String(plan.entry.price) : '', entryAt: toLocalInput(plan.entry.at),
    targets: plan.targets.map((t) => ({ price: String(t.price), pct: pctOf(t.fraction) })),
    invPrice: String(plan.invalidation.price), invReason: plan.invalidation.reason, timeStop: toLocalInput(plan.timeStop.at), units: null,
    ...(reason?.kind === 'catalyst' ? { reasonKind: 'catalyst' as const, catalystId: reason.catalystId, branchId: reason.branchId ?? '' } : {}),
    ...(reason?.kind === 'structure' ? { reasonKind: 'structure' as const, setupEventId: reason.setupEventId } : {}),
  };
}

function toDraft(f: Form): TicketDraft {
  const reason = f.reasonKind === 'catalyst'
    ? (f.catalystId ? { kind: 'catalyst', catalystId: f.catalystId, ...(f.branchId ? { branchId: f.branchId } : {}) } : null)
    : (f.setupEventId ? { kind: 'structure', setupEventId: f.setupEventId } : null);
  return {
    accountId: f.accountId, instrument: f.instrument, direction: f.direction, reason,
    entry: { kind: f.entryKind, text: f.entryText.trim(), ...(f.entryKind === 'price' ? { price: num(f.entryPrice) } : {}), ...(f.entryKind === 'time' ? { at: fromLocalInput(f.entryAt) } : {}) },
    ...(f.units != null ? { units: f.units } : {}),
    targets: f.targets.map((t) => ({ price: num(t.price), fraction: fractionOf(t.pct) })),
    invalidation: { price: num(f.invPrice), reason: f.invReason.trim() },
    timeStop: fromLocalInput(f.timeStop),
    ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
  };
}

export interface Prefill { notificationId?: string; callId?: string; catalystId?: string; branchId?: string }

export function TicketForm({ prefill }: { prefill: Prefill }) {
  const router = useRouter();
  const now = useNow();
  const [f, setF] = useState<Form>(EMPTY);
  const set = (patch: Partial<Form>) => setF((prev) => ({ ...prev, ...patch }));
  const [preview, setPreview] = useState<TicketPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const applied = useRef(false);

  const accounts = useApi('GET /api/accounts');
  const catalysts = useCatalysts();
  const nowView = useApi('GET /api/now');
  const notes = useApi(prefill.notificationId ? 'GET /api/notifications' : null);
  const sym = f.instrument ? chartSymbol(f.instrument) : null;
  const chart15 = useApi(sym && f.reasonKind === 'structure' ? 'GET /api/charts/:symbol' : null, sym ? { params: { symbol: sym }, query: { tf: '15m' } } : null);
  const chart1 = useApi(sym && f.reasonKind === 'structure' ? 'GET /api/charts/:symbol' : null, sym ? { params: { symbol: sym }, query: { tf: '1m' } } : null);
  const setups = useMemo(() => {
    const seen = new Map<string, StructureEvent>();
    for (const e of [...(chart1.data?.levels ?? []), ...(chart15.data?.levels ?? [])]) if (e.confirmedSetup) seen.set(e.id, e);
    return [...seen.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }, [chart1.data, chart15.data]);

  // Pre-fill once, from the notification, the bias call or a catalyst branch.
  useEffect(() => {
    if (applied.current) return;
    if (prefill.notificationId) {
      const n = notes.data?.find((x) => x.id === prefill.notificationId);
      if (!notes.data) return;
      applied.current = true;
      if (n?.ticketPrefill) {
        const { reason, ...plan } = n.ticketPrefill;
        set(fromPlan(plan, reason));
        setPrefilledFrom(`notification: ${n.lines[0] ?? n.reason}`);
      } else setPrefilledFrom('That notification carries no ticket.');
    } else if (prefill.callId) {
      const c = nowView.data?.calls.find((x) => x.id === prefill.callId);
      if (!nowView.data || !catalysts.data) return;
      applied.current = true;
      if (c?.trade) {
        const cat = catalysts.data.find((x) => x.id === c.trigger.ref);
        const setup = c.trigger.kind === 'level' ? c.trigger.ref : null;
        set(fromPlan(c.trade, cat ? { kind: 'catalyst', catalystId: cat.id } : setup ? { kind: 'structure', setupEventId: setup } : undefined));
        setPrefilledFrom(`bias call: ${c.instrument} ${pretty(c.call)} ${c.probability.toFixed(2)}`);
      }
    } else if (prefill.catalystId) {
      const cat = catalysts.data?.find((x) => x.id === prefill.catalystId);
      if (!catalysts.data) return;
      applied.current = true;
      const b = cat?.matrix?.branches.find((x) => x.id === prefill.branchId);
      if (cat) {
        set({ reasonKind: 'catalyst', catalystId: cat.id, branchId: b?.id ?? '', ...(b?.trade ? fromPlan(b.trade) : {}) });
        setPrefilledFrom(`${cat.name}${b ? `, branch ${b.label}` : ''}`);
      }
    } else applied.current = true;
  }, [prefill, notes.data, nowView.data, catalysts.data]);

  // Default the account and instrument once the account list arrives.
  useEffect(() => {
    const list = accounts.data;
    if (!list || list.length === 0) return;
    setF((prev) => {
      const account = list.find((a) => a.rules.id === prev.accountId) ?? (prev.instrument ? list.find((a) => a.rules.instruments.includes(prev.instrument)) : undefined) ?? list[0]!;
      const instrument = account.rules.instruments.includes(prev.instrument) ? prev.instrument : account.rules.instruments[0] ?? '';
      return account.rules.id === prev.accountId && instrument === prev.instrument ? prev : { ...prev, accountId: account.rules.id, instrument };
    });
  }, [accounts.data, f.accountId, f.instrument]);

  const draft = useMemo(() => toDraft(f), [f]);
  const draftJson = JSON.stringify(draft);
  const seq = useRef(0);
  useEffect(() => {
    if (!f.accountId || !f.instrument) return;
    setPending(true);
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      api('POST /api/tickets/preview', { body: JSON.parse(draftJson) as TicketDraft })
        .then((p) => { if (mine === seq.current) { setPreview(p); setPreviewError(null); setPending(false); } })
        .catch((e: unknown) => { if (mine === seq.current) { setPreviewError(e instanceof Error ? e.message : 'Preview failed'); setPending(false); } });
    }, 350);
    return () => window.clearTimeout(t);
  }, [draftJson, f.accountId, f.instrument]);

  const sizing = preview?.sizing ?? null;
  const max = sizing?.maxUnits ?? 0;
  // A reduction above a newly smaller engine size falls back to the engine size.
  useEffect(() => { if (f.units != null && max > 0 && f.units >= max) set({ units: null }); }, [f.units, max]);

  const errs = (field: string): string | null => {
    const hit = preview?.errors.filter((e) => e.field === field || e.field.startsWith(`${field}.`) || e.field.startsWith(`${field}[`)) ?? [];
    return hit.length ? hit.map((e) => e.message).join(' ') : null;
  };
  const KNOWN = ['reason', 'instrument', 'direction', 'accountId', 'entry', 'units', 'targets', 'invalidation', 'timeStop'];
  const otherErrors = preview?.errors.filter((e) => !KNOWN.some((k) => e.field === k || e.field.startsWith(`${k}.`) || e.field.startsWith(`${k}[`))) ?? [];

  const account = accounts.data?.find((a) => a.rules.id === f.accountId);
  const cat = catalysts.data?.find((c) => c.id === f.catalystId);
  const branch = cat?.matrix?.branches.find((b) => b.id === f.branchId);
  const step = Number.isInteger(max) && max <= 500 ? 1 : max / 100;
  const units = f.units ?? max;
  const canSave = preview != null && preview.ok && !pending && !saving && !previewError;
  const cooldown = preview?.reentryCooldownUntil ? Date.parse(preview.reentryCooldownUntil) - now : 0;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api('POST /api/tickets', { body: draft });
      if (r.ticket) router.replace(`/ticket?id=${encodeURIComponent(r.ticket.id)}`);
      else setPreview(r);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Save failed');
    }
    setSaving(false);
  };
  const saveLabel = !preview ? 'Waiting for the sizing preview' : pending ? 'Checking' : preview.wouldSaveAs === 'blocked' || !preview.ok ? 'Blocked' : preview.wouldSaveAs === 'watch' ? 'Save as watch' : 'Save ticket';

  return (
    <form className="space-y-3 pb-28" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }} data-testid="ticket-form" noValidate>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">New ticket</h1>
        <Btn kind="quiet" onClick={() => router.back()}>Close</Btn>
      </div>
      {prefilledFrom && <p className="text-sm text-mute" data-testid="prefilled">Pre-filled from {prefilledFrom}</p>}
      {nowView.data?.session.readOnly && <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Read-only. {nowView.data.session.readOnlyReason}</p>}

      <Card title="1 · Reason">
        <div className="space-y-3">
          <Segmented label="Reason type" value={f.reasonKind} onChange={(v) => set({ reasonKind: v })} options={[{ value: 'catalyst', label: 'Catalyst' }, { value: 'structure', label: 'Confirmed setup' }]} />
          {f.reasonKind === 'catalyst' ? (
            <>
              <Field label="Catalyst" error={errs('reason')}>
                <select className="inp" value={f.catalystId} aria-invalid={errs('reason') != null} onChange={(e) => set({ catalystId: e.target.value, branchId: '' })} data-testid="reason-catalyst">
                  <option value="">Pick a catalyst</option>
                  {(catalysts.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {dayTimeET(c.scheduledAt)} · T{c.tier}</option>)}
                  {f.catalystId && !cat && <option value={f.catalystId}>{f.catalystId}</option>}
                </select>
              </Field>
              {cat?.matrix && (
                <Field label="Branch" hint="optional">
                  <select className="inp" value={f.branchId} onChange={(e) => set({ branchId: e.target.value })}>
                    <option value="">No branch</option>
                    {cat.matrix.branches.map((b) => <option key={b.id} value={b.id}>{b.label} · {Math.round(b.probability * 100)}%{b.trade ? '' : ' · no trade'}</option>)}
                  </select>
                </Field>
              )}
              {branch?.trade && <Btn kind="quiet" className="!px-0" onClick={() => set(fromPlan(branch.trade!))}>Use the branch plan</Btn>}
              {branch && !branch.trade && <p className="text-sm text-warn">{branch.noTradeReason ?? 'No edge, stand aside'}</p>}
            </>
          ) : (
            <Field label={`Confirmed setup${sym ? ` on ${sym}` : ''}`} error={errs('reason')}>
              <select className="inp" value={f.setupEventId} aria-invalid={errs('reason') != null} onChange={(e) => set({ setupEventId: e.target.value })} data-testid="reason-setup">
                <option value="">{setups.length ? 'Pick a setup' : 'No confirmed setup right now'}</option>
                {setups.map((s) => <option key={s.id} value={s.id}>{s.tf} · {timeET(s.ts)} · {s.text}</option>)}
                {f.setupEventId && !setups.some((s) => s.id === f.setupEventId) && <option value={f.setupEventId}>{f.setupEventId}</option>}
              </select>
            </Field>
          )}
          <p className="text-xs text-mute">No catalyst, no trade. Free text is not a reason.</p>
        </div>
      </Card>

      <Card title="2 · Instrument, direction, account">
        <div className="space-y-3">
          <Field label="Account" error={errs('accountId')}>
            <select className="inp" value={f.accountId} onChange={(e) => set({ accountId: e.target.value, units: null })} data-testid="account">
              {(accounts.data ?? []).map((a) => <option key={a.rules.id} value={a.rules.id}>{a.rules.name} · room {fmtUsd(a.roomUsd)}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Instrument" error={errs('instrument')}>
              <select className="inp" value={f.instrument} onChange={(e) => set({ instrument: e.target.value, units: null, setupEventId: '' })} data-testid="instrument">
                {(account?.rules.instruments ?? []).map((i) => <option key={i}>{i}</option>)}
              </select>
            </Field>
            <Field label="Direction" error={errs('direction')}>
              <Segmented label="Direction" value={f.direction} onChange={(v) => set({ direction: v })} options={[{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="3 · Entry trigger">
        <div className="space-y-3">
          <Segmented label="Trigger type" value={f.entryKind} onChange={(v) => set({ entryKind: v })} options={[{ value: 'price', label: 'Price' }, { value: 'time', label: 'Time' }, { value: 'condition', label: 'Condition' }]} />
          {f.entryKind === 'price' && <Field label="Trigger price"><input className="inp" inputMode="decimal" value={f.entryPrice} onChange={(e) => set({ entryPrice: e.target.value })} data-testid="entry-price" /></Field>}
          {f.entryKind === 'time' && <Field label="Trigger time, local" hint={f.entryAt ? timeET(fromLocalInput(f.entryAt)) : undefined}><input className="inp" type="datetime-local" value={f.entryAt} onChange={(e) => set({ entryAt: e.target.value })} /></Field>}
          <Field label="Trigger, in words" error={errs('entry')}>
            <input className="inp" value={f.entryText} aria-invalid={errs('entry') != null} placeholder="Second move after 08:45 ET if the 10Y confirms" onChange={(e) => set({ entryText: e.target.value })} data-testid="entry-text" />
          </Field>
        </div>
      </Card>

      <Card title="4 · Size" right={sizing && <span className="text-xs text-mute">sized {timeET(sizing.asOf)}</span>}>
        {!sizing ? (
          <p className="text-sm text-mute" data-testid="size-wait">{previewError ? 'No sizing: the preview failed.' : 'The account-rules engine sets the size. Waiting for the preview.'}</p>
        ) : (
          <div className="space-y-3" data-testid="sizing">
            {sizing.blocked && <p role="alert" className="rounded-xl border border-down/50 bg-down/10 px-3 py-2 text-sm">{sizing.blockReason ?? 'Blocked by the sizing engine.'}</p>}
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-mute">Size{f.units != null ? ' · reduced' : ' · engine max'}</p>
                <output className="text-3xl font-bold" data-testid="size-value">{fmtUnits(units)}</output>
              </div>
              <p className="text-right text-xs text-mute">Engine max <span className="text-ink" data-testid="size-max">{fmtUnits(max)}</span><br />down only, never up</p>
            </div>
            <input type="range" aria-label="Reduce size" data-testid="size-slider" min={step} max={max} step={step} value={units} disabled={max <= 0 || max <= step}
              onChange={(e) => { const v = Number(e.target.value); set({ units: v >= max ? null : v }); }} />
            {errs('units') && <ErrorLine error={errs('units')!} />}
            <div className="grid grid-cols-3 gap-3 border-t border-line pt-3">
              <Stat label="Notional" value={fmtUsdCompact(sizing.notionalUsd)} sub="at engine max" />
              <Stat label="Leverage" value={sizing.leverage != null ? `${sizing.leverage}x` : '—'} />
              <Stat label="Fail price" tone="down" value={sizing.failPrice != null ? fmtPrice(sizing.failPrice) : '—'}
                sub={sizing.failDistancePts != null && sizing.failDistancePct != null ? `${fmtPrice(sizing.failDistancePts)} pts · ${sizing.failDistancePct.toFixed(2)}%` : undefined} />
            </div>
            <p className="text-sm"><span className="text-mute">Worst move ({pretty(sizing.worstMove.basis)}) </span>{sizing.worstMove.text}</p>
            <p className="text-xs text-mute">
              Room {fmtUsd(sizing.room.toDrawdownUsd)} to drawdown{sizing.room.toDailyLimitUsd != null && `, ${fmtUsd(sizing.room.toDailyLimitUsd)} to the daily limit`}; usable {fmtUsd(sizing.room.usableUsd)} after a {sizing.room.cushionPct}% cushion. Binding: {pretty(sizing.room.binding)}.
            </p>
            {sizing.catalystInWindow && <p className="text-sm text-down">In the window: {sizing.catalystInWindow.name}{sizing.catalystInWindow.impliedMovePct != null && `, implied ±${sizing.catalystInWindow.impliedMovePct}%`}</p>}
            {sizing.notes.map((n, i) => <p key={i} className="text-xs text-mute">{n}</p>)}
            {sizing.payoutNote && <p className="text-sm text-warn">{sizing.payoutNote}</p>}
          </div>
        )}
      </Card>

      <Card title="5 · Targets and scale-out">
        <div className="space-y-2">
          {f.targets.map((t, i) => (
            <div key={i} className="grid grid-cols-[2rem_1fr_6rem] items-center gap-2">
              <span className="text-sm font-semibold text-mute">T{i + 1}</span>
              <input className="inp" inputMode="decimal" placeholder="Price" aria-label={`Target ${i + 1} price`} aria-invalid={errs('targets') != null} value={t.price} data-testid={`t${i + 1}-price`}
                onChange={(e) => set({ targets: f.targets.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
              <span className="relative">
                <input className="inp text-right" style={{ paddingRight: 30 }} inputMode="decimal" aria-label={`Target ${i + 1} share of size, percent`} value={t.pct}
                  onChange={(e) => set({ targets: f.targets.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)) })} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-mute">%</span>
              </span>
            </div>
          ))}
          {errs('targets') && <ErrorLine error={errs('targets')!} />}
          <p className="text-xs text-mute">Default one-third each. The runner carries a trailing stop at the prior swing.</p>
        </div>
      </Card>

      <Card title="6 · Invalidation">
        <div className="space-y-3">
          <Field label="Invalidation price"><input className="inp" inputMode="decimal" aria-invalid={errs('invalidation') != null} value={f.invPrice} onChange={(e) => set({ invPrice: e.target.value })} data-testid="inv-price" /></Field>
          <Field label="Why it kills the thesis" error={errs('invalidation')}>
            <input className="inp" aria-invalid={errs('invalidation') != null} placeholder="Reclaims the after-hours high with chips leading" value={f.invReason} onChange={(e) => set({ invReason: e.target.value })} data-testid="inv-reason" />
          </Field>
        </div>
      </Card>

      <Card title="7 · Time stop">
        <Field label="Latest time the thesis is valid, local" error={errs('timeStop')} hint={f.timeStop ? dayTimeET(fromLocalInput(f.timeStop)) : undefined}>
          <input className="inp" type="datetime-local" aria-invalid={errs('timeStop') != null} value={f.timeStop} onChange={(e) => set({ timeStop: e.target.value })} data-testid="time-stop" />
        </Field>
      </Card>

      {preview && preview.guardrails.length > 0 && <div className="space-y-2">{preview.guardrails.map((g) => <Guardrail key={g.id} f={g} />)}</div>}

      <div className="fixed inset-x-0 bottom-[calc(var(--tab-h)+var(--sab))] z-20 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur lg:bottom-0">
        <div className="mx-auto max-w-[688px]">
          <div className="mb-2 text-sm" data-testid="save-status" aria-live="polite">
            {previewError ? <span className="text-down">Preview failed: {previewError}</span>
              : !preview ? <span className="text-mute">Checking with the server.</span>
              : preview.ok ? <span>Would save as <Chip tone={preview.wouldSaveAs === 'planned' ? 'good' : 'warn'}>{preview.wouldSaveAs}</Chip>{preview.wouldSaveAs === 'watch' && <span className="ml-2 text-mute">{preview.guardrails.find((g) => g.effect === 'downgrade_to_watch')?.text}</span>}</span>
              : (
                <span className="text-down">
                  Blocked: {preview.errors.length > 0 ? `${preview.errors.length} field${preview.errors.length > 1 ? 's' : ''} missing or invalid` : preview.guardrails.find((g) => g.blocks)?.text ?? sizing?.blockReason ?? 'see above'}
                  {otherErrors.map((e, i) => <span key={i} className="block">{e.message}</span>)}
                </span>
              )}
            {cooldown > 0 && <span className="block text-warn">Re-entry cooldown: {countdown(cooldown)} left.</span>}
          </div>
          <Btn kind="primary" block type="submit" disabled={!canSave} data-testid="save-ticket">{saving ? 'Saving' : saveLabel}</Btn>
        </div>
      </div>
    </form>
  );
}
