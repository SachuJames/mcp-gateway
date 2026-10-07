import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { adminHeaders, rpcBody, stdioSpec, testEnv } from './helpers.js';

testEnv();

interface TestContext {
  app: Awaited<ReturnType<typeof buildServer>>['app'];
  registry: Awaited<ReturnType<typeof buildServer>>['registry'];
  admin: Record<string, string>;
  calcId: string;
  notesId: string;
}

async function setup(): Promise<TestContext> {
  const { app, registry } = await buildServer();
  const admin = adminHeaders();

  const calcRes = await app.inject({
    method: 'POST',
    url: '/admin/servers',
    headers: admin,
    payload: { name: 'calc', transport: stdioSpec('calc.ts') },
  });
  expect(calcRes.statusCode).toBe(201);
  const notesRes = await app.inject({
    method: 'POST',
    url: '/admin/servers',
    headers: admin,
    payload: { name: 'notes', transport: stdioSpec('notes.ts') },
  });
  expect(notesRes.statusCode).toBe(201);

  return {
    app,
    registry,
    admin,
    calcId: (calcRes.json() as { server: { id: string } }).server.id,
    notesId: (notesRes.json() as { server: { id: string } }).server.id,
  };
}

async function createKey(
  ctx: TestContext,
  spec: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/admin/keys',
    headers: ctx.admin,
    payload: spec,
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { key: { id: string }; secret: string };
  return { id: body.key.id, secret: body.secret };
}

