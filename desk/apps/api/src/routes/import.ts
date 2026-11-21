import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Timeframe, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import { CsvError, parseTradingViewCsv, tvSymbol } from '../tradingview';

const Body = z.object({ symbol: z.string().min(1).max(64), tf: Timeframe, csv: z.string().min(1) });

export function register(app: FastifyInstance, deps: AppDeps): void {
  // A full-history 1m export runs to tens of thousands of rows; this route alone takes a large body.
  app.post('/api/import/tradingview-csv', { bodyLimit: 32 * 1_048_576 }, async (req): Promise<ApiRoutes['POST /api/import/tradingview-csv']['res']> => {
    const b = parseWith(Body, req.body);
    try {
      const candles = parseTradingViewCsv(b.csv, tvSymbol(b.symbol), b.tf);
      await deps.store.upsertCandles(candles);
      return { ok: true, bars: candles.length };
    } catch (e) {
      if (e instanceof CsvError) throw new HttpError(400, e.message);
      throw e;
    }
  });
}
