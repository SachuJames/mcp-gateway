import { EventEmitter } from 'node:events';
import { JsonRpcMessage, parseMessage } from '../jsonrpc.js';

export interface SseTransportOptions {
  /** Base URL of the upstream SSE endpoint, e.g. http://host:port/sse */
  url: string;
  headers?: Record<string, string>;
  connectTimeoutMs?: number;
}

/**
 * SSE upstream transport following the pre-Streamable-HTTP MCP pattern:
 * open GET <url> with Accept: text/event-stream, read the `endpoint`
 * event for the message POST URL, then POST each JSON-RPC message there.
 * Responses arrive back on the event stream as `message` events.
 */
export class SseTransport extends EventEmitter {
  private abort: AbortController | null = null;
  private endpointUrl: string | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: SseTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.connect();
    return this.ready;
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const timeoutMs = this.options.connectTimeoutMs ?? 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.options.url, {
        headers: { Accept: 'text/event-stream', ...(this.options.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`SSE connect failed: HTTP ${res.status}`);
    }

    const base = new URL(this.options.url);
    let eventName = '';
    let dataLines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';

    const dispatch = () => {
      const name = eventName || 'message';
      const data = dataLines.join('\n');
      eventName = '';
      dataLines = [];
      this.onSseEvent(name, data, base);
    };

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          leftover += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = leftover.indexOf('\n')) >= 0) {
            const rawLine = leftover.slice(0, idx);
            leftover = leftover.slice(idx + 1);
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line === '') {
              dispatch();
            } else if (line.startsWith(':')) {
              // comment / heartbeat, ignore
            } else if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
      } catch {
        // stream ended or aborted
      } finally {
        clearTimeout(timer);
        this.endpointUrl = null;
        this.ready = null;
        this.abort = null;
        this.emit('close');
      }
    })();

    // Wait for the endpoint event before resolving.
    await new Promise<void>((resolve, reject) => {
      const onEndpoint = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('SSE stream closed before endpoint event'));
      };
      const cleanup = () => {
        this.off('endpoint', onEndpoint);
        this.off('close', onClose);
        clearTimeout(timer);
      };
      this.once('endpoint', onEndpoint);
      this.once('close', onClose);
    });
  }

  private onSseEvent(name: string, data: string, base: URL): void {
    if (name === 'endpoint') {
      try {
        this.endpointUrl = new URL(data, base).toString();
        this.emit('endpoint');
      } catch {
        this.emit('error', new Error(`invalid SSE endpoint: ${data}`));
      }
      return;
    }
    if (name === 'message') {
      if (data === '') return;
      try {
        this.emit('message', parseMessage(data));
      } catch (err) {
        this.emit('parseError', err, data);
      }
    }
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    const url = this.endpointUrl;
    if (!url) throw new Error('SSE transport is not connected');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.options.headers ?? {}) },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      throw new Error(`SSE message POST failed: HTTP ${res.status}`);
    }
    await res.arrayBuffer().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    this.endpointUrl = null;
    this.ready = null;
  }

  get connected(): boolean {
    return this.endpointUrl !== null;
  }
}
