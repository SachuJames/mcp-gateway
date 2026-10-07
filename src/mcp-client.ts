import { EventEmitter } from 'node:events';
import {
  ErrorCodes,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  McpInitializeParams,
  McpInitializeResult,
  McpTool,
  McpToolCallResult,
  errorResponse,
  isNotification,
  isResponse,
} from './jsonrpc.js';

export interface McpTransportLike {
  send(msg: JsonRpcMessage): void | Promise<void>;
  on(event: 'message', cb: (msg: JsonRpcMessage) => void): this;
  on(event: 'exit' | 'close' | 'error', cb: (err?: unknown) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class McpTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`upstream timed out after ${timeoutMs}ms on ${method}`);
    this.name = 'McpTimeoutError';
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Speaks MCP to one upstream server: initialize handshake, tools/list,
 * tools/call, with per-request timeouts and id tracking. Transport
 * agnostic: works over stdio or SSE.
 */
export class McpClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<string | number, PendingCall>();
  private closed = false;

  constructor(
    private readonly transport: McpTransportLike,
    private readonly defaultTimeoutMs: number,
  ) {
    super();
  }

  async connect(clientName = 'mcp-gateway'): Promise<McpInitializeResult> {
    this.transport.on('message', (msg) => this.onMessage(msg));
    this.transport.on('exit', (err) => this.onTransportDown(err));
    this.transport.on('close', () => this.onTransportDown(new Error('transport closed')));
    await this.transport.start();

    const params: McpInitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    };
    const result = (await this.request('initialize', params)) as McpInitializeResult;
    const notify: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    await this.transport.send(notify);
    return result;
  }

  async listTools(timeoutMs?: number): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {}, timeoutMs)) as { tools: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<McpToolCallResult> {
    return (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as McpToolCallResult;
  }

  async ping(timeoutMs?: number): Promise<void> {
    await this.request('ping', {}, timeoutMs);
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('client is closed'));
    }
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(method, effectiveTimeout));
      }, effectiveTimeout);
      // Don't let a hung upstream keep the gateway process alive.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.transport.send(req)).catch((err: Error) => {
        const call = this.pending.get(id);
        if (call) {
          this.pending.delete(id);
          clearTimeout(call.timer);
          call.reject(err);
        }
      });
    });
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (isNotification(msg)) {
      this.emit('notification', msg);
      return;
    }
    if (!isResponse(msg)) return;
    if (msg.id === null) return;
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.error) {
      const err = new Error(msg.error.message) as Error & { code?: number; data?: unknown };
      err.code = msg.error.code;
      err.data = msg.error.data;
      call.reject(err);
    } else {
      call.resolve(msg.result);
    }
  }

  private onTransportDown(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const failure = err instanceof Error ? err : new Error('upstream transport went down');
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(failure);
    }
    this.emit('down', failure);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(new Error('client closed'));
    }
    await this.transport.stop().catch(() => undefined);
  }

  /** Build a JSON-RPC error response for a failed proxied call. */
  static toErrorResponse(
    id: string | number | null,
    err: unknown,
  ): JsonRpcResponse {
    if (err instanceof McpTimeoutError) {
      return errorResponse(id, ErrorCodes.UpstreamTimeout, err.message);
    }
    const withCode = err as { code?: number; message?: string } | null;
    if (typeof withCode?.code === 'number') {
      return errorResponse(id, withCode.code, withCode.message ?? 'upstream error');
    }
    return errorResponse(id, ErrorCodes.UpstreamUnavailable, err instanceof Error ? err.message : 'upstream error');
  }
}

export { errorResponse };
