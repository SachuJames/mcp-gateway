import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { adminHeaders, rpcBody, startSseUpstream } from './helpers.js';

process.env.MCP_GW_ADMIN_TOKEN = 'test-admin-token';
process.env.MCP_GW_LOG_DIR = mkdtempSync(join(tmpdir(), 'mgw-logs-'));
process.env.MCP_GW_CALL_TIMEOUT_MS = '400';

describe('gateway timeout handling', () => {
  const apps: Array<Awaited<ReturnType<typeof buildServer>>['app']> = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('times out a tool call that exceeds the gateway timeout', async () => {
    const { server, url } = await startSseUpstream();
    servers.push(server);

    const { app } = await buildServer();
    apps.push(app);
    const admin = adminHeaders();
    const reg = await app.inject({
      method: 'POST',
      url: '/admin/servers',
      headers: admin,
      payload: { name: 'sse', transport: { type: 'sse', url } },
    });
    expect(reg.statusCode).toBe(201);
    const keyRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: admin,
      payload: { name: 'k', servers: ['sse'] },
    });
    const { secret } = keyRes.json() as { secret: string };

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${secret}` },
      payload: rpcBody('tools/call', { name: 'sse__hang', arguments: {} }),
    });
    expect(res.json()).toMatchObject({ error: { code: -32001 } });
  }, 15000);

  it('surfaces register failure for an unreachable sse upstream', async () => {
    const { app } = await buildServer();
    apps.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/servers',
      headers: adminHeaders(),
      payload: { name: 'dead', transport: { type: 'sse', url: 'http://127.0.0.1:1/sse' } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty('error');
  }, 15000);
});
