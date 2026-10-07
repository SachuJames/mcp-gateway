export interface ServerInfo {
  id: string;
  name: string;
  status: string;
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string; description?: string }>;
  lastError?: string;
  connectedAt?: string;
}

export interface ToolEntry {
  server: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  servers: string[];
  tools?: string[];
  createdAt: string;
}

export interface LogEntry {
  ts: string;
  keyId: string;
  keyName: string;
  server: string;
  tool: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export interface StatsSnapshot {
  totalCalls: number;
  totalErrors: number;
  perTool: Record<string, { calls: number; errors: number; avgLatencyMs: number }>;
  perTenant: Record<string, { calls: number; errors: number }>;
  perServer: Record<string, { calls: number; errors: number }>;
}

let adminToken = localStorage.getItem('mgw-admin-token') ?? '';

export function getToken(): string {
  return adminToken;
}

export function setToken(t: string): void {
  adminToken = t;
  localStorage.setItem('mgw-admin-token', t);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  servers: () => req<{ servers: ServerInfo[] }>('/admin/servers').then((r) => r.servers),
  registerServer: (name: string, transport: unknown) =>
    req('/admin/servers', { method: 'POST', body: JSON.stringify({ name, transport }) }),
  removeServer: (id: string) => req(`/admin/servers/${id}`, { method: 'DELETE' }),
  tools: () => req<{ tools: ToolEntry[] }>('/admin/tools').then((r) => r.tools),
  keys: () => req<{ keys: ApiKeyInfo[] }>('/admin/keys').then((r) => r.keys),
  createKey: (spec: { name: string; servers: string[]; tools?: string[] }) =>
    req<{ key: ApiKeyInfo; secret: string }>('/admin/keys', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  revokeKey: (id: string) => req(`/admin/keys/${id}`, { method: 'DELETE' }),
  stats: () => req<StatsSnapshot>('/admin/stats'),
  logs: (limit = 100) => req<{ logs: LogEntry[] }>(`/admin/logs?limit=${limit}`).then((r) => r.logs),
};
