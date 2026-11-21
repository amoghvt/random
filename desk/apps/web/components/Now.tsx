'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { BiasCall, NowView, Stamped, TradePlan } from '@desk/contracts';
import { api } from '@/lib/api';
import { ago, callText, callTone, countdown, dayET, dayTimeET, fmtBp, fmtPct, fmtPrice, fmtProb, fmtShare, fmtUnits, timeET } from '@/lib/format';
import { keyOf, setCache, useApi, useNow, type Live } from '@/lib/store';
import { Age, Btn, Card, Chip, Empty, ErrorLine, LinkBtn, Loading, Stale } from './ui';

const TONE = { up: 'text-up', down: 'text-down', flat: 'text-ink' } as const;

export function useNowView(): Live<NowView> {
  return useApi('GET /api/now', null, 60_000);
}

/** POST /api/refresh: the server re-reads every feed and returns the new view. */
export function useRefresh(): { refreshing: boolean; error: string | null; refresh: () => Promise<void> } {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setCache<'GET /api/now'>(keyOf('GET /api/now'), await api('POST /api/refresh'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, []);
  return { refreshing, error, refresh };
}

export function PlanLines({ plan }: { plan: TradePlan }) {
  const [t1, t2, t3] = plan.targets;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-mute">Trade</dt>
      <dd><span className={plan.direction === 'long' ? 'text-up' : 'text-down'}>{plan.direction === 'long' ? 'Long' : 'Short'}</span> {plan.instrument}{plan.accountId ? ` · ${plan.accountId}` : ''}</dd>
      <dt className="text-mute">Entry</dt><dd>{plan.entry.text}</dd>
      <dt className="text-mute">Targets</dt><dd>{fmtPrice(t1.price)} / {fmtPrice(t2.price)} / {fmtPrice(t3.price)}</dd>
      <dt className="text-mute">Invalid</dt><dd>{fmtPrice(plan.invalidation.price)} · {plan.invalidation.reason}</dd>
      <dt className="text-mute">Time stop</dt><dd>{plan.timeStop.text}</dd>
      {plan.size && (<><dt className="text-mute">Size</dt><dd>{fmtUnits(plan.size.units)}{plan.size.leverage != null ? ` · ${plan.size.leverage}x` : ''}{plan.size.failPrice != null ? ` · fail ${fmtPrice(plan.size.failPrice)}` : ''}</dd></>)}
    </dl>
  );
}

