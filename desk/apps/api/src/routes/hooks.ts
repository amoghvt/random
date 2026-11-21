import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TF_MS, Timeframe, type ApiRoutes, type TradingViewWebhook } from '@desk/contracts';
import type { AppDeps } from '../app';
import { AttemptLimiter, safeEqual } from '../auth';
import { HttpError, parseWith } from '../http';
import { barOpen, tvSymbol, tvTime } from '../tradingview';

export const TV_WEBHOOK_SOURCE = 'tradingview:webhook';

const price = z.coerce.number().finite().positive();
const Body: z.ZodType<TradingViewWebhook, z.ZodTypeDef, unknown> = z.object({
  secret: z.string().min(1).max(512),
  symbol: z.string().min(1).max(64),
  tf: Timeframe.optional(),
  price: price.optional(),
  time: z.coerce.string().optional(),
  o: price.optional(), h: price.optional(), l: price.optional(), c: price.optional(),
  v: z.coerce.number().finite().min(0).optional(),
  message: z.string().max(2000).optional(),
});

export function register(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new AttemptLimiter(deps.clock, 10);

  app.post('/api/hooks/tradingview', async (req, reply): Promise<ApiRoutes['POST /api/hooks/tradingview']['res'] | { ok: false; error: string }> => {
    const expected = deps.env.TV_WEBHOOK_SECRET;
    if (!expected) throw new HttpError(503, 'TV_WEBHOOK_SECRET is not set; the TradingView webhook is off');
    if (limiter.blockedFor(req.ip) > 0) throw new HttpError(429, 'Too many bad secrets');
    const given = typeof req.body === 'object' && req.body !== null && 'secret' in req.body && typeof req.body.secret === 'string' ? req.body.secret : '';
    if (!safeEqual(given, expected)) {
      limiter.fail(req.ip);
      void reply.code(401);
      return { ok: false, error: 'Bad secret' };
    }
    const b = parseWith(Body, req.body);
    const now = deps.clock();
    const symbol = tvSymbol(b.symbol);
    const tf = b.tf ?? '1m';
    const at = b.time === undefined ? now : tvTime(b.time);
    if (!Number.isFinite(at)) throw new HttpError(400, `Unreadable time: ${b.time}`);
    const last = b.price ?? b.c;
    if (last === undefined) throw new HttpError(400, 'Nothing to store: send price, or o/h/l/c');

    const bar = b.o !== undefined && b.h !== undefined && b.l !== undefined && b.c !== undefined ? { o: b.o, h: b.h, l: b.l, c: b.c } : null;
    if (bar) {
      if (bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c)) throw new HttpError(400, 'Bar has high/low inside the body');
      await deps.store.upsertCandles([{ symbol, tf, t: barOpen(at, tf), ...bar, v: b.v ?? 0, source: TV_WEBHOOK_SOURCE }]);
    }
    // A bar alert fires at the bar's close, so the quote is as of receipt, not the bar's open time.
    const asOf = bar ? now : at;
    const prev = (await deps.store.latestQuotes([symbol]))[symbol];
    const prevClose = prev?.prevClose ?? null;
    await deps.store.putQuotes([{
      symbol, price: last, prevClose, changePct: prevClose ? (last / prevClose - 1) * 100 : null,
      asOf: new Date(asOf).toISOString(), source: TV_WEBHOOK_SOURCE, cadenceSec: TF_MS[tf] / 1000,
    }]);
    return { ok: true };
  });
}
