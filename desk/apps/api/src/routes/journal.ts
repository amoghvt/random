import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { parseWith } from '../http';
import { latestBrief } from '../services/briefs';
import { addNote, journalView } from '../services/journal';

const NoteBody = z.object({ text: z.string().trim().min(1).max(4000), tags: z.array(z.string().max(40)).max(12).optional() });
const BriefQuery = z.object({ kind: z.enum(['morning', 'recap', 'weekly']) });

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/journal', async (): Promise<ApiRoutes['GET /api/journal']['res']> => journalView(deps, deps.clock()));

  app.post('/api/journal/notes', async (req): Promise<ApiRoutes['POST /api/journal/notes']['res']> => {
    const b = parseWith(NoteBody, req.body);
    return addNote(deps, b.text, b.tags ?? [], deps.clock());
  });

  app.get('/api/briefs/latest', async (req, reply) => {
    const { kind } = parseWith(BriefQuery, req.query);
    const brief: ApiRoutes['GET /api/briefs/latest']['res'] = await latestBrief(deps, kind);
    // No brief yet is the JSON value null, not an empty body.
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(brief));
  });
}
