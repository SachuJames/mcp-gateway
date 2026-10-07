import { describe, expect, it } from 'vitest';
import {
  ErrorCodes,
  encodeMessage,
  errorResponse,
  isNotification,
  isRequest,
  isResponse,
  parseMessage,
} from '../src/jsonrpc.js';

describe('json-rpc framing', () => {
  it('round-trips a request through encode and parse', () => {
    const line = encodeMessage({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    const msg = parseMessage(line.trim());
    expect(isRequest(msg)).toBe(true);
    expect(msg).toMatchObject({ id: 7, method: 'tools/list' });
  });

  it('distinguishes notifications from requests', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(isNotification(msg)).toBe(true);
    expect(isRequest(msg)).toBe(false);
  });

  it('recognizes responses', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(isResponse(msg)).toBe(true);
  });

  it('rejects malformed json', () => {
    expect(() => parseMessage('{nope')).toThrow(/not valid JSON/);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1,"method":"x"}')).toThrow(/2\.0/);
  });

  it('rejects messages that are neither request nor response', () => {
    expect(() => parseMessage('{"jsonrpc":"2.0","id":1}')).toThrow(/neither/);
  });

  it('builds error responses with the gateway codes', () => {
    const res = errorResponse(3, ErrorCodes.RateLimited, 'slow down');
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32003, message: 'slow down' },
    });
  });
});
