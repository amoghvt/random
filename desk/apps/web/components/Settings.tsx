'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { enablePush, pushSupport, type PushSupport } from '@/lib/push';
import { keyOf, patchCache, setCache, useApi, useNow } from '@/lib/store';
import { Btn, Chip, ErrorLine, Sheet } from './ui';

const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Failed');

function Notifications() {
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSupport(pushSupport()), []);
  if (!support) return null;
  const needsInstall = support.ios && !support.standalone;
  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    try { setMsg(await fn()); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    setBusy(false);
    setSupport(pushSupport());
  };
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-mute">Notifications</h3>
      <p className="text-sm">Permission: <span className="font-semibold">{support.permission}</span></p>
      {needsInstall ? (
        <div data-testid="a2hs" className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          <p className="font-semibold">Add to Home Screen first.</p>
          <p className="mt-1 text-mute">iOS only delivers web push to an installed app (iOS 16.4+). In Safari: Share, then “Add to Home Screen”, then open Desk from the icon and come back here.</p>
        </div>
      ) : !support.supported ? (
        <p className="text-sm text-mute">This browser has no web push.</p>
      ) : (
        <div className="flex gap-2">
          <Btn kind="primary" className="flex-1" disabled={busy} data-testid="enable-push" onClick={() => void run(enablePush)}>Enable notifications</Btn>
          <Btn className="flex-1" disabled={busy} onClick={() => void run(async () => {
            const r = await api('POST /api/push/test');
            return { ok: r.ok && r.sent > 0, text: r.sent > 0 ? `Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}.` : 'No subscribed device. Enable notifications first.' };
          })}>Send test</Btn>
        </div>
      )}
      {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-up' : 'text-warn'}`}>{msg.text}</p>}
    </section>
  );
}

function KillSwitch() {
  const kill = useApi('GET /api/admin/kill');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = kill.data?.killSwitch ?? false;
  const set = async (next: boolean) => {
    setError(null);
    try {
      const r = await api('POST /api/admin/kill', { body: { on: next } });
      setCache<'GET /api/admin/kill'>(keyOf('GET /api/admin/kill'), r);
      patchCache<'GET /api/now'>(keyOf('GET /api/now'), (v) => ({ ...v, session: { ...v.session, killSwitch: r.killSwitch } }));
    } catch (e) { setError(errText(e)); }
    setConfirm(false);
  };
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-mute">Kill switch</h3>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{kill.data ? <>Kill switch is <span className={`font-semibold ${on ? 'text-down' : ''}`}>{on ? 'ON' : 'off'}</span>.</> : 'Reading state.'}</p>
        {!confirm && <Btn kind={on ? 'ghost' : 'danger'} disabled={!kill.data} data-testid="kill-toggle" onClick={() => setConfirm(true)}>{on ? 'Turn off' : 'Turn on'}</Btn>}
      </div>
      {confirm && (
        <div className="flex items-center gap-2 rounded-xl border border-down/50 bg-down/10 p-2">
          <p className="flex-1 text-sm">Turn the kill switch {on ? 'off' : 'on'}?</p>
          <Btn kind="danger" data-testid="kill-confirm" onClick={() => void set(!on)}>Confirm</Btn>
          <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
        </div>
      )}
      {error && <ErrorLine error={error} />}
    </section>
  );
}

function ProfileBits() {
  const profile = useApi('GET /api/profile');
  const now = useApi('GET /api/now');
  const [error, setError] = useState<string | null>(null);
  const p = profile.data;
  if (!p) return profile.error ? <ErrorLine error={profile.error} retry={() => void profile.refresh()} /> : null;
  const approve = async (week: string) => {
    setError(null);
    try {
      const next = await api('PUT /api/profile', { body: { ...p, memos: p.memos.map((m) => (m.week === week ? { ...m, approved: true } : m)) } });
      setCache<'GET /api/profile'>(keyOf('GET /api/profile'), next);
    } catch (e) { setError(errText(e)); }
  };
  const n = p.notifications;
  return (
    <>
      <section className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-mute">Quiet hours</h3>
        <p className="text-sm">{n.quietHours.from} to {n.quietHours.to} {p.timezone.split('/')[1]?.replace('_', ' ') ?? p.timezone}, P0 only. {now.data?.session.quietHours ? 'Quiet now.' : 'Not quiet now.'}</p>
        <p className="text-xs text-mute">P1 max {n.p1PerSession} per session · P2 max {n.p2PerDay} per day · brief {n.morningBriefLocal} · recap {n.recapET} ET · weekly {n.weeklyLocal}</p>
      </section>
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-mute">Profile memos</h3>
        {p.memos.length === 0 && <p className="text-sm text-mute">No memos yet. The first is written after the Sunday review.</p>}
        {p.memos.map((m) => (
          <div key={m.week} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{m.week}</span>
              {m.approved ? <Chip tone="good">Approved</Chip> : <Btn kind="primary" className="!min-h-9" onClick={() => void approve(m.week)}>Approve</Btn>}
            </div>
            <p className="mt-1 text-sm text-mute">{m.text}</p>
          </div>
        ))}
        {error && <ErrorLine error={error} />}
      </section>
    </>
  );
}

function Feeds() {
  const now = useApi('GET /api/now');
  const t = useNow();
  const feeds = now.data?.feedHealth ?? [];
  if (feeds.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-mute">Feeds</h3>
      <ul className="text-sm">
        {feeds.map((f) => (
          <li key={f.feed} className="flex items-center justify-between gap-2 py-0.5">
            <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${f.ok ? 'bg-up' : 'bg-warn'}`} aria-hidden="true" />{f.feed}{!f.live && <span className="text-xs text-mute">(recorded)</span>}</span>
            <span className={`text-xs ${f.ok ? 'text-mute' : 'text-warn'}`}>{f.ok ? `ok ${t ? ago(f.lastOk, t) : ''}` : `${f.error ?? 'down'} · last ok ${t ? ago(f.lastOk, t) : ''}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="space-y-5">
        <Notifications />
        <KillSwitch />
        <ProfileBits />
        <Feeds />
      </div>
    </Sheet>
  );
}
