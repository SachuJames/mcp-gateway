import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, McpTimeoutError } from '../src/mcp-client.js';
import { StdioTransport } from '../src/transports/stdio.js';
import { stdioSpec, testEnv } from './helpers.js';

testEnv();

describe('mcp client over stdio', () => {
  const clients: McpClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('completes the initialize handshake and lists tools', async () => {
    const spec = stdioSpec('calc.ts');
    const client = new McpClient(new StdioTransport(spec), 5000);
    clients.push(client);
    const init = await client.connect();
    expect(init.serverInfo.name).toBe('calc-server');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'divide', 'multiply', 'now', 'subtract']);
  });

  it('calls a tool and returns its result', async () => {
    const client = new McpClient(new StdioTransport(stdioSpec('calc.ts')), 5000);
    clients.push(client);
    await client.connect();
    const result = await client.callTool('add', { a: 20, b: 22 });
    expect(result.content[0]).toMatchObject({ type: 'text', text: '42' });
  });

  it('surfaces upstream tool errors', async () => {
    const client = new McpClient(new StdioTransport(stdioSpec('calc.ts')), 5000);
    clients.push(client);
    await client.connect();
    await expect(client.callTool('divide', { a: 1, b: 0 })).rejects.toThrow(/division by zero/);
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool/);
  });

  it('rejects pending calls when the transport dies', async () => {
    const transport = new StdioTransport(stdioSpec('calc.ts'));
    const client = new McpClient(transport, 5000);
    clients.push(client);
    await client.connect();
    await transport.stop();
    await expect(client.callTool('add', { a: 1, b: 1 })).rejects.toThrow();
  });

  it('times out a call that never answers', async () => {
    const hanging = {
      send() {},
      on() { return this; },
      async start() {},
      async stop() {},
    };
    const client = new McpClient(hanging as never, 50);
    clients.push(client);
    await expect(client.callTool('add', { a: 1, b: 1 }, 50)).rejects.toBeInstanceOf(McpTimeoutError);
  });
});
