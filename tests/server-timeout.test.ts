import { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { ServerRegistry } from '../src/registry.js';
import { adminHeaders, rpcBody, startSseUpstream, stdioSpec, testEnv } from './helpers.js';

testEnv();
// Gateway-wide default stays generous here; the per-server value has to win.
process.env.MCP_GW_CALL_TIMEOUT_MS = '30000';

describe('per-server call timeout', () => {
  const apps: Array<Awaited<ReturnType<typeof buildServer>>['app']> = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  async function setupUpstream(timeoutMs?: number) {
    const { server, url } = await startSseUpstream();
    servers.push(server);
    const { app } = await buildServer();
    apps.push(app);
    const admin = adminHeaders();
    const reg = await app.inject({
      method: 'POST',
      url: '/admin/servers',
      headers: admin,
      payload: { name: 'sse', transport: { type: 'sse', url }, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    });
    expect(reg.statusCode).toBe(201);
    const keyRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: admin,
      payload: { name: 'k', servers: ['sse'] },
    });
    const { secret } = keyRes.json() as { secret: string };
    return { app, admin, secret };
  }

  function call(app: Awaited<ReturnType<typeof buildServer>>['app'], secret: string, name: string, args: unknown = {}) {
    return app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${secret}` },
      payload: rpcBody('tools/call', { name, arguments: args }),
    });
  }

  it('times out at the per-server limit, well under the gateway default', async () => {
    const { secret, app } = await setupUpstream(200);
    const started = Date.now();
    const res = await call(app, secret, 'sse__hang');
    expect(res.json()).toMatchObject({ error: { code: -32001 } });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it('keeps the shared upstream usable after a timeout', async () => {
    const { secret, app } = await setupUpstream(200);
    const hung = await call(app, secret, 'sse__hang');
    expect(hung.json()).toMatchObject({ error: { code: -32001 } });

    const res = await call(app, secret, 'sse__add', { a: 40, b: 2 });
    expect(res.json()).toMatchObject({ result: { content: [{ type: 'text', text: '42' }] } });
  }, 15000);

  it('audits a timeout as its own outcome, apart from other errors', async () => {
    const { secret, app, admin } = await setupUpstream(200);
    await call(app, secret, 'sse__hang');
    await call(app, secret, 'sse__add', { a: 1, b: 1 });

    const logs = await app.inject({ method: 'GET', url: '/admin/logs?limit=10', headers: admin });
    const entries = (logs.json() as { logs: Array<{ tool: string; ok: boolean; outcome: string }> }).logs;
    const hang = entries.find((e) => e.tool === 'sse__hang');
    expect(hang).toMatchObject({ ok: false, outcome: 'timeout' });
    const add = entries.find((e) => e.tool === 'sse__add');
    expect(add).toMatchObject({ ok: true, outcome: 'ok' });
  }, 15000);

  it('shows the registered timeout on the server record', async () => {
    const { app, admin } = await setupUpstream(1234);
    const res = await app.inject({ method: 'GET', url: '/admin/servers', headers: admin });
    const list = (res.json() as { servers: Array<{ name: string; timeoutMs?: number }> }).servers;
    expect(list.find((s) => s.name === 'sse')?.timeoutMs).toBe(1234);
  }, 15000);

  it('falls back to the gateway default when no per-server timeout is set', async () => {
    const { secret, app } = await setupUpstream();
    const res = await call(app, secret, 'sse__add', { a: 2, b: 3 });
    expect(res.json()).toMatchObject({ result: { content: [{ type: 'text', text: '5' }] } });
  }, 15000);

  it('rejects timeout values that are not a sane millisecond count', async () => {
    const registry = new ServerRegistry(5000);
    const badValues = [0, -100, 12.5, 600_001];
    for (const [i, timeoutMs] of badValues.entries()) {
      await expect(
        registry.register({ name: `bad${i}`, transport: stdioSpec('calc.ts'), timeoutMs }),
      ).rejects.toThrow(/timeoutMs/);
    }
    await registry.shutdown();
  });
});
