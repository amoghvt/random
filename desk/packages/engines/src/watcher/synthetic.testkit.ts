/** Synthetic candle builder for detector unit tests. Nothing built here is market data. */
import { TF_MS, type Candle, type Timeframe } from '@desk/contracts';
import { buildContext, type TfContext } from './core';

export const SYN = 'SYN';
export const T0 = Date.UTC(2026, 0, 5, 15, 0);

export class SyntheticTape {
  readonly candles: Candle[] = [];
  private price: number;
  constructor(start: number, private readonly tf: Timeframe = '15m', private readonly t0: number = T0, private readonly symbol: string = SYN, private readonly wick = 0.2) {
    this.price = start;
  }
  /** One explicit candle. */
  raw(o: number, h: number, l: number, c: number, v = 100): this {
    this.candles.push({ symbol: this.symbol, tf: this.tf, t: this.t0 + this.candles.length * TF_MS[this.tf], o, h, l, c, v, source: 'synthetic' });
    this.price = c;
    return this;
  }
  /** Straight line of closes to `target` in `steps` candles, small wicks. */
  to(target: number, steps: number, v = 100): this {
    const from = this.price;
    for (let i = 1; i <= steps; i++) {
      const o = this.price, c = from + ((target - from) * i) / steps;
      this.raw(o, Math.max(o, c) + this.wick, Math.min(o, c) - this.wick, c, v);
    }
    return this;
  }
  /** `n` quiet candles oscillating half a point around the current price inside a +/-1 range. */
  calm(n: number, v = 100): this {
    const p = this.price;
    for (let i = 0; i < n; i++) this.raw(i % 2 ? p - 0.25 : p + 0.25, p + 1, p - 1, i % 2 ? p + 0.25 : p - 0.25, v);
    this.price = p;
    return this;
  }
  ctx(): TfContext {
    return buildContext(this.symbol, this.tf, this.candles, this.candles.length);
  }
}
export const synthetic = (start: number, tf: Timeframe = '15m', t0: number = T0, symbol: string = SYN, wick = 0.2): SyntheticTape => new SyntheticTape(start, tf, t0, symbol, wick);
