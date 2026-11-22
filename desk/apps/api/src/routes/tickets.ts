import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Fill, OverrideKind, TicketStatus, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import {
  cancelTicketById, closeTicketAt, fillTicket, overridePromptFor, overrideTicket, previewTicket, saveTicket, ticketDetail,
} from '../services/tickets';

const ListQuery = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const FillBody = z.object({ fill: Fill });
const OverrideBody = z.object({ kind: OverrideKind, reason: z.string() });
const CloseBody = z.object({ price: z.number().finite().positive(), ts: z.string().optional() });
type Id = { Params: { id: string } };

/** One line, said by the trader: not blank, not a paragraph. */
function oneLine(reason: string): string {
  const text = reason.trim();
  if (text.length < 3) throw new HttpError(400, 'An override takes a one-line reason. Three characters minimum.');
  if (/[\r\n]/.test(text) || text.length > 240) throw new HttpError(400, 'One line. 240 characters at most.');
  return text;
}

export function register(app: FastifyInstance, deps: AppDeps): void {
  /** Sizing, validation and guardrails for a draft. Nothing is written. */
  app.post('/api/tickets/preview', async (req): Promise<ApiRoutes['POST /api/tickets/preview']['res']> => previewTicket(deps, req.body, deps.clock()));

  /** Saves the draft when it passes; a refusal is a 200 with `ok: false`, the errors and the guardrail firings. */
  app.post('/api/tickets', async (req): Promise<ApiRoutes['POST /api/tickets']['res']> => saveTicket(deps, req.body, deps.clock()));

  app.get('/api/tickets', async (req): Promise<ApiRoutes['GET /api/tickets']['res']> => {
    const q = parseWith(ListQuery, req.query);
    const wanted = (q.status ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const status = wanted.map((s) => {
      const p = TicketStatus.safeParse(s);
      if (!p.success) throw new HttpError(400, `Unknown ticket status ${s}`);
      return p.data;
    });
    return deps.store.list('tickets', { ...(status.length ? { status } : {}), limit: q.limit });
  });

  app.get<Id>('/api/tickets/:id', async (req): Promise<ApiRoutes['GET /api/tickets/:id']['res']> => ticketDetail(deps, req.params.id, deps.clock()));

  app.post<Id>('/api/tickets/:id/fill', async (req): Promise<ApiRoutes['POST /api/tickets/:id/fill']['res']> => {
    const { fill } = parseWith(FillBody, req.body);
    return fillTicket(deps, req.params.id, fill, deps.clock());
  });

  app.get<Id>('/api/tickets/:id/override-prompt', async (req): Promise<ApiRoutes['GET /api/tickets/:id/override-prompt']['res']> => overridePromptFor(deps, req.params.id, deps.clock()));

  app.post<Id>('/api/tickets/:id/override', async (req): Promise<ApiRoutes['POST /api/tickets/:id/override']['res']> => {
    const b = parseWith(OverrideBody, req.body);
    return overrideTicket(deps, req.params.id, b.kind, oneLine(b.reason), deps.clock());
  });

  app.post<Id>('/api/tickets/:id/close', async (req): Promise<ApiRoutes['POST /api/tickets/:id/close']['res']> => {
    const b = parseWith(CloseBody, req.body);
    return closeTicketAt(deps, req.params.id, { price: b.price, ...(b.ts !== undefined ? { ts: b.ts } : {}) }, deps.clock());
  });

  app.post<Id>('/api/tickets/:id/cancel', async (req): Promise<ApiRoutes['POST /api/tickets/:id/cancel']['res']> => cancelTicketById(deps, req.params.id, deps.clock()));
}
