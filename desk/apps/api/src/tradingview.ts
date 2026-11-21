import { TF_MS, type Candle, type Timeframe } from '@desk/contracts';

/** 'CME_MINI:NQ1!' -> 'NQ', 'NASDAQ:NVDA' -> 'NVDA'. Drops the exchange prefix and the continuous-contract suffix. */
export function tvSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  return s.slice(s.lastIndexOf(':') + 1).replace(/\d!$/, '');
}

/** Unix seconds, unix milliseconds or an ISO string -> epoch ms. NaN when unparseable. */
export function tvTime(raw: string | number): number {
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  return Date.parse(s);
}

/** Intraday bars are keyed by their open, aligned to the timeframe. Daily bars keep the exchange's own session stamp. */
export const barOpen = (t: number, tf: Timeframe): number => (tf === '1d' ? t : Math.floor(t / TF_MS[tf]) * TF_MS[tf]);

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export class CsvError extends Error {}

/**
 * A TradingView chart export: header `time,open,high,low,close[,Volume]` plus any indicator columns (ignored).
 * Strict: a row with an unreadable time or price fails the whole import instead of being dropped or guessed.
 */
export function parseTradingViewCsv(csv: string, symbol: string, tf: Timeframe, source = 'tradingview:csv'): Candle[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new CsvError('The CSV is empty');
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const at = (name: string): number => header.indexOf(name);
  const [ti, oi, hi, li, ci, vi] = [at('time'), at('open'), at('high'), at('low'), at('close'), at('volume')];
  const missing = [['time', ti], ['open', oi], ['high', hi], ['low', li], ['close', ci]].filter(([, i]) => i === -1).map(([n]) => n);
  if (missing.length > 0) throw new CsvError(`Missing column(s): ${missing.join(', ')}. Expected time,open,high,low,close[,Volume]`);
  const byT = new Map<number, Candle>();
  for (let n = 1; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n]!);
    const t = tvTime(cells[ti] ?? '');
    const num = (i: number): number => (cells[i] === undefined || cells[i] === '' ? NaN : Number(cells[i]));
    const [o, h, l, c] = [num(oi), num(hi), num(li), num(ci)];
    const v = vi === -1 || cells[vi] === '' || cells[vi] === undefined || cells[vi]!.toLowerCase() === 'nan' ? 0 : Number(cells[vi]);
    if (![t, o, h, l, c, v].every(Number.isFinite)) throw new CsvError(`Line ${n + 1} is not a bar: ${lines[n]!.slice(0, 80)}`);
    if (h < Math.max(o, c, l) || l > Math.min(o, c)) throw new CsvError(`Line ${n + 1} has high/low inside the body: ${lines[n]!.slice(0, 80)}`);
    const open = barOpen(t, tf);
    byT.set(open, { symbol, tf, t: open, o, h, l, c, v, source });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
