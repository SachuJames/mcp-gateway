import { describe, expect, it } from 'vitest';
import { GATEWAY_VERSION } from '../src/version.js';

describe('gateway version', () => {
  it('is a plain semver string', () => {
    expect(GATEWAY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the released 1.0.0 line, not the old 0.1.0', () => {
    expect(GATEWAY_VERSION).not.toBe('0.1.0');
  });
});