export function BiasCard({ call, view }: { call: BiasCall | null; view: NowView }) {
  const now = useNow();
  if (!call) {
    return (
      <Card title="The call" id="bias">
        <p className="text-3xl font-bold" data-testid="bias-call">No call yet</p>
        <p className="mt-1 text-sm text-mute">The bias engine has not written a call for the primary instrument.</p>
        <Btn kind="ghost" block disabled className="mt-4" data-testid="bias-action">No edge</Btn>
      </Card>
    );
  }
  const tone = callTone(call.call);
  const quote = view.quotes[call.instrument];
  const left = Date.parse(call.expiresAt) - now;
  const tradable = call.call !== 'no_edge' && call.trade != null && !view.session.readOnly;
  return (
    <Card id="bias" className="!p-4">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">{call.instrument} <span className="font-normal text-mute">· {call.horizon}</span></span>
        {quote && (
          <span>
            {fmtPrice(quote.price)}
            {quote.changePct != null && <span className={`ml-1.5 ${quote.changePct >= 0 ? 'text-up' : 'text-down'}`}>{fmtPct(quote.changePct)}</span>}
            <Age stale={quote.stale} age={quote.age} />
          </span>
        )}
      </div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className={`text-[34px] font-bold leading-none tracking-tight ${TONE[tone]}`} data-testid="bias-call">{callText(call.call)}</p>
        <p className="text-[34px] font-bold leading-none" aria-label={`Probability ${fmtProb(call.probability)}`}>{fmtProb(call.probability)}</p>
      </div>
      <p className="mt-2 text-sm text-mute">
        Expires {timeET(call.expiresAt)}{now > 0 && (left > 0 ? ` · ${countdown(left)} left` : ' · expired')}
        <span className="text-dim"> · called {timeET(call.createdAt)}</span>
      </p>
      {call.firstMoveUntrusted && <Chip tone="warn" className="mt-2">First move, not yet trusted</Chip>}
      <ol className="mt-3 space-y-1.5 text-[15px] leading-snug">
        {call.facts.map((f, i) => (
          <li key={i} className="flex gap-2"><span className="w-4 shrink-0 text-mute">{i + 1}</span><span>{f}</span></li>
        ))}
      </ol>
      <p className="mt-3 rounded-xl border border-line bg-bg px-3 py-2 text-sm"><span className="font-semibold text-mute">Kill </span>{call.killCondition.text}</p>
      {call.trade && call.call !== 'no_edge' && <div className="mt-3"><PlanLines plan={call.trade} /></div>}
      <div className="mt-4 flex gap-2">
        {tradable
          ? <LinkBtn kind="primary" block href={`/ticket?call=${encodeURIComponent(call.id)}`} data-testid="bias-action">Open ticket</LinkBtn>
          : <Btn kind="ghost" block disabled data-testid="bias-action">{view.session.readOnly && call.call !== 'no_edge' ? 'Read-only' : 'No edge'}</Btn>}
        <LinkBtn href={`/chart?symbol=${encodeURIComponent(call.instrument)}`} className="shrink-0 lg:hidden">Chart</LinkBtn>
      </div>
      {view.session.readOnly && view.session.readOnlyReason && <p className="mt-2 text-xs text-warn">{view.session.readOnlyReason}</p>}
    </Card>
  );
}

