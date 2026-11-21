/** Instrument metadata. Engines size in "units": contracts for futures, USD notional for perps and stocks. */
export type InstrumentKind = 'future' | 'perp' | 'stock' | 'index' | 'rate' | 'crypto' | 'fx';
export interface InstrumentSpec {
  symbol: string;
  name: string;
  kind: InstrumentKind;
  /** USD per 1.00 of price per unit (futures point value). 0 = notional-sized (perps, stocks, crypto). */
  pointValue: number;
  tickSize: number;
  /** The underlying price series this instrument tracks (NQ-PERP and MNQ track NQ). */
  priceSymbol: string;
  /** Free-source symbol for the Yahoo adapter. */
  yahoo?: string;
  tradable: boolean;
}

const f = (symbol: string, name: string, pointValue: number, tickSize: number, yahoo: string, priceSymbol = symbol): InstrumentSpec =>
  ({ symbol, name, kind: 'future', pointValue, tickSize, priceSymbol, yahoo, tradable: true });
const s = (symbol: string, name: string): InstrumentSpec =>
  ({ symbol, name, kind: 'stock', pointValue: 0, tickSize: 0.01, priceSymbol: symbol, yahoo: symbol, tradable: true });
const x = (symbol: string, name: string, kind: InstrumentKind, yahoo: string): InstrumentSpec =>
  ({ symbol, name, kind, pointValue: 0, tickSize: 0.01, priceSymbol: symbol, yahoo, tradable: false });

const ALL: InstrumentSpec[] = [
  f('NQ', 'E-mini Nasdaq-100', 20, 0.25, 'NQ=F'),
  f('MNQ', 'Micro E-mini Nasdaq-100', 2, 0.25, 'MNQ=F', 'NQ'),
  f('ES', 'E-mini S&P 500', 50, 0.25, 'ES=F'),
  f('YM', 'E-mini Dow', 5, 1, 'YM=F'),
  f('RTY', 'E-mini Russell 2000', 50, 0.1, 'RTY=F'),
  f('CL', 'WTI crude', 1000, 0.01, 'CL=F'),
  f('GC', 'Gold', 100, 0.1, 'GC=F'),
  { symbol: 'NQ-PERP', name: 'NQ perp (Vest)', kind: 'perp' as const, pointValue: 0, tickSize: 0.25, priceSymbol: 'NQ', yahoo: 'NQ=F', tradable: true },
  ...['NVDA', 'AMZN', 'INTC', 'CRWV', 'NBIS', 'SNDK', 'TTWO', 'AMD', 'AVGO', 'MU', 'TSM'].map((t) => s(t, t)),
  ...['QQQ', 'SPY', 'RSP', 'XLP', 'XLU', 'SOXX', 'GLD', 'IBIT'].map((t) => ({ ...s(t, t), tradable: false })),
  x('SOX', 'PHLX Semiconductor', 'index', '^SOX'),
  x('NDX', 'Nasdaq-100', 'index', '^NDX'),
  x('VIX', 'VIX', 'index', '^VIX'),
  x('VIX3M', 'VIX 3-month', 'index', '^VIX3M'),
  x('DXY', 'US Dollar Index', 'fx', 'DX-Y.NYB'),
  x('US3M', 'US 13-week bill yield', 'rate', '^IRX'),
  { ...x('US2Y', 'US 2Y yield', 'rate', ''), yahoo: undefined },
  x('ZT', '2Y T-note future (price; 2Y yield proxy on free data)', 'rate', 'ZT=F'),
  x('ZN', '10Y T-note future (price)', 'rate', 'ZN=F'),
  x('US5Y', 'US 5Y yield', 'rate', '^FVX'),
  x('US10Y', 'US 10Y yield', 'rate', '^TNX'),
  x('US30Y', 'US 30Y yield', 'rate', '^TYX'),
  x('ZQ', '30-day Fed funds future', 'rate', 'ZQ=F'),
  { ...x('BTC', 'Bitcoin', 'crypto', 'BTC-USD'), tradable: true },
  { ...x('ETH', 'Ether', 'crypto', 'ETH-USD'), tradable: true },
];
export const INSTRUMENTS: Record<string, InstrumentSpec> = Object.fromEntries(ALL.map((i) => [i.symbol, i]));

export const DEFAULT_WATCHLIST = ['NVDA', 'AMZN', 'INTC', 'CRWV', 'NBIS', 'SNDK', 'TTWO', 'AMD', 'AVGO', 'MU', 'TSM'];
export const CORE_SYMBOLS = ['NQ', 'ES', 'YM', 'RTY', 'SOX', 'VIX', 'DXY', 'US2Y', 'US10Y', 'US30Y'];

export function instrument(symbol: string): InstrumentSpec {
  const i = INSTRUMENTS[symbol];
  if (!i) throw new Error(`Unknown instrument ${symbol}`);
  return i;
}
/** USD P&L for a price move on a given size. units = contracts (futures) or USD notional (everything else). */
export function pnlUsd(symbol: string, units: number, entry: number, exit: number, direction: 'long' | 'short'): number {
  const i = instrument(symbol);
  const sign = direction === 'long' ? 1 : -1;
  return i.pointValue > 0 ? (exit - entry) * i.pointValue * units * sign : ((exit - entry) / entry) * units * sign;
}
/** USD notional of a size at a price. */
export function notionalUsd(symbol: string, units: number, price: number): number {
  const i = instrument(symbol);
  return i.pointValue > 0 ? units * i.pointValue * price : units;
}
