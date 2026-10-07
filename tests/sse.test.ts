import { createServer, Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient } from '../src/mcp-client.js';
import { SseTransport } from '../src/transports/sse.js';
import { startSseUpstream, testEnv } from './helpers.js';

testEnv();

describe('mcp client over sse', () => {
  const servers: Server[] = [];
  const clients: McpClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('connects via the endpoint event and calls a tool', async () => {
    const { server, url } = await startSseUpstream();
    servers.push(server);
    const client = new McpClient(new SseTransport({ url }), 5000);
    clients.push(client);
    const init = await client.connect();
    expect(init.serverInfo.name).toBe('sse-demo');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'hang']);
    const result = await client.callTool('add', { a: 3, b: 4 });
    expect(result.content[0]).toMatchObject({ type: 'text', text: '7' });
  });

  it('fails to connect when no endpoint event arrives', async () => {
    const dead = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      setTimeout(() => res.end(), 100).unref();
    });
    servers.push(dead);
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const addr = dead.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const client = new McpClient(new SseTransport({ url: `http://127.0.0.1:${port}/sse` }), 5000);
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/endpoint/);
  });
});
