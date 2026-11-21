'use client';
/** Lightweight Charts, loaded on demand so the Now route never pays for it. Draws only what the API returns. */
import { useEffect, useRef, useState } from 'react';
import type { IChartApi, IPriceLine, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { ChartView, StructureEvent, Timeframe } from '@desk/contracts';
import { chartSymbol, dayTimeET, fmtPrice } from '@/lib/format';
import { useApi } from '@/lib/store';
import { Card, Chip, ErrorLine, Segmented, Stale } from './ui';

const TFS: ReadonlyArray<{ value: Timeframe; label: string }> = [{ value: '1m', label: '1m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1H' }, { value: '1d', label: 'Daily' }];
const C = { bg: '#13171c', grid: '#1f262e', text: '#9aa4b2', up: '#3dd68c', down: '#ff6b6b', e20: '#b88a22', e50: '#4f94e8', e200: '#d9609c', liq: '#c9d1db', fvg: '#4fd1c5', ob: '#ff9f5a', fail: '#ff3b3b' };
const DRAWN: Record<string, { color: string; tag: string; name: string }> = {
  liquidity_pool: { color: C.liq, tag: 'LIQ', name: 'Liquidity' }, fvg: { color: C.fvg, tag: 'FVG', name: 'Fair value gap' }, order_block: { color: C.ob, tag: 'OB', name: 'Order block' },
};
const PER_DETECTOR = 4;

/** The watcher's liquidity, FVG and order-block levels nearest the last price. */
function drawnLevels(v: ChartView): StructureEvent[] {
  const last = v.candles[v.candles.length - 1]?.c;
  const out: StructureEvent[] = [];
  for (const d of Object.keys(DRAWN)) {
    const ls = v.levels.filter((e) => e.detector === d && e.level != null);
    if (last != null) ls.sort((a, b) => Math.abs(a.level! - last) - Math.abs(b.level! - last));
    out.push(...ls.slice(0, PER_DETECTOR));
  }
  return out;
}

interface Handles { chart: IChartApi; candles: ISeriesApi<'Candlestick'>; e20: ISeriesApi<'Line'>; e50: ISeriesApi<'Line'>; e200: ISeriesApi<'Line'>; lines: IPriceLine[]; solid: number; dashed: number; dotted: number }

export default function ChartPanel({ symbol: initial = 'NQ', symbols = [], tall = false }: { symbol?: string; symbols?: string[]; tall?: boolean }) {
  const [symbol, setSymbol] = useState(chartSymbol(initial));
  const [tf, setTf] = useState<Timeframe>('15m');
  useEffect(() => setSymbol(chartSymbol(initial)), [initial]);
  const q = useApi('GET /api/charts/:symbol', { params: { symbol }, query: { tf } }, tf === '1m' ? 30_000 : 60_000);
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<Handles | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fitted = useRef('');

  useEffect(() => {
    let dead = false;
    let chart: IChartApi | null = null;
    void import('lightweight-charts').then((lc) => {
      if (dead || !box.current) return;
      const et = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', ...opts });
      const fTime = et({ hour: '2-digit', minute: '2-digit' }), fDay = et({ month: 'short', day: 'numeric' }), fFull = et({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      chart = lc.createChart(box.current, {
        autoSize: true,
        layout: { background: { type: lc.ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: 'system-ui, -apple-system, sans-serif', attributionLogo: true },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.grid },
        crosshair: { mode: lc.CrosshairMode.Normal },
        timeScale: {
          borderColor: C.grid, timeVisible: true, secondsVisible: false, rightOffset: 4,
          tickMarkFormatter: (t: unknown, type: number) => (typeof t === 'number' ? (type >= 3 ? fTime : fDay).format(new Date(t * 1000)) : null),
        },
        localization: { timeFormatter: (t: unknown) => (typeof t === 'number' ? `${fFull.format(new Date(t * 1000))} ET` : '') },
      });
      const line = (color: string) => chart!.addSeries(lc.LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const candles = chart.addSeries(lc.CandlestickSeries, { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false });
      setH({ chart, candles, e200: line(C.e200), e50: line(C.e50), e20: line(C.e20), lines: [], solid: lc.LineStyle.Solid, dashed: lc.LineStyle.Dashed, dotted: lc.LineStyle.Dotted });
    }).catch(() => setLoadError('The chart library did not load.'));
    return () => { dead = true; setH(null); chart?.remove(); };
  }, []);

  const v = q.data;
  useEffect(() => {
    if (!h || !v) return;
    const ts = (t: number) => Math.floor(t / 1000) as UTCTimestamp;
    h.candles.setData(v.candles.map((c) => ({ time: ts(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    h.e20.setData(v.ema.e20.map((p) => ({ time: ts(p.t), value: p.v })));
    h.e50.setData(v.ema.e50.map((p) => ({ time: ts(p.t), value: p.v })));
    h.e200.setData(v.ema.e200.map((p) => ({ time: ts(p.t), value: p.v })));
    h.lines.forEach((l) => h.candles.removePriceLine(l));
    h.lines = [];
    for (const e of drawnLevels(v)) {
      const d = DRAWN[e.detector]!;
      const zone = e.levelHi != null;
      const style = e.detector === 'liquidity_pool' ? h.dashed : h.dotted;
      h.lines.push(h.candles.createPriceLine({ price: e.level!, color: d.color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title: d.tag }));
      if (zone) h.lines.push(h.candles.createPriceLine({ price: e.levelHi!, color: d.color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title: '' }));
    }
    for (const f of v.failPrices) h.lines.push(h.candles.createPriceLine({ price: f.price, color: C.fail, lineWidth: 2, lineStyle: h.solid, axisLabelVisible: true, title: `FAIL ${f.accountId}` }));
    const view = `${v.symbol}|${v.tf}`;
    if (fitted.current !== view && v.candles.length > 0) {
      fitted.current = view;
      const n = v.candles.length;
      h.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 4 });
    }
  }, [h, v]);

  const options = [...new Set([symbol, ...symbols.map(chartSymbol)])];
  const last = v?.candles[v.candles.length - 1];
  const levels = v ? drawnLevels(v) : [];
  return (
    <div className="space-y-3" data-testid="chart-panel">
      <Stale since={q.staleSince} error={q.error} />
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select className="inp !w-auto !min-h-10 font-semibold" aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} data-testid="chart-symbol">
            {options.map((s) => <option key={s}>{s}</option>)}
          </select>
          <div className="min-w-[13rem] flex-1"><Segmented label="Timeframe" value={tf} onChange={setTf} options={TFS} /></div>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute">
          {last && <span className="text-sm font-semibold text-ink">{fmtPrice(last.c)}</span>}
          <span>{v?.asOf ? `as of ${dayTimeET(v.asOf)}` : v ? 'no data' : 'loading'}</span>
          {v?.stale && <Chip tone="warn">Stale</Chip>}
          {last && <span>source {last.source}</span>}
        </p>
        <div ref={box} className={`mt-2 w-full overflow-hidden rounded-xl ${tall ? 'h-[52dvh] min-h-[320px] lg:h-[calc(100dvh-290px)]' : 'h-[52dvh] min-h-[320px]'}`} data-testid="chart-canvas" />
        {loadError && <ErrorLine error={loadError} />}
        {q.error && !v && <ErrorLine error={q.error} retry={() => void q.refresh()} />}
        {v && v.candles.length === 0 && <p className="mt-2 text-sm text-mute">No candles for {symbol} {tf}.</p>}
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute" aria-label="Legend">
          {([['EMA 20', C.e20], ['EMA 50', C.e50], ['EMA 200', C.e200]] as const).map(([name, color]) => (
            <li key={name} className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: color }} />{name}</li>
          ))}
          {Object.values(DRAWN).map((d) => <li key={d.tag} className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed" style={{ borderColor: d.color }} />{d.name} ({d.tag})</li>)}
          <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: C.fail }} />Fail price</li>
        </ul>
      </Card>
      {v && (v.failPrices.length > 0 || levels.length > 0) && (
        <Card title="Levels on the chart">
          <ul className="space-y-1.5 text-sm">
            {v.failPrices.map((f) => <li key={f.positionId} className="flex justify-between gap-3"><span><span className="font-semibold text-down">Fail</span> · {f.accountId}</span><span className="font-semibold">{fmtPrice(f.price)}</span></li>)}
            {levels.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span className="min-w-0"><span className="font-semibold">{DRAWN[e.detector]!.tag}</span> <span className="text-mute">· {e.text}</span></span>
                <span className="shrink-0 font-semibold">{fmtPrice(e.level!)}{e.levelHi != null && `–${fmtPrice(e.levelHi)}`}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
