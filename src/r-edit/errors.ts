export interface StructuredError {
  code: string;
  message: string;
  recoverable: boolean;
  retryable?: boolean;
  agentAction?: string;
  details?: Record<string, unknown>;
}

export type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuredError };

export class RecoverableError extends Error {
  readonly structured: StructuredError;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    behavior?: { retryable?: boolean; agentAction?: string },
  ) {
    super(message);
    this.name = "RecoverableError";
    this.structured = {
      code,
      message,
      recoverable: true,
      ...(behavior?.retryable === undefined ? {} : { retryable: behavior.retryable }),
      ...(behavior?.agentAction ? { agentAction: behavior.agentAction } : {}),
      ...(details ? { details } : {}),
    };
  }
}

export function errorEnvelope(error: unknown): Envelope<never> {
  if (error instanceof RecoverableError) return { ok: false, error: error.structured };
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message, recoverable: false },
  };
}
