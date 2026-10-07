import { createHash, randomBytes } from 'node:crypto';

export interface RateLimitOverride {
  capacity: number;
  refillPerSecond: number;
}

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  /** Server names this key may use, or ['*'] for all. */
  servers: string[];
  /** Qualified tool names allowed; undefined means all tools on allowed servers. */
  tools?: string[];
  rateLimit?: RateLimitOverride;
  createdAt: string;
}

export interface CreateKeySpec {
  name: string;
  servers: string[];
  tools?: string[];
  rateLimit?: RateLimitOverride;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function slug(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * API key store. Secrets are sha256-hashed at rest; the plaintext is
 * shown once at creation time and never stored.
 */
export class KeyStore {
  private keys = new Map<string, ApiKey>();

  create(spec: CreateKeySpec): { record: ApiKey; secret: string } {
    if (!spec.name || !Array.isArray(spec.servers) || spec.servers.length === 0) {
      throw new Error('key needs a name and at least one server scope');
    }
    const secret = `mgw_${randomBytes(24).toString('base64url')}`;
    const record: ApiKey = {
      id: `key_${slug()}`,
      name: spec.name,
      keyHash: hashSecret(secret),
      keyPrefix: secret.slice(0, 8),
      servers: spec.servers,
      tools: spec.tools,
      rateLimit: spec.rateLimit,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(record.keyHash, record);
    return { record, secret };
  }

  verify(secret: string): ApiKey | null {
    if (!secret) return null;
    return this.keys.get(hashSecret(secret)) ?? null;
  }

  get(id: string): ApiKey | undefined {
    for (const k of this.keys.values()) {
      if (k.id === id) return k;
    }
    return undefined;
  }

  list(): Array<Omit<ApiKey, 'keyHash'>> {
    return [...this.keys.values()].map(({ keyHash: _h, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    for (const [hash, k] of this.keys) {
      if (k.id === id) {
        this.keys.delete(hash);
        return true;
      }
    }
    return false;
  }

  /** True when the key may call this qualified tool on this server. */
  canAccess(key: ApiKey, serverName: string, qualifiedTool: string): boolean {
    const serverOk = key.servers.includes('*') || key.servers.includes(serverName);
    if (!serverOk) return false;
    if (!key.tools) return true;
    return key.tools.includes(qualifiedTool);
  }

  /** True when the key may see this server's tools at all. */
  canSeeServer(key: ApiKey, serverName: string): boolean {
    return key.servers.includes('*') || key.servers.includes(serverName);
  }
}
