import { ErrorCodes } from './jsonrpc.js';

export class GuardrailError extends Error {
  readonly code = ErrorCodes.GuardrailViolation;
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export interface GuardrailOptions {
  maxArgsBytes: number;
  maxOutputBytes: number;
  /** Tool patterns blocked gateway-wide, e.g. ["admin__*"]. Supports trailing "*". */
  denyPatterns?: string[];
}

function matchesPattern(qualified: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return qualified.startsWith(pattern.slice(0, -1));
  }
  return qualified === pattern;
}

/** Reject oversized or denied tool calls before they reach an upstream. */
export function checkCallGuardrails(
  qualifiedTool: string,
  args: unknown,
  options: GuardrailOptions,
): void {
  for (const pattern of options.denyPatterns ?? []) {
    if (matchesPattern(qualifiedTool, pattern)) {
      throw new GuardrailError(`tool is blocked by gateway policy: ${qualifiedTool}`);
    }
  }
  const argsJson = JSON.stringify(args ?? {});
  const size = Buffer.byteLength(argsJson, 'utf8');
  if (size > options.maxArgsBytes) {
    throw new GuardrailError(
      `arguments too large: ${size} bytes exceeds limit of ${options.maxArgsBytes}`,
    );
  }
}

export function checkOutputGuardrail(text: string, maxOutputBytes: number): void {
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maxOutputBytes) {
    throw new GuardrailError(
      `upstream output too large: ${size} bytes exceeds limit of ${maxOutputBytes}`,
    );
  }
}
