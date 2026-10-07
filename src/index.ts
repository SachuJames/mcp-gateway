import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerAdminRoutes } from './admin.js';
import { AuditLog, Stats } from './audit.js';
import { KeyStore } from './auth.js';
import { loadConfig } from './config.js';
import { registerGatewayRoutes } from './gateway.js';
import { RateLimiter } from './ratelimit.js';
import { ServerRegistry } from './registry.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  const registry = new ServerRegistry(config.defaultCallTimeoutMs);
  const keys = new KeyStore();
  const limiter = new RateLimiter(config.rateLimit.capacity, config.rateLimit.refillPerSecond);
  const audit = new AuditLog();
  const stats = new Stats();
  await audit.init(config.logDir);

  app.get('/healthz', async () => ({ status: 'ok', service: 'mcp-gateway' }));

  await registerGatewayRoutes(app, { registry, keys, limiter, audit, stats, config });
  await registerAdminRoutes(app, { registry, keys, limiter, audit, stats, adminToken: config.adminToken });

  const dashboardDir = join(process.cwd(), 'dashboard', 'dist');
  if (existsSync(dashboardDir)) {
    await app.register(fastifyStatic, { root: dashboardDir });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/mcp') || req.url.startsWith('/admin') || req.url === '/healthz') {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const shutdown = async () => {
    app.log.info('shutting down');
    await registry.shutdown();
    await app.close();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return { app, config, registry };
}

async function main(): Promise<void> {
  const { app, config } = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
