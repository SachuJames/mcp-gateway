import { FastifyInstance } from 'fastify';
import { KeyStore } from './auth.js';
import { AuditLog, Stats } from './audit.js';
import { RateLimiter } from './ratelimit.js';
import { RegisterServerSpec, ServerRegistry } from './registry.js';

export interface AdminDeps {
  registry: ServerRegistry;
  keys: KeyStore;
  limiter: RateLimiter;
  audit: AuditLog;
  stats: Stats;
  adminToken: string;
}

function redactTransport(transport: unknown): unknown {
  if (typeof transport !== 'object' || transport === null) return transport;
  const t = transport as Record<string, unknown>;
  if (t['type'] === 'stdio' && typeof t['env'] === 'object' && t['env'] !== null) {
    return { ...t, env: Object.fromEntries(Object.keys(t['env'] as object).map((k) => [k, '***'])) };
  }
  return t;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', async (req, reply) => {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${deps.adminToken}`) {
          return reply.status(401).send({ error: 'unauthorized' });
        }
      });

      admin.get('/servers', async () => ({
        servers: deps.registry.list().map((s) => ({ ...s, transport: redactTransport(s.transport) })),
      }));

      admin.post('/servers', async (req, reply) => {
        const spec = req.body as RegisterServerSpec;
        if (!spec || typeof spec.name !== 'string' || !spec.transport) {
          return reply.status(400).send({ error: 'body needs { name, transport }' });
        }
        try {
          const server = await deps.registry.register(spec);
          return reply.status(201).send({ server: { ...server, transport: redactTransport(server.transport) } });
        } catch (err) {
          return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      admin.delete('/servers/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const removed = await deps.registry.unregister(id);
        if (!removed) return reply.status(404).send({ error: 'unknown server' });
        return { ok: true };
      });

      admin.post('/servers/:id/refresh', async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          const tools = await deps.registry.refreshTools(id);
          return { ok: true, tools };
        } catch (err) {
          return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      admin.get('/tools', async () => {
        const tools = [];
        for (const server of deps.registry.list()) {
          for (const tool of server.tools) {
            tools.push({ server: server.name, serverId: server.id, ...tool });
          }
        }
        return { tools };
      });

      admin.get('/keys', async () => ({ keys: deps.keys.list() }));

      admin.post('/keys', async (req, reply) => {
        const spec = req.body as { name?: string; servers?: string[]; tools?: string[]; rateLimit?: { capacity: number; refillPerSecond: number } };
        try {
          const { record, secret } = deps.keys.create({
            name: spec.name ?? '',
            servers: spec.servers ?? [],
            tools: spec.tools,
            rateLimit: spec.rateLimit,
          });
          const { keyHash: _h, ...safe } = record;
          return reply.status(201).send({ key: safe, secret });
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      admin.delete('/keys/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const revoked = deps.keys.revoke(id);
        if (!revoked) return reply.status(404).send({ error: 'unknown key' });
        deps.limiter.reset(id);
        return { ok: true };
      });

      admin.get('/stats', async () => deps.stats.snapshot());
      admin.get('/logs', async (req) => {
        const { limit } = req.query as { limit?: string };
        const n = Math.min(Math.max(Number.parseInt(limit ?? '100', 10) || 100, 1), 1000);
        return { logs: deps.audit.recent(n) };
      });
    },
    { prefix: '/admin' },
  );
}
