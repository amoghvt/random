import { describe, expect, it } from 'vitest';
import { TvStream, decodeFrames, encodeFrame, parseStreamSymbols, streamCoverage, type SocketLike } from './tradingview-stream';

/** Frames in the shape captured from the live socket on 2026-11-24 (IG:NASDAQ), with synthetic prices. */
const frame = (m: string, p: unknown[]): string => encodeFrame(m, p);
const T = 1_795_555_980; // a minute boundary, epoch seconds

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  send(d: string): void { this.sent.push(d); }
  close(): void { this.onclose?.(); }
}

describe('tradingview stream', () => {
  it('encodes and decodes the wire format, heartbeats included', () => {
    const raw = frame('qsd', ['qs', { n: 'IG:NASDAQ', v: { lp: 26216.9 } }]) + '~m~4~m~~h~7' + frame('du', ['cs_0', {}]);
    const { heartbeats, messages } = decodeFrames(raw);
    expect(heartbeats).toEqual(['~h~7']);
    expect(messages.map((m) => m.m)).toEqual(['qsd', 'du']);
  });

  it('parses the symbol map and rejects junk', () => {
    expect(parseStreamSymbols('NQ=IG:NASDAQ, ES=OANDA:SPX500USD')).toEqual({ NQ: 'IG:NASDAQ', ES: 'OANDA:SPX500USD' });
    expect(parseStreamSymbols('off')).toEqual({});
    expect(parseStreamSymbols(undefined)).toEqual({});
    expect(parseStreamSymbols('NQ=not a symbol')).toEqual({});
    expect([...streamCoverage({ TV_STREAM_SYMBOLS: 'NQ=IG:NASDAQ' })]).toEqual(['NQ']);
  });

  it('subscribes on open, answers heartbeats, and builds the quote and the candles from the frames', () => {
    const sock = new FakeSocket();
    const ticks: number[] = [];
    const s = new TvStream({ NQ: 'IG:NASDAQ' }, { socket: () => sock, now: () => (T + 5) * 1000, timeframes: ['1m', '5m'], onTick: (t) => ticks.push(t.price) });
    s.start();
    sock.onopen!();
    expect(sock.sent.some((x) => x.includes('quote_add_symbols') && x.includes('IG:NASDAQ'))).toBe(true);
    expect(sock.sent.filter((x) => x.includes('create_series')).length).toBe(2);

    sock.onmessage!({ data: '~m~4~m~~h~1' });
    expect(sock.sent.at(-1)).toBe('~m~4~m~~h~1');

    sock.onmessage!({ data: frame('qsd', ['qs', { n: 'IG:NASDAQ', s: 'ok', v: { lp: 26216.9, lp_time: T, chp: -1.73, update_mode: 'streaming' } }]) });
    sock.onmessage!({ data: frame('qsd', ['qs', { n: 'IG:NASDAQ', s: 'ok', v: { lp: 26214.3, lp_time: T + 1 } }]) });
    const q = s.quote('NQ')!;
    expect(q).toMatchObject({ symbol: 'NQ', price: 26214.3, changePct: -1.73, source: 'tradingview:stream:IG:NASDAQ' });
    expect(q.asOf).toBe(new Date((T + 1) * 1000).toISOString());
    expect(s.streaming('NQ')).toBe(true);
    expect(ticks).toEqual([26216.9, 26214.3]);

    // History for the 1m series, then a live update of the forming bar and the next bar.
    sock.onmessage!({ data: frame('timescale_update', ['cs_0', { s_0: { s: [{ i: 0, v: [T - 60, 26210, 26218, 26209, 26216.3, 40] }, { i: 1, v: [T, 26216.3, 26216.4, 26216.3, 26216.4, 1] }] } }]) });
    sock.onmessage!({ data: frame('du', ['cs_0', { s_0: { s: [{ i: 1, v: [T, 26216.3, 26220.1, 26211.9, 26212.3, 54] }] } }]) });
    sock.onmessage!({ data: frame('du', ['cs_1', { s_1: { s: [{ i: 9, v: [T - 180, 26200, 26221, 26199, 26212.3, 300] }] } }]) });
    const m1 = s.candles('NQ', '1m');
    expect(m1.map((c) => c.t)).toEqual([(T - 60) * 1000, T * 1000]);
    expect(m1[1]).toMatchObject({ o: 26216.3, h: 26220.1, l: 26211.9, c: 26212.3, v: 54, tf: '1m', symbol: 'NQ' });
    expect(s.candles('NQ', '5m')).toHaveLength(1);
    expect(s.candles('NQ', '1m', T * 1000)).toHaveLength(1);
    // An unknown symbol or series is ignored, not stored.
    sock.onmessage!({ data: frame('qsd', ['qs', { n: 'IG:DAX', v: { lp: 1, lp_time: T } }]) });
    expect(s.quote('DAX')).toBeNull();
    s.stop();
  });

  it('reconnects after the socket closes and stops when told to', () => {
    const made: FakeSocket[] = [];
    const s = new TvStream({ NQ: 'IG:NASDAQ' }, { socket: () => { const x = new FakeSocket(); made.push(x); return x; } });
    s.start(); s.start();
    expect(made).toHaveLength(1);
    s.stop();
    s.start();
    expect(made).toHaveLength(1);
  });
});