function mcp(ctx: TestContext, secret: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${secret}`, ...headers },
    payload: body,
  });
}

describe('gateway proxy', () => {
  const ctxs: TestContext[] = [];
  afterEach(async () => {
    await Promise.all(
      ctxs.splice(0).map(async (c) => {
        await c.app.close();
      }),
    );
  });

  it('answers initialize and ping', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['*'] });

    const init = await mcp(ctx, secret, rpcBody('initialize', {}));
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({
      jsonrpc: '2.0',
      result: { serverInfo: { name: 'mcp-gateway' } },
    });

    const ping = await mcp(ctx, secret, rpcBody('ping'));
    expect(ping.json()).toMatchObject({ result: {} });
  });

  it('lists qualified tools filtered by key scopes', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'calc-only', servers: ['calc'] });

    const res = await mcp(ctx, secret, rpcBody('tools/list'));
    const tools = (res.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('calc__add');
    expect(names.some((n) => n.startsWith('notes__'))).toBe(false);
  });

  it('routes a tool call to the right upstream', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['*'] });

    const res = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__add', arguments: { a: 40, b: 2 } }));
    expect(res.json()).toMatchObject({
      jsonrpc: '2.0',
      result: { content: [{ type: 'text', text: '42' }] },
    });

    const note = await mcp(
      ctx,
      secret,
      rpcBody('tools/call', { name: 'notes__note_set', arguments: { key: 'hello', value: 'world' } }),
    );
    expect(note.json()).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
  });

  it('rejects calls without a valid api key', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const res = await mcp(ctx, 'bogus-key', rpcBody('tools/call', { name: 'calc__add' }));
    expect(res.json()).toMatchObject({ error: { code: -32004 } });

    const noHeader = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: rpcBody('ping') });
    expect(noHeader.json()).toMatchObject({ error: { code: -32004 } });
  });

  it('denies tools outside the key scope', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'calc-only', servers: ['calc'] });

    const res = await mcp(
      ctx,
      secret,
      rpcBody('tools/call', { name: 'notes__note_get', arguments: { key: 'hello' } }),
    );
    expect(res.json()).toMatchObject({ error: { code: -32005 } });
  });

  it('denies tools outside a tool-level allowlist', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'add-only', servers: ['calc'], tools: ['calc__add'] });

    const ok = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__add', arguments: { a: 1, b: 1 } }));
    expect(ok.json()).not.toHaveProperty('error');

    const denied = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__multiply', arguments: { a: 2, b: 3 } }));
    expect(denied.json()).toMatchObject({ error: { code: -32005 } });
  });

  it('rate limits a key with a tiny bucket', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, {
      name: 'limited',
      servers: ['calc'],
      rateLimit: { capacity: 2, refillPerSecond: 0.001 },
    });

    const bodies = [1, 2, 3].map((id) =>
      rpcBody('tools/call', { name: 'calc__add', arguments: { a: id, b: 0 } }, id),
    );
    const results = [];
    for (const body of bodies) {
      results.push(await mcp(ctx, secret, body));
    }
    expect(results[0].json()).not.toHaveProperty('error');
    expect(results[1].json()).not.toHaveProperty('error');
    expect(results[2].json()).toMatchObject({ error: { code: -32003, message: /rate limit/ } });
  });

  it('rejects oversized arguments via guardrails', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['calc'] });

    const big = 'x'.repeat(70000);
    const res = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__now', arguments: { junk: big } }));
    expect(res.json()).toMatchObject({ error: { code: -32006 } });
  });

  it('returns invalid params for malformed tool names', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['*'] });

    const res = await mcp(ctx, secret, rpcBody('tools/call', { name: 'notqualified', arguments: {} }));
    expect(res.json()).toMatchObject({ error: { code: -32602 } });

    const unknown = await mcp(ctx, secret, rpcBody('tools/call', { name: 'ghost__tool', arguments: {} }));
    expect(unknown.json()).toMatchObject({ error: { code: -32602 } });
  });

  it('propagates upstream tool errors', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['calc'] });

    const res = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__divide', arguments: { a: 1, b: 0 } }));
    expect(res.json()).toMatchObject({ error: { message: /division by zero/ } });
  });

  it('returns method not found for unknown methods and 202 for notifications', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['*'] });

    const res = await mcp(ctx, secret, rpcBody('resources/list'));
    expect(res.json()).toMatchObject({ error: { code: -32601 } });

    const notif = await mcp(ctx, secret, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notif.statusCode).toBe(202);
  });

  it('rejects non json-rpc bodies', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['*'] });

    const res = await mcp(ctx, secret, { hello: 'world' });
    expect(res.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('records audit entries and stats for calls', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['calc'] });

    await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__add', arguments: { a: 1, b: 2 } }));
    await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__divide', arguments: { a: 1, b: 0 } }));

    const logs = await ctx.app.inject({ method: 'GET', url: '/admin/logs?limit=10', headers: ctx.admin });
    const entries = (logs.json() as { logs: Array<{ tool: string; ok: boolean; latencyMs: number }> }).logs;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]).toHaveProperty('latencyMs');
    expect(entries.some((e) => e.tool === 'calc__add' && e.ok)).toBe(true);
    expect(entries.some((e) => e.tool === 'calc__divide' && !e.ok)).toBe(true);

    const stats = await ctx.app.inject({ method: 'GET', url: '/admin/stats', headers: ctx.admin });
    const snap = stats.json() as { totalCalls: number; perTool: Record<string, { calls: number }> };
    expect(snap.totalCalls).toBeGreaterThanOrEqual(2);
    expect(snap.perTool['calc__add'].calls).toBeGreaterThanOrEqual(1);
  });

  it('propagates upstream transport failure as an unavailable error', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const { secret } = await createKey(ctx, { name: 'k1', servers: ['calc'] });

    const ok = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__add', arguments: { a: 1, b: 1 } }));
    expect(ok.json()).not.toHaveProperty('error');

    await ctx.registry.clientFor(ctx.calcId)?.close();

    const res = await mcp(ctx, secret, rpcBody('tools/call', { name: 'calc__add', arguments: { a: 1, b: 1 } }));
    expect(res.json()).toMatchObject({ error: { code: -32002 } });
  });

  it('requires the admin token for admin routes', async () => {
    const ctx = await setup();
    ctxs.push(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/servers' });
    expect(res.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'GET',
      url: '/admin/servers',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.statusCode).toBe(401);
  });
});
