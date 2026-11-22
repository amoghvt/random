import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Direction, INSTRUMENTS, hashId, iso, type ApiRoutes, type Position } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import { accountRows, loadRules, putAccountState } from '../services/accounts';
import { positionsView, runPositions } from '../services/positions';

const price = z.number().finite().positive();
const ManualPosition = z.object({
  accountId: z.string().min(1), instrument: z.string().min(1), direction: Direction,
  units: z.number().finite().positive(), entryPrice: price,
  liquidationPrice: price.nullable().optional(), leverage: z.number().finite().positive().nullable().optional(),
  ticketId: z.string().min(1).nullable().optional(),
});
const usd = z.number().finite();
const AccountStateIn = z.object({
  balance: usd.nonnegative(), equity: usd.nonnegative().optional(), active: z.boolean().optional(),
  dayStartBalance: usd.nonnegative().optional(), cyclePnl: usd.optional(), bestDayPnlInCycle: usd.optional(),
  qualifyingDaysInCycle: z.number().int().nonnegative().optional(), payoutsTaken: z.number().int().nonnegative().optional(),
  startingBalance: usd.positive().optional(),
});

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/positions', async (): Promise<ApiRoutes['GET /api/positions']['res']> => positionsView(deps, deps.clock()));

  /** A position the trader holds that no ticket fill created. The monitor marks it before the view is returned. */
  app.post('/api/positions', async (req): Promise<ApiRoutes['POST /api/positions']['res']> => {
    const b = parseWith(ManualPosition, req.body);
    const now = deps.clock();
    if (!(await loadRules(deps)).some((r) => r.id === b.accountId)) throw new HttpError(400, `Account ${b.accountId} is not on the desk.`);
    if (!INSTRUMENTS[b.instrument]?.tradable) throw new HttpError(400, `${b.instrument} is not a tradable instrument here.`);
    if (b.ticketId && !(await deps.store.get('tickets', b.ticketId))) throw new HttpError(400, `Ticket ${b.ticketId} is not in the journal.`);
    const position: Position = {
      id: hashId('pos', b.accountId, b.instrument, b.direction, iso(now)), accountId: b.accountId, ticketId: b.ticketId ?? null,
      instrument: b.instrument, direction: b.direction, units: b.units, entryPrice: b.entryPrice, openedAt: iso(now),
      liquidationPrice: b.liquidationPrice ?? null, leverage: b.leverage ?? null,
    };
    await deps.store.put('positions', [position]);
    await runPositions(deps, now);
    return positionsView(deps, now);
  });

  app.delete<{ Params: { id: string } }>('/api/positions/:id', async (req): Promise<ApiRoutes['DELETE /api/positions/:id']['res']> => {
    const now = deps.clock();
    if (!(await deps.store.get('positions', req.params.id))) throw new HttpError(404, 'No such position');
    await deps.store.remove('positions', req.params.id);
    await runPositions(deps, now);
    return positionsView(deps, now);
  });

  app.get('/api/accounts', async (): Promise<ApiRoutes['GET /api/accounts']['res']> => accountRows(deps, deps.clock()));

  /** The trader's real numbers from the firm dashboard. Entering a balance is what makes an account active. */
  app.put<{ Params: { id: string } }>('/api/accounts/:id/state', async (req): Promise<ApiRoutes['PUT /api/accounts/:id/state']['res']> => {
    const b = parseWith(AccountStateIn, req.body);
    if (!(await loadRules(deps)).some((r) => r.id === req.params.id)) throw new HttpError(404, 'No such account');
    return putAccountState(deps, req.params.id, b, deps.clock());
  });
}
