export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
