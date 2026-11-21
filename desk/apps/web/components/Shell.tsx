'use client';
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, auth, MOCK } from '@/lib/api';
import { revalidateAll, useApi, useNeedLogin } from '@/lib/store';
import { startStream, toasts, useStreamState, useToast } from '@/lib/stream';
import { Btn, Chip } from './ui';
import { SettingsSheet } from './Settings';

const TABS = [
  { href: '/', label: 'Now', d: 'M12 3v9l5 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  { href: '/catalysts/', label: 'Catalysts', d: 'M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z' },
  { href: '/positions/', label: 'Positions', d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { href: '/journal/', label: 'Journal', d: 'M6 3h11a2 2 0 0 1 2 2v16H8a2 2 0 0 1-2-2V3Zm0 0v16M10 8h5M10 12h5' },
  { href: '/ask/', label: 'Ask', d: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z' },
] as const;

const isActive = (path: string, href: string): boolean => (href === '/' ? path === '/' || path.startsWith('/chart') : path.startsWith(href.replace(/\/$/, '')));
const subscribeOnline = (f: () => void) => {
  window.addEventListener('online', f);
  window.addEventListener('offline', f);
  return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); };
};

function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('POST /api/auth/login', { body: { token } });
      if (!r.ok) throw new Error('Wrong passphrase.');
      auth.set(false);
      revalidateAll();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Wrong passphrase.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg p-6" data-testid="login">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-semibold">Desk</h1>
        <p className="text-sm text-mute">Passphrase.</p>
        <input className="inp" type="password" name="token" autoComplete="current-password" aria-label="Passphrase" aria-invalid={error != null} value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        {error && <p role="alert" className="text-sm text-down">{error}</p>}
        <Btn kind="primary" block type="submit" disabled={busy || token.length === 0}>{busy ? 'Checking' : 'Unlock'}</Btn>
      </form>
    </div>
  );
}

function Toast() {
  const n = useToast();
  useEffect(() => {
    if (!n) return;
    const t = window.setTimeout(() => toasts.set(null), n.class === 'P0' ? 30_000 : 10_000);
    return () => window.clearTimeout(t);
  }, [n]);
  if (!n) return null;
  return (
    <div role="alert" className="fixed inset-x-3 top-[calc(var(--head-h)+var(--sat)+8px)] z-40 mx-auto max-w-md rounded-2xl border border-info/50 bg-raise p-3 shadow-xl">
      <Link href={n.deepLink} onClick={() => { toasts.set(null); void api('POST /api/notifications/:id/tap', { params: { id: n.id } }).catch(() => undefined); }} className="block">
        <Chip tone={n.class === 'P0' ? 'bad' : 'info'}>{n.class}</Chip>
        {n.lines.map((l, i) => <p key={i} className={`mt-1 text-sm ${i === 0 ? 'font-semibold' : ''}`}>{l}</p>)}
      </Link>
      <button type="button" onClick={() => toasts.set(null)} className="mt-1 min-h-11 text-xs text-mute">Dismiss</button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const needLogin = useNeedLogin();
  const stream = useStreamState();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [settings, setSettings] = useState(false);
  const now = useApi('GET /api/now', null, 60_000);
  const session = now.data?.session;
  const feedsDown = now.data?.feedHealth.filter((f) => !f.ok).length ?? 0;

  useEffect(() => startStream(), []);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      router.push('/ticket/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const wide = path === '/';
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-30 border-b border-line bg-bg/95 pt-[var(--sat)] backdrop-blur">
        <div className="flex h-[var(--head-h)] items-center gap-2 pl-[calc(16px+var(--sal))] pr-[calc(4px+var(--sar))]">
          <Link href="/" className="text-base font-semibold tracking-tight">Desk</Link>
          {MOCK && <Chip tone="warn" className="!text-xs" ><span data-testid="mock-badge">MOCK data</span></Chip>}
          <nav aria-label="Sections" className="ml-4 hidden items-center gap-1 lg:flex">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} aria-current={isActive(path, t.href) ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm ${isActive(path, t.href) ? 'bg-raise font-semibold text-ink' : 'text-mute'}`}>{t.label}</Link>
            ))}
            <Link href="/ticket/" className="ml-2 rounded-lg border border-line px-3 py-1.5 text-sm text-info">New ticket <kbd className="ml-1 rounded border border-line px-1 text-[11px] text-mute">t</kbd></Link>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            {session?.killSwitch && <Chip tone="bad">Kill switch</Chip>}
            {session?.readOnly && <Chip tone="warn">Read-only</Chip>}
            {session?.quietHours && <Chip>Quiet</Chip>}
            {!online && <Chip tone="warn">Offline</Chip>}
            <span title={`Stream ${stream}${feedsDown ? ` · ${feedsDown} feed${feedsDown > 1 ? 's' : ''} down` : ''}`} aria-label={`Stream ${stream}, ${feedsDown} feeds down`}
              className={`h-2 w-2 rounded-full ${stream === 'live' && online ? (feedsDown ? 'bg-warn' : 'bg-up') : 'bg-dim pulse'}`} />
            <button type="button" aria-label="Settings" data-testid="settings-btn" onClick={() => setSettings(true)} className="flex h-11 w-11 items-center justify-center text-mute">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className={`shell-main ${wide ? 'wide' : ''}`}>{children}</main>

      <nav aria-label="Tabs" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[var(--sab)] backdrop-blur lg:hidden">
        <ul className="mx-auto flex h-[var(--tab-h)] max-w-md items-stretch pl-[var(--sal)] pr-[var(--sar)]">
          {TABS.map((t) => {
            const on = isActive(path, t.href);
            return (
              <li key={t.href} className="flex-1">
                <Link href={t.href} aria-current={on ? 'page' : undefined} data-testid={`tab-${t.label.toLowerCase()}`}
                  className={`flex h-full flex-col items-center justify-center gap-0.5 text-[11px] ${on ? 'font-semibold text-ink' : 'text-mute'}`}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.d} /></svg>
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Toast />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
      {needLogin && <Login />}
    </>
  );
}
