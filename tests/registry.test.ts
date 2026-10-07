import { afterEach, describe, expect, it } from 'vitest';
import { ServerRegistry, qualifyTool, splitQualifiedTool } from '../src/registry.js';
import { stdioSpec, testEnv } from './helpers.js';

testEnv();

describe('server registry', () => {
  const registries: ServerRegistry[] = [];
  afterEach(async () => {
    await Promise.all(registries.splice(0).map((r) => r.shutdown()));
  });

  it('registers a stdio server and caches its tools', async () => {
    const registry = new ServerRegistry(5000);
    registries.push(registry);
    const server = await registry.register({ name: 'calc', transport: stdioSpec('calc.ts') });
    expect(server.status).toBe('online');
    expect(server.serverInfo?.name).toBe('calc-server');
    expect(server.tools.map((t) => t.name)).toContain('add');
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate server names', async () => {
    const registry = new ServerRegistry(5000);
    registries.push(registry);
    await registry.register({ name: 'calc', transport: stdioSpec('calc.ts') });
    await expect(registry.register({ name: 'calc', transport: stdioSpec('notes.ts') })).rejects.toThrow(
      /already registered/,
    );
  });

  it('rejects invalid server names', async () => {
    const registry = new ServerRegistry(5000);
    registries.push(registry);
    await expect(
      registry.register({ name: 'bad name!', transport: stdioSpec('calc.ts') }),
    ).rejects.toThrow(/1-64 chars/);
  });

  it('marks a failed registration as error and surfaces the cause', async () => {
    const registry = new ServerRegistry(5000);
    registries.push(registry);
    await expect(
      registry.register({ name: 'dead', transport: { type: 'stdio', command: '/nonexistent/binary' } }),
    ).rejects.toThrow();
    const record = registry.getByName('dead');
    expect(record?.status).toBe('error');
    expect(record?.lastError).toBeTruthy();
  });

  it('unregisters and stops the upstream process', async () => {
    const registry = new ServerRegistry(5000);
    registries.push(registry);
    const server = await registry.register({ name: 'notes', transport: stdioSpec('notes.ts') });
    expect(await registry.unregister(server.id)).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(await registry.unregister(server.id)).toBe(false);
  });

  it('qualifies and splits tool names', () => {
    expect(qualifyTool('calc', 'add')).toBe('calc__add');
    expect(splitQualifiedTool('calc__add')).toEqual({ serverName: 'calc', toolName: 'add' });
    expect(splitQualifiedTool('no-separator')).toBeNull();
    expect(splitQualifiedTool('__add')).toBeNull();
    expect(splitQualifiedTool('calc__')).toBeNull();
  });
});
