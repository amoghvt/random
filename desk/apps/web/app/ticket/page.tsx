'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { TicketDetail } from '@/components/TicketDetail';
import { TicketForm } from '@/components/TicketForm';

function Inner() {
  const q = useSearchParams();
  const id = q.get('id');
  if (id) return <TicketDetail key={id} id={id} />;
  const prefill = { notificationId: q.get('prefill') ?? undefined, callId: q.get('call') ?? undefined, catalystId: q.get('catalyst') ?? undefined, branchId: q.get('branch') ?? undefined };
  return <TicketForm key={JSON.stringify(prefill)} prefill={prefill} />;
}
export default function TicketPage() {
  return <Suspense><Inner /></Suspense>;
}
