'use client';
import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/store';

const ChartPanel = dynamic(() => import('@/components/ChartPanel'), { ssr: false });

function Inner() {
  const symbol = useSearchParams().get('symbol') ?? 'NQ';
  const now = useApi('GET /api/now');
  const positions = useApi('GET /api/positions');
  const symbols = [...Object.keys(now.data?.quotes ?? {}), ...(positions.data?.positions.map((p) => p.position.instrument) ?? [])];
  return <ChartPanel symbol={symbol} symbols={symbols} tall />;
}
export default function ChartPage() {
  return <Suspense><Inner /></Suspense>;
}
