'use client';
import dynamic from 'next/dynamic';
import { NowScreen } from '@/components/Now';
import { useIsDesktop } from '@/lib/media';

const DesktopGrid = dynamic(() => import('@/components/DesktopGrid'), { ssr: false });

export default function NowPage() {
  return useIsDesktop() ? <DesktopGrid /> : <NowScreen />;
}
