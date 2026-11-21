'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, GuardrailFiring } from '@desk/contracts';
import { api } from '@/lib/api';
import { ago, dayTimeET, timeET } from '@/lib/format';
import { keyOf, patchCache, useApi, useNow } from '@/lib/store';
import { Btn, ErrorLine, Guardrail, Loading, Stale } from './ui';

const KEY = keyOf('GET /api/ask/history');
const SUGGESTIONS = ['Up or down today?', 'What does the plan say on my open position?', 'What happened the last three times I held through earnings?'];

export function AskScreen() {
  const history = useApi('GET /api/ask/history');
  const now = useNow();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, GuardrailFiring[]>>({});
  const [engines, setEngines] = useState<Record<string, string>>({});
  const seen = useRef(new Set<string>());
  const end = useRef<HTMLDivElement>(null);
  const messages = history.data ?? [];

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, busy]);

  const ask = async (q: string, checkLive: boolean) => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(checkLive ? 'Pulling the latest feeds' : 'Thinking');
    setError(null);
    const pendingMsg: ChatMessage = { id: `local_${Date.now()}`, ts: new Date().toISOString(), role: 'trader', text: checkLive ? `${question} (check live)` : question };
    patchCache<'GET /api/ask/history'>(KEY, (h) => [...h, pendingMsg]);
    try {
      const r = await api('POST /api/ask', { body: { text: question, checkLive } });
      patchCache<'GET /api/ask/history'>(KEY, (h) => [...h.filter((m) => m.id !== r.message.id), r.message]);
      // A guardrail speaks once per episode; a repeat is dropped here, not rendered again.
      const fresh = r.guardrails.filter((g) => !seen.current.has(g.episodeKey));
      fresh.forEach((g) => seen.current.add(g.episodeKey));
      if (fresh.length > 0) setFlags((f) => ({ ...f, [r.message.id]: fresh }));
      setEngines((e) => ({ ...e, [r.message.id]: r.engine }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
    setBusy(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text;
    setText('');
    void ask(q, false);
  };
  const questionBefore = (i: number): string | null => {
    for (let k = i - 1; k >= 0; k--) if (messages[k]!.role === 'trader') return messages[k]!.text.replace(/ \(check live\)$/, '');
    return null;
  };

  return (
    <div className="pb-24" data-testid="ask-screen">
      <Stale since={history.staleSince} error={history.error} />
      {!history.data && (history.error ? <ErrorLine error={history.error} retry={() => void history.refresh()} /> : <Loading />)}
      {history.data && messages.length === 0 && (
        <div className="space-y-2">
          <p className="text-sm text-mute">Ask the desk. Every number comes with its as-of time.</p>
          {SUGGESTIONS.map((s) => <Btn key={s} block className="!justify-start text-left" onClick={() => void ask(s, false)}>{s}</Btn>)}
        </div>
      )}
      <ol className="space-y-3">
        {messages.map((m, i) => m.role === 'trader' ? (
          <li key={m.id} className="ml-10 rounded-2xl rounded-br-md bg-raise px-3.5 py-2.5 text-[15px]">{m.text}</li>
        ) : (
          <li key={m.id} className="mr-4 space-y-2" data-testid="desk-answer">
            <div className="rounded-2xl rounded-bl-md border border-line bg-panel px-3.5 py-2.5">
              <p className="whitespace-pre-wrap text-[15px] leading-snug">{m.text}</p>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-1.5">
                <p className="text-xs text-mute" data-testid="as-of">
                  {m.asOf ? <>Data as of <span className="text-ink">{timeET(m.asOf)}</span>{now > 0 && ` · ${ago(m.asOf, now)} old`}</> : <span className="text-warn">No as-of time on this answer</span>}
                  {engines[m.id] && ` · ${engines[m.id]}`}
                </p>
                <Btn kind="quiet" className="!min-h-9 shrink-0 !px-2" disabled={busy != null || questionBefore(i) == null} data-testid="check-live"
                  onClick={() => { const q = questionBefore(i); if (q) void ask(q, true); }}>Check live</Btn>
              </div>
              {m.citations && m.citations.length > 0 && (
                <details className="text-xs text-mute">
                  <summary className="cursor-pointer py-1.5">Sources · {m.citations.length}</summary>
                  <ul className="space-y-0.5 pb-1">{m.citations.map((c, k) => <li key={k}>{c.label} · {c.source} · {dayTimeET(c.asOf)}</li>)}</ul>
                </details>
              )}
            </div>
            {(flags[m.id] ?? []).map((g) => <Guardrail key={g.id} f={g} />)}
          </li>
        ))}
        {busy && <li className="mr-4 rounded-2xl border border-line bg-panel px-3.5 py-2.5 text-sm text-mute" role="status">{busy}</li>}
      </ol>
      {error && <div className="mt-3"><ErrorLine error={error} /></div>}
      <div ref={end} />
      <form onSubmit={submit} className="fixed inset-x-0 bottom-[calc(var(--tab-h)+var(--sab))] z-20 border-t border-line bg-bg/95 px-4 py-2.5 backdrop-blur lg:bottom-0" data-testid="ask-form">
        <div className="mx-auto flex max-w-[688px] gap-2">
          <input className="inp" placeholder="Ask the desk" aria-label="Question" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" autoComplete="off" />
          <Btn kind="primary" type="submit" disabled={busy != null || text.trim().length === 0}>Ask</Btn>
        </div>
      </form>
    </div>
  );
}
