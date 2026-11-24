/**
 * Real-time prices from TradingView's public chart websocket (the feed its embedded widgets use, no login).
 * Free CME futures on TradingView are 10 minutes delayed; broker CFD feeds such as IG's "US Tech 100 Cash"
 * (IG:NASDAQ) stream tick by tick and trade nearly 24 hours, so the desk reads its primary index from one of those.
 *
 * `TV_STREAM_SYMBOLS` maps desk symbols to TradingView symbols, e.g. `NQ=IG:NASDAQ` (comma-separated for more).
 * A mapped desk symbol takes its quotes and candles from the stream; the delayed sources stop writing its candles,
 * so one series is never a mix of two instruments. IG's cash index sits below the NQ future by the futures basis:
 * levels from this feed are cash-index levels.
 *
 * The socket lives for the process: `poll` only reads what the stream has buffered. It reconnects with backoff, and
 * a quote older than its cadence is flagged stale by the usual freshness rule.
 */
import { TF_MS, iso, type Candle, type Quote, type Timeframe } from '@desk/contracts';
import { item, type Env, type Feed, type ItemOf } from '../types';

export const TV_WS_URL = 'wss://data.tradingview.com/socket.io/websocket?type=chart';
const RESOLUTION: Record<Timeframe, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '1d': '1D' };
const TF_OF: Record<string, Timeframe> = Object.fromEntries(Object.entries(RESOLUTION).map(([tf, r]) => [r, tf as Timeframe]));
/** Bars asked for per timeframe when a series is opened. */
const HISTORY_BARS: Record<Timeframe, number> = { '1m': 1500, '5m': 1500, '15m': 1500, '1h': 1500, '1d': 1500 };
const KEEP_BARS = 3000;

/* ───────────── wire format (pure) ───────────── */

export const encodeFrame = (method: string, params: unknown[]): string => {
  const body = JSON.stringify({ m: method, p: params });
  return `~m~${body.length}~m~${body}`;
};
export interface TvMessage { m?: string; p?: unknown[] }
/** Splits a raw socket payload into heartbeats (to be echoed) and JSON messages. */
export function decodeFrames(raw: string): { heartbeats: string[]; messages: TvMessage[] } {
  const heartbeats: string[] = [], messages: TvMessage[] = [];
  for (const part of raw.split(/~m~\d+~m~/)) {
    if (!part) continue;
    if (part.startsWith('~h~')) { heartbeats.push(part); continue; }
    try { messages.push(JSON.parse(part) as TvMessage); } catch { /* not JSON: ignore */ }
  }
  return { heartbeats, messages };
}

/** `NQ=IG:NASDAQ,ES=OANDA:SPX500USD` -> { NQ: 'IG:NASDAQ', ES: 'OANDA:SPX500USD' }. Empty or `off` disables the stream. */
export function parseStreamSymbols(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim().toLowerCase() === 'off') return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [desk, tv] = pair.split('=').map((s) => s.trim());
    if (desk && tv && /^[A-Z0-9_]+:[A-Z0-9_!.]+$/i.test(tv)) out[desk] = tv;
  }
  return out;
}
export const streamCoverage = (env: Env): Set<string> => new Set(Object.keys(parseStreamSymbols(env.TV_STREAM_SYMBOLS)));

/* ───────────── stream state ───────────── */

interface QuoteState { price: number | null; prevClose: number | null; changePct: number | null; at: number | null; mode: string | null }
export interface StreamTick { symbol: string; price: number; at: number }

/** The minimal socket surface the stream needs; Node 22's global WebSocket satisfies it. */
export interface SocketLike { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: ((e: unknown) => void) | null }
export type SocketFactory = (url: string) => SocketLike;

const defaultSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket: new (u: string, o?: unknown) => SocketLike }).WebSocket;
  return new Ctor(url, { headers: { Origin: 'https://www.tradingview.com' } });
};

export class TvStream {
  private socket: SocketLike | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly quotes = new Map<string, QuoteState>();
  private readonly bars = new Map<string, Map<number, Candle>>();
  /** series id -> desk symbol and timeframe. */
  private readonly series = new Map<string, { symbol: string; tf: Timeframe }>();
  private readonly byTv: Record<string, string>;
  lastMessageAt: number | null = null;
  lastError: string | null = null;
  connects = 0;

