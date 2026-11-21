'use client';
import dynamic from 'next/dynamic';
import { CatalystTimeline } from './Catalysts';
import { BiasCard, Feed, Headlines, HealthLine, NextCatalyst, OtherCalls, Quotes, RatesStrip, useNowView, useRefresh } from './Now';
import { PositionsList, usePositions } from './Positions';
import { Btn, Card, ErrorLine, Loading, Stale } from './ui';

const ChartPanel = dynamic(() => import('./ChartPanel'), { ssr: false, loading: () => <Card title="Chart"><Loading /></Card> });

/** Desktop: Now and Positions left, charts center, Catalysts and feed right. */
export default function DesktopGrid() {
  const now = useNowView();
  const positions = usePositions();
  const { refreshing, error, refresh } = useRefresh();
  const v = now.data;
  const symbols = [...Object.keys(v?.quotes ?? {}), ...(positions.data?.positions.map((p) => p.position.instrument) ?? [])];
  return (
    <div className="grid grid-cols-[minmax(320px,400px)_minmax(0,1fr)_minmax(320px,400px)] items-start gap-4" data-testid="desktop-grid">
      <div className="space-y-3" data-testid="col-left">
        <Stale since={now.staleSince} error={now.error} />
        {v ? <><BiasCard call={v.primary} view={v} /><RatesStrip view={v} /></> : <Card title="The call">{now.error ? <ErrorLine error={now.error} retry={() => void now.refresh()} /> : <Loading lines={4} />}</Card>}
        <PositionsList compact />
        {v && <OtherCalls view={v} />}
      </div>
      <div className="space-y-3" data-testid="col-center">
        {v && <Quotes view={v} />}
        <ChartPanel symbol={v?.primary?.instrument ?? 'NQ'} symbols={symbols} tall />
      </div>
      <div className="space-y-3" data-testid="col-right">
        {v && <NextCatalyst view={v} />}
        <Card title="Catalysts · next 7 days · Tier 1 in red"><CatalystTimeline compact /></Card>
        {v && <Feed view={v} limit={8} />}
        {v && <Headlines view={v} />}
        {v && (
          <div className="flex items-center justify-between gap-3">
            <HealthLine view={v} />
            <Btn kind="quiet" className="shrink-0 !px-2" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing' : 'Refresh'}</Btn>
          </div>
        )}
        {error && <ErrorLine error={`Refresh failed: ${error}`} />}
      </div>
    </div>
  );
}
