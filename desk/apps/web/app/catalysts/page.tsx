'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { CatalystCard, CatalystTimeline } from '@/components/Catalysts';

function Inner() {
  const id = useSearchParams().get('id');
  return id ? <CatalystCard key={id} id={id} /> : <CatalystTimeline />;
}
export default function CatalystsPage() {
  return <Suspense><Inner /></Suspense>;
}
