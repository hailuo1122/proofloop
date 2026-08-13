export class ProofloopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProofloopError';
  }
}

export function toErrorBody(err: unknown, requestId: string) {
  if (err instanceof ProofloopError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      requestId,
    };
  }
  return {
    error: {
      code: 'internal_error',
      message: err instanceof Error ? err.message : 'Unknown error',
    },
    requestId,
  };
}
