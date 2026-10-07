/**
 * JSON-RPC 2.0 framing plus the subset of the Model Context Protocol
 * messages the gateway speaks. The gateway hand-rolls this framing so it
 * stays transport-agnostic (stdio newline-delimited, SSE, plain HTTP POST).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !('method' in msg);
}

export function encodeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

export function parseMessage(line: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new JsonRpcParseError('message is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new JsonRpcParseError('message must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['jsonrpc'] !== '2.0') {
    throw new JsonRpcParseError('message must carry jsonrpc "2.0"');
  }
  if (typeof obj['method'] === 'string') {
    if ('id' in obj) {
      return obj as unknown as JsonRpcRequest;
    }
    return obj as unknown as JsonRpcNotification;
  }
  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    return obj as unknown as JsonRpcResponse;
  }
  throw new JsonRpcParseError('message is neither a request, notification, nor response');
}

/** Standard JSON-RPC error codes plus the gateway's own range. */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerErrorStart: -32099,
  UpstreamTimeout: -32001,
  UpstreamUnavailable: -32002,
  RateLimited: -32003,
  Unauthorized: -32004,
  Forbidden: -32005,
  GuardrailViolation: -32006,
} as const;

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/* ------------------------------------------------------------------ */
/* MCP method payloads                                                 */
/* ------------------------------------------------------------------ */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: McpClientCapabilities;
  clientInfo: { name: string; version: string };
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version: string };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}