export function Feed({ view, limit = 5 }: { view: NowView; limit?: number }) {
  const now = useNow();
  const [all, setAll] = useState(false);
  const items = [...view.updates].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const shown = all ? items : items.slice(0, limit);
  return (
    <Card title="Live feed" id="feed">
      {items.length === 0 ? <Empty>Nothing new. The watcher reports state changes, not noise.</Empty> : (
        <ul className="divide-y divide-line" data-testid="feed">
          {shown.map((u) => (
            <li key={u.id} className="py-2.5 first:pt-0 last:pb-0">
              <p className="text-[15px] leading-snug">{u.text}</p>
              <p className="mt-1 text-xs text-mute">
                {u.instrument} · {timeET(u.ts)}{now > 0 && ` · ${ago(u.ts, now)} ago`}
                {u.touches.biasKill && <span className="ml-2 text-down">touches the kill condition</span>}
                {u.touches.positionIds.length > 0 && <span className="ml-2 text-warn">touches a position</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {items.length > limit && <button type="button" onClick={() => setAll(!all)} className="mt-2 min-h-11 text-sm text-info">{all ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </Card>
  );
}

function Yield({ label, s, chg1h, chg1d }: { label: string; s: Stamped<number>; chg1h: number | null; chg1d: number | null }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-mute">{label}</div>
      <div className="text-lg font-semibold">{s.value != null ? `${s.value.toFixed(2)}%` : '—'}<Age stale={s.stale} age={s.age} /></div>
      <div className="text-xs text-mute">
        {chg1h != null ? <span className="text-ink">{fmtBp(chg1h)}</span> : '—'} 1h
        <span className="mx-1 text-dim">·</span>
        {chg1d != null ? fmtBp(chg1d) : '—'} 1d
      </div>
    </div>
  );
}

export function RatesStrip({ view }: { view: NowView }) {
  const r = view.rates;
  const odds: Array<[string, Stamped<number>]> = [['Hike', r.fed.hike], ['Hold', r.fed.hold], ['Cut', r.fed.cut]];
  const fedStale = odds.find(([, s]) => s.stale)?.[1];
  return (
    <Card title="Rates" id="rates" right={r.spread2s10sBp != null ? <span className="text-xs text-mute">2s10s {fmtBp(r.spread2s10sBp)}</span> : undefined}>
      <div className="grid grid-cols-2 gap-4">
        <Yield label="2Y" s={r.y2} chg1h={r.y2Chg1hBp} chg1d={r.y2Chg1dBp} />
        <Yield label="10Y" s={r.y10} chg1h={r.y10Chg1hBp} chg1d={r.y10Chg1dBp} />
      </div>
      <div className="mt-3 border-t border-line pt-3">
        <div className="flex items-baseline justify-between text-[11px] uppercase tracking-wide text-mute">
          <span>FedWatch{r.fed.meeting ? ` · ${dayET(r.fed.meeting)}` : ''}</span>
          {fedStale && <Age stale age={fedStale.age} />}
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {odds.map(([label, s]) => (
            <div key={label}><span className="text-lg font-semibold">{s.value != null ? fmtShare(s.value) : '—'}</span> <span className="text-xs text-mute">{label}</span></div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function NextCatalyst({ view }: { view: NowView }) {
  const now = useNow();
  const c = view.nextCatalyst;
  if (!c) return <Card title="Next catalyst"><Empty>Nothing scheduled in the window.</Empty></Card>;
  const left = Date.parse(c.scheduledAt) - now;
  const unit = c.unit ? ` ${c.unit}` : '';
  return (
    <Card title="Next catalyst" id="next-catalyst" right={<Chip tone={c.tier === 1 ? 'bad' : 'mute'}>Tier {c.tier}</Chip>}>
      <Link href={`/catalysts?id=${encodeURIComponent(c.id)}`} className="block">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{c.name}</p>
            <p className="text-sm text-mute">{dayTimeET(c.scheduledAt)}</p>
          </div>
          <p className="text-2xl font-bold" data-testid="countdown">{now > 0 ? (left > 0 ? countdown(left) : 'Live') : '—'}</p>
        </div>
        <p className="mt-2 text-sm text-mute">
          Consensus <span className="text-ink">{c.consensus != null ? `${c.consensus}${unit}` : '—'}</span>
          <span className="mx-2 text-dim">·</span>Prior <span className="text-ink">{c.prior != null ? `${c.prior}${unit}` : '—'}</span>
        </p>
      </Link>
    </Card>
  );
}

export function Quotes({ view }: { view: NowView }) {
  const qs = Object.values(view.quotes);
  if (qs.length === 0) return null;
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:px-0" data-testid="quotes">
      {qs.map((q) => (
        <Link key={q.symbol} href={`/chart?symbol=${encodeURIComponent(q.symbol)}`} className="shrink-0 rounded-xl border border-line bg-panel px-3 py-2 text-sm">
          <span className="text-mute">{q.symbol}</span> <span className="font-semibold">{fmtPrice(q.price)}</span>
          {q.changePct != null && <span className={`ml-1.5 ${q.changePct >= 0 ? 'text-up' : 'text-down'}`}>{fmtPct(q.changePct)}</span>}
          <Age stale={q.stale} age={q.age} />
        </Link>
      ))}
    </div>
  );
}

export function OtherCalls({ view }: { view: NowView }) {
  const rest = view.calls.filter((c) => c.id !== view.primary?.id);
  if (rest.length === 0) return null;
  return (
    <Card title="Other calls">
      <ul className="divide-y divide-line">
        {rest.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="text-sm"><span className="font-semibold">{c.instrument}</span> <span className="text-mute">· {c.horizon}</span></p>
              <p className="truncate text-xs text-mute">{c.facts[0] ?? c.killCondition.text}</p>
            </div>
            <p className="shrink-0 text-right text-sm">
              <span className={`font-semibold ${TONE[callTone(c.call)]}`}>{callText(c.call)}</span> {fmtProb(c.probability)}
              <span className="block text-xs text-mute">to {dayTimeET(c.expiresAt)}</span>
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Headlines({ view }: { view: NowView }) {
  if (view.headlines.length === 0) return null;
  return (
    <Card title="Headlines">
      <ul className="space-y-2">
        {view.headlines.slice(0, 5).map((h) => (
          <li key={h.id} className="flex gap-2 text-sm">
            <span className={`mt-0.5 h-5 w-5 shrink-0 rounded text-center text-xs font-bold leading-5 ${h.impact >= 3 ? 'bg-down/20 text-down' : 'bg-raise text-mute'}`} title={`Impact ${h.impact}`}>{h.impact}</span>
            <span>{h.title} <span className="whitespace-nowrap text-xs text-mute">{timeET(h.ts)} · {h.source}</span></span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Feed health and session state: present, never loud. */
export function HealthLine({ view }: { view: NowView }) {
  const down = view.feedHealth.filter((f) => !f.ok);
  const s = view.session;
  return (
    <p className="px-1 text-xs text-mute" data-testid="health">
      Feeds {view.feedHealth.length - down.length}/{view.feedHealth.length} ok{down.length > 0 && <span className="text-warn"> · down: {down.map((f) => f.feed).join(', ')}</span>}
      <span className="mx-1 text-dim">·</span>Kill switch {s.killSwitch ? <span className="text-down">on</span> : 'off'}
      {s.readOnly && <><span className="mx-1 text-dim">·</span><span className="text-warn">read-only</span></>}
      {s.quietHours && <><span className="mx-1 text-dim">·</span>quiet hours</>}
      <span className="mx-1 text-dim">·</span>as of {timeET(view.asOf)}
    </p>
  );
}

function usePull(onRefresh: () => Promise<void>, busy: boolean): number {
  const [pull, setPull] = useState(0);
  const start = useRef<number | null>(null);
  const dist = useRef(0);
  useEffect(() => {
    const onStart = (e: TouchEvent) => { start.current = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null; };
    const onMove = (e: TouchEvent) => {
      if (start.current == null || busy) return;
      dist.current = Math.max(0, Math.min(96, (e.touches[0]!.clientY - start.current) * 0.5));
      setPull(window.scrollY <= 0 ? dist.current : 0);
    };
    const onEnd = () => {
      if (start.current != null && dist.current >= 64 && window.scrollY <= 0) void onRefresh();
      start.current = null;
      dist.current = 0;
      setPull(0);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, busy]);
  return pull;
}

export function NowScreen() {
  const now = useNowView();
  const { refreshing, error, refresh } = useRefresh();
  const pull = usePull(refresh, refreshing);
  const v = now.data;
  return (
    <div className="space-y-3" data-testid="now-screen">
      {(pull > 0 || refreshing) && (
        <p role="status" className="text-center text-xs text-mute" style={{ height: refreshing ? 24 : pull / 2 }}>
          {refreshing ? 'Re-reading every feed' : pull >= 64 ? 'Release to refresh' : 'Pull to refresh'}
        </p>
      )}
      <Stale since={now.staleSince} error={now.error} />
      {error && <ErrorLine error={`Refresh failed: ${error}`} />}
      {!v ? (
        <Card title="The call">{now.error ? <ErrorLine error={now.error} retry={() => void now.refresh()} /> : <Loading lines={4} />}</Card>
      ) : (
        <>
          <BiasCard call={v.primary} view={v} />
          <Quotes view={v} />
          <Feed view={v} />
          <RatesStrip view={v} />
          <NextCatalyst view={v} />
          <OtherCalls view={v} />
          <Headlines view={v} />
          <div className="flex items-center justify-between gap-3">
            <HealthLine view={v} />
            <Btn kind="quiet" className="shrink-0 !px-2" disabled={refreshing} onClick={() => void refresh()} data-testid="refresh">{refreshing ? 'Refreshing' : 'Refresh'}</Btn>
          </div>
        </>
      )}
    </div>
  );
}
