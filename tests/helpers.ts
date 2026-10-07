import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export function testEnv(): void {
  const logDir = mkdtempSync(join(tmpdir(), 'mgw-logs-'));
  process.env.MCP_GW_ADMIN_TOKEN = 'test-admin-token';
  process.env.MCP_GW_LOG_DIR = logDir;
  process.env.MCP_GW_PORT = '0';
}

export function stdioSpec(script: string) {
  return {
    type: 'stdio' as const,
    command: 'node',
    args: [`demo-servers/${script}`],
    cwd: PROJECT_ROOT,
  };
}

export function rpcBody(method: string, params?: unknown, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

export function adminHeaders() {
  return { authorization: 'Bearer test-admin-token' };
}

/**
 * Minimal in-process SSE upstream speaking the endpoint/message pattern.
 * Tools: add(a, b) and hang (never responds, for timeout tests).
 */
export function startSseUpstream(): Promise<{ server: Server; url: string }> {
  const sseClients = new Set<ServerResponse>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/sse' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('event: endpoint\ndata: /messages\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.url === '/messages' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const msg = JSON.parse(body) as {
          id: number;
          method: string;
          params?: { name?: string; arguments?: { a: number; b: number } };
        };
        if (msg.method === 'tools/call' && msg.params?.name === 'hang') {
          res.writeHead(202).end(); // never responds: exercises timeouts
          return;
        }
        let payload: Record<string, unknown>;
        if (msg.method === 'initialize') {
          payload = {
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'sse-demo', version: '1.0.0' },
            },
          };
        } else if (msg.method === 'tools/list') {
          payload = {
            result: {
              tools: [
                { name: 'add', description: 'Add.', inputSchema: { type: 'object' } },
                { name: 'hang', description: 'Never responds.', inputSchema: { type: 'object' } },
              ],
            },
          };
        } else if (msg.method === 'tools/call') {
          const { a, b } = msg.params?.arguments ?? { a: 0, b: 0 };
          payload = { result: { content: [{ type: 'text', text: String(a + b) }] } };
        } else {
          payload = { result: {} };
        }
        const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload })}\n\n`;
        for (const client of sseClients) client.write(frame);
        res.writeHead(202).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/sse` });
    });
  });
}
