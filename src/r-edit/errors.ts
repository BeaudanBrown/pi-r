export interface StructuredError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuredError };

export class RecoverableError extends Error {
  readonly structured: StructuredError;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RecoverableError";
    this.structured = { code, message, recoverable: true, ...(details ? { details } : {}) };
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