  constructor(
    readonly symbols: Record<string, string>,
    private readonly opts: { socket?: SocketFactory; now?: () => number; timeframes?: Timeframe[]; onTick?: (t: StreamTick) => void } = {},
  ) {
    this.byTv = Object.fromEntries(Object.entries(symbols).map(([desk, tv]) => [tv, desk]));
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private tfs(): Timeframe[] { return this.opts.timeframes ?? ['1m', '5m', '15m', '1h', '1d']; }

  start(): void {
    if (this.socket || this.stopped || Object.keys(this.symbols).length === 0) return;
    this.connects++;
    const ws = (this.opts.socket ?? defaultSocket)(TV_WS_URL);
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(encodeFrame('set_auth_token', ['unauthorized_user_token']));
      ws.send(encodeFrame('quote_create_session', ['qs']));
      ws.send(encodeFrame('quote_set_fields', ['qs', 'lp', 'lp_time', 'chp', 'prev_close_price', 'update_mode']));
      let n = 0;
      for (const [desk, tv] of Object.entries(this.symbols)) {
        ws.send(encodeFrame('quote_add_symbols', ['qs', tv]));
        for (const tf of this.tfs()) {
          const cs = `cs_${n}`, sid = `s_${n}`; n++;
          this.series.set(`${cs}|${sid}`, { symbol: desk, tf });
          ws.send(encodeFrame('chart_create_session', [cs, '']));
          ws.send(encodeFrame('resolve_symbol', [cs, 'sym', `=${JSON.stringify({ symbol: tv, adjustment: 'splits' })}`]));
          ws.send(encodeFrame('create_series', [cs, sid, sid, 'sym', RESOLUTION[tf], HISTORY_BARS[tf]]));
        }
      }
    };
    ws.onmessage = (e) => this.receive(String(e.data));
    ws.onerror = (e) => { this.lastError = e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'socket error'; };
    ws.onclose = () => {
      this.socket = null;
      if (this.stopped) return;
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.start(), wait);
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  /** Feed one raw socket payload (exposed for tests and replays of captured frames). */
  receive(raw: string): void {
    const { heartbeats, messages } = decodeFrames(raw);
    for (const h of heartbeats) this.socket?.send(`~m~${h.length}~m~${h}`);
    for (const msg of messages) {
      this.lastMessageAt = this.now();
      if (msg.m === 'qsd') this.onQuote(msg.p?.[1] as { n?: string; v?: Record<string, unknown> } | undefined);
      else if (msg.m === 'timescale_update' || msg.m === 'du') this.onBars(String(msg.p?.[0]), msg.p?.[1] as Record<string, { s?: Array<{ v: number[] }> }> | undefined);
      else if (msg.m === 'critical_error' || msg.m === 'symbol_error' || msg.m === 'series_error') this.lastError = `${msg.m}: ${JSON.stringify(msg.p).slice(0, 160)}`;
    }
  }

  private onQuote(q: { n?: string; v?: Record<string, unknown> } | undefined): void {
    const desk = q?.n ? this.byTv[q.n] : undefined;
    if (!desk || !q?.v) return;
    const s = this.quotes.get(desk) ?? { price: null, prevClose: null, changePct: null, at: null, mode: null };
    const v = q.v;
    if (typeof v.lp === 'number') s.price = v.lp;
    if (typeof v.lp_time === 'number') s.at = v.lp_time * 1000;
    if (typeof v.chp === 'number') s.changePct = v.chp;
    if (typeof v.prev_close_price === 'number') s.prevClose = v.prev_close_price;
    if (typeof v.update_mode === 'string') s.mode = v.update_mode;
    this.quotes.set(desk, s);
    if (typeof v.lp === 'number' && s.at !== null) this.opts.onTick?.({ symbol: desk, price: v.lp, at: s.at });
  }

  private onBars(session: string, body: Record<string, { s?: Array<{ v: number[] }> }> | undefined): void {
    if (!body) return;
    for (const [sid, payload] of Object.entries(body)) {
      const meta = this.series.get(`${session}|${sid}`);
      if (!meta || !payload?.s) continue;
      const key = `${meta.symbol}|${meta.tf}`;
      const map = this.bars.get(key) ?? new Map<number, Candle>();
      for (const b of payload.s) {
        const [t, o, h, l, c, v] = b.v;
        if (t === undefined || o === undefined || h === undefined || l === undefined || c === undefined) continue;
        map.set(t * 1000, { symbol: meta.symbol, tf: meta.tf, t: t * 1000, o, h, l, c, v: v ?? 0, source: `tradingview:stream:${this.symbols[meta.symbol]}` });
      }
      if (map.size > KEEP_BARS) for (const k of [...map.keys()].sort((a, b) => a - b).slice(0, map.size - KEEP_BARS)) map.delete(k);
      this.bars.set(key, map);
    }
  }

  quote(symbol: string): Quote | null {
    const s = this.quotes.get(symbol);
    if (!s || s.price === null || s.at === null) return null;
    return { symbol, price: s.price, prevClose: s.prevClose, changePct: s.changePct, asOf: iso(s.at), source: `tradingview:stream:${this.symbols[symbol]}`, cadenceSec: 15 };
  }
  /** Candles ascending. `sinceMs` limits to bars at or after that open time. */
  candles(symbol: string, tf: Timeframe, sinceMs = 0): Candle[] {
    return [...(this.bars.get(`${symbol}|${tf}`)?.values() ?? [])].filter((c) => c.t >= sinceMs).sort((a, b) => a.t - b.t);
  }
  /** True when the venue says the symbol streams without a delay. */
  streaming(symbol: string): boolean { return this.quotes.get(symbol)?.mode === 'streaming'; }
}

/* ───────────── process-wide stream and the two feeds ───────────── */

let shared: { key: string; stream: TvStream } | null = null;
const tickListeners = new Set<(t: StreamTick) => void>();
/** Called on every trade tick of a streamed symbol; returns the unsubscribe. This is the fast path for alerts. */
export function onStreamTick(fn: (t: StreamTick) => void): () => void { tickListeners.add(fn); return () => tickListeners.delete(fn); }

/** The process's stream for this env, started on first use. Null when `TV_STREAM_SYMBOLS` is unset or `off`. */
export function streamFor(env: Env): TvStream | null {
  const symbols = parseStreamSymbols(env.TV_STREAM_SYMBOLS);
  const key = JSON.stringify(symbols);
  if (Object.keys(symbols).length === 0) return null;
  if (shared?.key !== key) {
    shared?.stream.stop();
    shared = { key, stream: new TvStream(symbols, { onTick: (t) => { for (const fn of tickListeners) fn(t); } }) };
  }
  shared.stream.start();
  return shared.stream;
}
export function stopStream(): void { shared?.stream.stop(); shared = null; }

const enabled = (env: Env): boolean => Object.keys(parseStreamSymbols(env.TV_STREAM_SYMBOLS)).length > 0;

export const tradingViewStreamQuotes: Feed<ItemOf<'quote'>> = {
  name: 'tradingview.stream.quotes', kind: 'quotes', live: true, requiresKey: null, cadenceSec: 5, verified: true,
  enabled,
  async poll(ctx) {
    const s = streamFor(ctx.env);
    if (!s) return [];
    const out: Array<ItemOf<'quote'>> = [];
    for (const symbol of Object.keys(s.symbols)) {
      if (ctx.symbols && !ctx.symbols.includes(symbol)) continue;
      const q = s.quote(symbol);
      if (q) out.push(item('quote', q, { source: q.source, asOf: q.asOf, cadenceSec: q.cadenceSec, symbol, meta: { delayed: !s.streaming(symbol), streaming: s.streaming(symbol) } }));
    }
    return out;
  },
};

/** Writes the last few bars of every timeframe each poll (the stream holds the history; the first poll writes all of it). */
export function tradingViewStreamCandles(): Feed<ItemOf<'candle'>> {
  const written = new Set<string>();
  return {
    name: 'tradingview.stream.candles', kind: 'candles', live: true, requiresKey: null, cadenceSec: 5, verified: true,
    enabled,
    async poll(ctx) {
      const s = streamFor(ctx.env);
      if (!s) return [];
      const out: Array<ItemOf<'candle'>> = [];
      for (const symbol of Object.keys(s.symbols)) {
        for (const tf of ['1m', '5m', '15m', '1h', '1d'] as Timeframe[]) {
          const k = `${symbol}|${tf}`;
          const all = s.candles(symbol, tf);
          if (all.length === 0) continue;
          const bars = written.has(k) ? all.slice(-3) : all;
          written.add(k);
          for (const c of bars) out.push(item('candle', c, { source: c.source, asOf: iso(Math.min(ctx.now, c.t + TF_MS[tf])), cadenceSec: TF_MS[tf] / 1000, symbol, meta: { streaming: true } }));
        }
      }
      return out;
    },
  };
}

/** Which TradingView resolution a desk timeframe maps to, and back (exported for the smoke script). */
export const tvResolution = (tf: Timeframe): string => RESOLUTION[tf];
export const tfOfResolution = (r: string): Timeframe | undefined => TF_OF[r];
