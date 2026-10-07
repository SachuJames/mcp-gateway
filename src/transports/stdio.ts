import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpcMessage, encodeMessage, parseMessage } from '../jsonrpc.js';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class UpstreamExitedError extends Error {
  constructor(
    public readonly code: number | null,
    public readonly signal: string | null,
  ) {
    super(`upstream process exited (code=${code}, signal=${signal})`);
    this.name = 'UpstreamExitedError';
  }
}

/**
 * Newline-delimited JSON-RPC over a child process' stdio, the classic
 * MCP transport for local servers. stdout carries messages, stderr is
 * surfaced as log events and never parsed as protocol.
 */
export class StdioTransport extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = '';

  constructor(private readonly options: StdioTransportOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: { ...process.env, ...(this.options.env ?? {}) },
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    // Persistent handlers are attached only after a successful spawn: if
    // spawn itself fails, the 'error' event must reject this promise, not
    // blow up inside an EventEmitter re-emit with no listener.
    await new Promise<void>((resolve, reject) => {
      child.once('error', (err: Error) => {
        this.child = null;
        reject(err);
      });
      child.once('spawn', () => {
        child.on('error', (err) => this.emit('error', err));
        child.on('exit', (code, signal) => {
          this.child = null;
          this.emit('exit', new UpstreamExitedError(code, signal));
        });
        resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '') continue;
      try {
        this.emit('message', parseMessage(line));
      } catch (err) {
        this.emit('parseError', err, line);
      }
    }
  }

  send(msg: JsonRpcMessage): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error('stdio transport is not running');
    }
    child.stdin.write(encodeMessage(msg));
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null;
  }
}
