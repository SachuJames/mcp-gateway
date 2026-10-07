/**
 * Minimal helper for writing stdio MCP servers: newline-delimited
 * JSON-RPC on stdin/stdout, the same framing the gateway speaks.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

interface RpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export class McpStdioServer {
  private buffer = '';
  private readonly name: string;
  private readonly version: string;
  private readonly tools: ToolDefinition[];

  constructor(name: string, version: string, tools: ToolDefinition[]) {
    this.name = name;
    this.version = version;
    this.tools = tools;
  }

  run(): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private send(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  private handleLine(line: string): void {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (req.method && req.id === undefined) return; // notification, nothing to answer
    const id = req.id ?? null;
    try {
      if (req.method === 'initialize') {
        this.send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          },
        });
      } else if (req.method === 'tools/list') {
        this.send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
      } else if (req.method === 'tools/call') {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const tool = this.tools.find((t) => t.name === params.name);
        if (!tool) {
          this.send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
          return;
        }
        const output = tool.handler(params.arguments ?? {});
        this.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(output) }] } });
      } else if (req.method === 'ping') {
        this.send({ jsonrpc: '2.0', id, result: {} });
      } else {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
    } catch (err) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
      });
    }
  }
}
