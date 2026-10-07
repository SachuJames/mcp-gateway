import Fastify from 'fastify';
import { loadConfig } from './config.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok', service: 'mcp-gateway' }));

  return { app, config };
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
