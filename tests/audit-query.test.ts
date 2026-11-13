import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { adminHeaders, rpcBody, stdioSpec, testEnv } from './helpers.js';

testEnv();

interface LogEntry {
  ts: string;
  keyId: string;
  tool: string;
  ok: boolean;
  outcome: string;
}

interface LogsBody {
  logs: LogEntry[];
  total: number;
  limit: number;
  offset: number;
}

describe('admin audit log query', () => {
  const apps: Array<Awaited<ReturnType<typeof buildServer>>['app']> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  // Two keys make three calls between them: two good adds, one divide by zero.
  async function setup() {
    const { app } = await buildServer();
    apps.push(app);
    const admin = adminHeaders();
    const reg = await app.inject({
      method: 'POST',
      url: '/admin/servers',
      headers: admin,
      payload: { name: 'calc', transport: stdioSpec('calc.ts') },
    });
    expect(reg.statusCode).toBe(201);

    async function makeKey(name: string): Promise<{ id: string; secret: string }> {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/keys',
        headers: admin,
        payload: { name, servers: ['calc'] },
      });
      const body = res.json() as { key: { id: string }; secret: string };
      return { id: body.key.id, secret: body.secret };
    }
    const k1 = await makeKey('k1');
    const k2 = await makeKey('k2');

    async function call(secret: string, name: string, args: unknown) {
      return app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${secret}` },
        payload: rpcBody('tools/call', { name, arguments: args }),
      });
    }
    await call(k1.secret, 'calc__add', { a: 1, b: 2 });
    await call(k1.secret, 'calc__divide', { a: 1, b: 0 });
    await call(k2.secret, 'calc__add', { a: 5, b: 5 });

    async function logs(query: string): Promise<LogsBody> {
      const res = await app.inject({ method: 'GET', url: `/admin/logs${query}`, headers: admin });
      expect(res.statusCode).toBe(200);
      return res.json() as LogsBody;
    }
    return { app, admin, k1, k2, logs };
  }

  it('returns everything newest first when no filters are given', async () => {
    const { logs, k2 } = await setup();
    const body = await logs('');
    expect(body.total).toBe(3);
    expect(body.logs).toHaveLength(3);
    expect(body.logs[0]).toMatchObject({ keyId: k2.id, tool: 'calc__add' });
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it('filters by api key', async () => {
    const { logs, k1 } = await setup();
    const body = await logs(`?keyId=${k1.id}`);
    expect(body.total).toBe(2);
    expect(body.logs.every((e) => e.keyId === k1.id)).toBe(true);
  });

  it('filters by tool name', async () => {
    const { logs } = await setup();
    const body = await logs('?tool=calc__divide');
    expect(body.total).toBe(1);
    expect(body.logs[0]).toMatchObject({ tool: 'calc__divide', ok: false });
  });

  it('filters by outcome', async () => {
    const { logs } = await setup();
    const ok = await logs('?outcome=ok');
    expect(ok.total).toBe(2);
    expect(ok.logs.every((e) => e.outcome === 'ok')).toBe(true);

    const errors = await logs('?outcome=error');
    expect(errors.total).toBe(1);
    expect(errors.logs[0]).toMatchObject({ tool: 'calc__divide', outcome: 'error' });

    const timeouts = await logs('?outcome=timeout');
    expect(timeouts.total).toBe(0);
  });

  it('filters by time range', async () => {
    const { logs } = await setup();
    expect((await logs('?since=2000-01-01T00:00:00.000Z')).total).toBe(3);
    expect((await logs('?until=2000-01-01T00:00:00.000Z')).total).toBe(0);
    expect((await logs('?since=2999-01-01T00:00:00.000Z')).total).toBe(0);
  });

  it('paginates with limit and offset over the filtered set', async () => {
    const { logs } = await setup();
    const page1 = await logs('?limit=2&offset=0');
    expect(page1.logs).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await logs('?limit=2&offset=2');
    expect(page2.logs).toHaveLength(1);
    expect(page2.total).toBe(3);
    const page1Keys = page1.logs.map((e) => `${e.keyId}:${e.tool}`);
    expect(page1Keys).not.toContain(`${page2.logs[0].keyId}:${page2.logs[0].tool}`);

    const past = await logs('?limit=10&offset=99');
    expect(past.logs).toHaveLength(0);
    expect(past.total).toBe(3);
  });

  it('rejects an unknown outcome and a malformed timestamp', async () => {
    const { app, admin } = await setup();
    const badOutcome = await app.inject({ method: 'GET', url: '/admin/logs?outcome=sideways', headers: admin });
    expect(badOutcome.statusCode).toBe(400);
    const badSince = await app.inject({ method: 'GET', url: '/admin/logs?since=last-tuesday', headers: admin });
    expect(badSince.statusCode).toBe(400);
  });

  it('still requires the admin token', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/admin/logs?outcome=ok' });
    expect(res.statusCode).toBe(401);
  });
});
