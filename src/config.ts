export interface RateLimitDefaults {
  capacity: number;
  refillPerSecond: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  adminToken: string;
  defaultCallTimeoutMs: number;
  maxArgsBytes: number;
  maxOutputBytes: number;
  rateLimit: RateLimitDefaults;
  logDir: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function loadConfig(): GatewayConfig {
  const adminToken = process.env.MCP_GW_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error('MCP_GW_ADMIN_TOKEN is required');
  }
  return {
    port: envInt('MCP_GW_PORT', 8080),
    host: process.env.MCP_GW_HOST ?? '127.0.0.1',
    adminToken,
    defaultCallTimeoutMs: envInt('MCP_GW_CALL_TIMEOUT_MS', 30000),
    maxArgsBytes: envInt('MCP_GW_MAX_ARGS_BYTES', 65536),
    maxOutputBytes: envInt('MCP_GW_MAX_OUTPUT_BYTES', 262144),
    rateLimit: {
      capacity: envInt('MCP_GW_RL_CAPACITY', 60),
      refillPerSecond: envInt('MCP_GW_RL_REFILL', 1),
    },
    logDir: process.env.MCP_GW_LOG_DIR ?? 'logs',
  };
}
