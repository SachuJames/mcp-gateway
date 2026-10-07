import { McpClient } from './mcp-client.js';
import { McpTool } from './jsonrpc.js';
import { SseTransport } from './transports/sse.js';
import { StdioTransport } from './transports/stdio.js';

export type ServerTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

export interface RegisterServerSpec {
  id?: string;
  /** Short prefix used to qualify tool names, e.g. "calc" -> "calc__add". */
  name: string;
  transport: ServerTransportConfig;
}

export type ServerStatus = 'connecting' | 'online' | 'offline' | 'error';

export interface RegisteredServer {
  id: string;
  name: string;
  transport: ServerTransportConfig;
  status: ServerStatus;
  serverInfo?: { name: string; version: string };
  tools: McpTool[];
  lastError?: string;
  connectedAt?: string;
}

export const TOOL_SEPARATOR = '__';

export function qualifyTool(serverName: string, toolName: string): string {
  return `${serverName}${TOOL_SEPARATOR}${toolName}`;
}

export function splitQualifiedTool(qualified: string): { serverName: string; toolName: string } | null {
  const idx = qualified.indexOf(TOOL_SEPARATOR);
  if (idx <= 0 || idx + TOOL_SEPARATOR.length >= qualified.length) return null;
  return {
    serverName: qualified.slice(0, idx),
    toolName: qualified.slice(idx + TOOL_SEPARATOR.length),
  };
}

function slug(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Owns upstream MCP server lifecycles: connect on register, run the
 * initialize handshake, cache the tool catalog, and hand out the client
 * for proxied calls. One shared connection per server, multiplexed
 * across gateway clients.
 */
export class ServerRegistry {
  private servers = new Map<string, RegisteredServer>();
  private clients = new Map<string, McpClient>();

  constructor(private readonly defaultTimeoutMs: number) {}

  async register(spec: RegisterServerSpec): Promise<RegisteredServer> {
    const id = spec.id ?? `srv_${slug()}`;
    if (this.servers.has(id)) {
      throw new Error(`server id already registered: ${id}`);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)) {
      throw new Error('server name must be 1-64 chars of [a-zA-Z0-9_-]');
    }
    for (const existing of this.servers.values()) {
      if (existing.name === spec.name) {
        throw new Error(`server name already registered: ${spec.name}`);
      }
    }

    const record: RegisteredServer = {
      id,
      name: spec.name,
      transport: spec.transport,
      status: 'connecting',
      tools: [],
    };
    this.servers.set(id, record);

    try {
      const transport =
        spec.transport.type === 'stdio'
          ? new StdioTransport({
              command: spec.transport.command,
              args: spec.transport.args,
              env: spec.transport.env,
              cwd: spec.transport.cwd,
            })
          : new SseTransport({ url: spec.transport.url, headers: spec.transport.headers });

      const client = new McpClient(transport, this.defaultTimeoutMs);
      client.on('down', () => {
        record.status = 'offline';
      });
      const init = await client.connect();
      const tools = await client.listTools();
      record.status = 'online';
      record.serverInfo = init.serverInfo;
      record.tools = tools;
      record.connectedAt = new Date().toISOString();
      this.clients.set(id, client);
      return record;
    } catch (err) {
      record.status = 'error';
      record.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async unregister(id: string): Promise<boolean> {
    const record = this.servers.get(id);
    if (!record) return false;
    const client = this.clients.get(id);
    this.clients.delete(id);
    this.servers.delete(id);
    if (client) await client.close();
    record.status = 'offline';
    return true;
  }

  get(id: string): RegisteredServer | undefined {
    return this.servers.get(id);
  }

  getByName(name: string): RegisteredServer | undefined {
    for (const s of this.servers.values()) {
      if (s.name === name) return s;
    }
    return undefined;
  }

  list(): RegisteredServer[] {
    return [...this.servers.values()];
  }

  clientFor(id: string): McpClient | undefined {
    return this.clients.get(id);
  }

  async refreshTools(id: string): Promise<McpTool[]> {
    const record = this.servers.get(id);
    const client = this.clients.get(id);
    if (!record || !client) throw new Error(`unknown server: ${id}`);
    const tools = await client.listTools();
    record.tools = tools;
    return tools;
  }

  async shutdown(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.close();
    }
    this.clients.clear();
    this.servers.clear();
  }
}
