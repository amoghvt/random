import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Timeframe, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import { chartView, knownSymbol } from '../services/charts';

const Query = z.object({ tf: Timeframe.default('15m') });

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { symbol: string } }>('/api/charts/:symbol', async (req): Promise<ApiRoutes['GET /api/charts/:symbol']['res']> => {
    const { tf } = parseWith(Query, req.query);
    const symbol = req.params.symbol.toUpperCase();
    if (!knownSymbol(symbol)) throw new HttpError(404, `No instrument ${req.params.symbol}`);
    return chartView(deps, symbol, tf, deps.clock());
  });
}
