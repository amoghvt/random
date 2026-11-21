'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { JournalScreen, type JournalTab } from '@/components/Journal';

function Inner() {
  const v = useSearchParams().get('view');
  const view: JournalTab = v === 'weekly' || v === 'morning' || v === 'recap' ? v : 'journal';
  return <JournalScreen view={view} />;
}
export default function JournalPage() {
  return <Suspense><Inner /></Suspense>;
}
