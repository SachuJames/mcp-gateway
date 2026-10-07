import { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiKey, KeyStore } from './auth.js';
import { AuditLog, Stats } from './audit.js';
import { GatewayConfig } from './config.js';
import { checkCallGuardrails, checkOutputGuardrail } from './guardrails.js';
import {
  ErrorCodes,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  McpTool,
  errorResponse,
  isNotification,
  isRequest,
  parseMessage,
} from './jsonrpc.js';
import { McpClient, McpTimeoutError } from './mcp-client.js';
import { RateLimiter } from './ratelimit.js';
import { ServerRegistry, qualifyTool, splitQualifiedTool } from './registry.js';

export interface GatewayDeps {
  registry: ServerRegistry;
  keys: KeyStore;
  limiter: RateLimiter;
  audit: AuditLog;
  stats: Stats;
  config: GatewayConfig;
}

const GATEWAY_VERSION = '0.1.0';

function extractSecret(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return apiKey;
  return '';
}

function unauthorized(id: string | number | null): JsonRpcResponse {
  return errorResponse(id, ErrorCodes.Unauthorized, 'missing or invalid API key');
}

function toolResultText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  const texts = (r.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
  return texts.join('\n');
}

export async function registerGatewayRoutes(app: FastifyInstance, deps: GatewayDeps): Promise<void> {
  app.post('/mcp', async (req, reply) => {
    let msg: JsonRpcMessage;
    try {
      msg = parseMessage(JSON.stringify(req.body ?? null));
    } catch {
      return reply.send(errorResponse(null, ErrorCodes.InvalidRequest, 'body must be a JSON-RPC 2.0 message'));
    }
    if (Array.isArray(req.body)) {
      return reply.send(errorResponse(null, ErrorCodes.InvalidRequest, 'batch requests are not supported'));
    }

    const secret = extractSecret(req);
    const key = deps.keys.verify(secret);
    const id = isRequest(msg) ? msg.id : null;
    if (!key) {
      return reply.send(unauthorized(id));
    }

    // Notifications get no response body.
    if (isNotification(msg)) {
      return reply.status(202).send();
    }
    if (!isRequest(msg)) {
      return reply.send(errorResponse(null, ErrorCodes.InvalidRequest, 'expected a JSON-RPC request'));
    }

    const rl = deps.limiter.check(key.id, key.rateLimit);
    if (!rl.allowed) {
      reply.header('x-ratelimit-remaining', '0');
      return reply.send(errorResponse(id, ErrorCodes.RateLimited, 'rate limit exceeded'));
    }
    reply.header('x-ratelimit-remaining', String(rl.remaining));

    switch (msg.method) {
      case 'initialize':
        return reply.send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'mcp-gateway', version: GATEWAY_VERSION },
          },
        });
      case 'ping':
        return reply.send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return reply.send({ jsonrpc: '2.0', id, result: { tools: listToolsFor(key, deps) } });
      case 'tools/call':
        return reply.send(await handleToolCall(id, msg, key, deps));
      default:
        return reply.send(errorResponse(id, ErrorCodes.MethodNotFound, `method not found: ${msg.method}`));
    }
  });
}

function listToolsFor(key: ApiKey, deps: GatewayDeps): McpTool[] {
  const out: McpTool[] = [];
  for (const server of deps.registry.list()) {
    if (server.status !== 'online') continue;
    if (!deps.keys.canSeeServer(key, server.name)) continue;
    for (const tool of server.tools) {
      const qualified = qualifyTool(server.name, tool.name);
      if (!deps.keys.canAccess(key, server.name, qualified)) continue;
      out.push({ ...tool, name: qualified });
    }
  }
  return out;
}

async function handleToolCall(
  id: string | number | null,
  msg: JsonRpcRequest,
  key: ApiKey,
  deps: GatewayDeps,
): Promise<JsonRpcResponse> {
  const started = Date.now();
  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
  const qualified = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const fail = (server: string, err: unknown): JsonRpcResponse => {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const entry = {
      ts: new Date().toISOString(),
      keyId: key.id,
      keyName: key.name,
      server,
      tool: qualified,
      latencyMs,
      ok: false,
      error: message,
      argsBytes: Buffer.byteLength(JSON.stringify(args), 'utf8'),
      outputBytes: 0,
    };
    deps.audit.record(entry);
    deps.stats.record(entry);
    return McpClient.toErrorResponse(id, err);
  };

  const split = splitQualifiedTool(qualified);
  if (!split) {
    return fail('', { code: ErrorCodes.InvalidParams, message: `malformed tool name: ${qualified}` } as Error & { code: number });
  }
  const server = deps.registry.getByName(split.serverName);
  if (!server || server.status !== 'online') {
    return fail(split.serverName, { code: ErrorCodes.InvalidParams, message: `unknown tool: ${qualified}` } as Error & { code: number });
  }
  if (!deps.keys.canAccess(key, server.name, qualified)) {
    return fail(server.name, errorCoded(ErrorCodes.Forbidden, `key may not call ${qualified}`));
  }

  try {
    checkCallGuardrails(qualified, args, {
      maxArgsBytes: deps.config.maxArgsBytes,
      maxOutputBytes: deps.config.maxOutputBytes,
    });
  } catch (err) {
    return fail(server.name, err);
  }

  const client = deps.registry.clientFor(server.id);
  if (!client) {
    return fail(server.name, new Error('upstream client not available'));
  }

  const argsBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
  try {
    const result = await client.callTool(split.toolName, args, deps.config.defaultCallTimeoutMs);
    const text = toolResultText(result);
    checkOutputGuardrail(text, deps.config.maxOutputBytes);
    const latencyMs = Date.now() - started;
    const entry = {
      ts: new Date().toISOString(),
      keyId: key.id,
      keyName: key.name,
      server: server.name,
      tool: qualified,
      latencyMs,
      ok: true,
      argsBytes,
      outputBytes: Buffer.byteLength(text, 'utf8'),
    };
    deps.audit.record(entry);
    deps.stats.record(entry);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err instanceof McpTimeoutError) {
      return fail(server.name, err);
    }
    return fail(server.name, err);
  }
}

function errorCoded(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}
