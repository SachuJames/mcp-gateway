import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AuditEntry {
  ts: string;
  keyId: string;
  keyName: string;
  server: string;
  tool: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  argsBytes: number;
  outputBytes: number;
}

const RING_CAPACITY = 2000;

/**
 * Structured audit trail for every proxied tool call: an in-memory ring
 * for the live dashboard feed plus append-only JSON lines on disk.
 */
export class AuditLog {
  private ring: AuditEntry[] = [];
  private filePath: string | null = null;

  async init(logDir: string): Promise<void> {
    await mkdir(logDir, { recursive: true });
    this.filePath = join(logDir, 'audit.log');
  }

  record(entry: AuditEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_CAPACITY) {
      this.ring.splice(0, this.ring.length - RING_CAPACITY);
    }
    if (this.filePath) {
      appendFile(this.filePath, JSON.stringify(entry) + '\n').catch(() => undefined);
    }
  }

  recent(limit = 100): AuditEntry[] {
    return this.ring.slice(-limit).reverse();
  }
}

export interface ToolStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
}

export interface StatsSnapshot {
  totalCalls: number;
  totalErrors: number;
  perTool: Record<string, ToolStats & { avgLatencyMs: number }>;
  perTenant: Record<string, { calls: number; errors: number }>;
  perServer: Record<string, { calls: number; errors: number }>;
}

export class Stats {
  private totalCalls = 0;
  private totalErrors = 0;
  private perTool = new Map<string, ToolStats>();
  private perTenant = new Map<string, { calls: number; errors: number }>();
  private perServer = new Map<string, { calls: number; errors: number }>();

  record(entry: AuditEntry): void {
    this.totalCalls++;
    if (!entry.ok) this.totalErrors++;

    const tool = this.perTool.get(entry.tool) ?? { calls: 0, errors: 0, totalLatencyMs: 0 };
    tool.calls++;
    tool.totalLatencyMs += entry.latencyMs;
    if (!entry.ok) tool.errors++;
    this.perTool.set(entry.tool, tool);

    const tenant = this.perTenant.get(entry.keyId) ?? { calls: 0, errors: 0 };
    tenant.calls++;
    if (!entry.ok) tenant.errors++;
    this.perTenant.set(entry.keyId, tenant);

    const server = this.perServer.get(entry.server) ?? { calls: 0, errors: 0 };
    server.calls++;
    if (!entry.ok) server.errors++;
    this.perServer.set(entry.server, server);
  }

  snapshot(): StatsSnapshot {
    const perTool: StatsSnapshot['perTool'] = {};
    for (const [name, s] of this.perTool) {
      perTool[name] = { ...s, avgLatencyMs: s.calls > 0 ? s.totalLatencyMs / s.calls : 0 };
    }
    return {
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      perTool,
      perTenant: Object.fromEntries(this.perTenant),
      perServer: Object.fromEntries(this.perServer),
    };
  }
}
