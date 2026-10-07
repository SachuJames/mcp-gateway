/**
 * Per-key token bucket rate limiter. Buckets are created lazily on first
 * use; a key may carry its own capacity/refill override, otherwise the
 * gateway defaults apply.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(count = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  get remaining(): number {
    return Math.floor(this.tokens);
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaultCapacity: number,
    private readonly defaultRefillPerSecond: number,
  ) {}

  check(
    keyId: string,
    override?: { capacity: number; refillPerSecond: number },
  ): { allowed: boolean; remaining: number } {
    let bucket = this.buckets.get(keyId);
    if (!bucket) {
      bucket = new TokenBucket(
        override?.capacity ?? this.defaultCapacity,
        override?.refillPerSecond ?? this.defaultRefillPerSecond,
      );
      this.buckets.set(keyId, bucket);
    }
    const allowed = bucket.tryConsume(1);
    return { allowed, remaining: bucket.remaining };
  }

  reset(keyId: string): void {
    this.buckets.delete(keyId);
  }
}
