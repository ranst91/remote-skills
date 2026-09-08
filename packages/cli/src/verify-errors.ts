export type DiagnosticContext = Record<string, string | number | boolean | undefined>;

const RETRYABLE = new Set<string>(["origin_unavailable", "request_timeout"]);

export class PublisherVerifyError extends Error {
  /**
   * @param {string} code
   * @param {Record<string, string | number | boolean | undefined>} [context]
   * @param {string} [message]
   */
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, string | number | boolean>;

  constructor(
    code: string,
    context: DiagnosticContext = {},
    message = `Remote origin verification failed: ${code}`,
  ) {
    super(message);
    this.name = "PublisherVerifyError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    const definedContext: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined) definedContext[key] = value;
    }
    this.context = definedContext;
  }

  toDiagnostic() {
    return { code: this.code, retryable: this.retryable, context: { ...this.context } };
  }
}

/** @param {string} field @param {string} [message] */
export function invalidConfiguration(
  field: string,
  message = `Invalid verify option: ${field}`,
): PublisherVerifyError {
  return new PublisherVerifyError("configuration_invalid", { field }, message);
}

/** @param {unknown} error @param {Record<string, string | number | boolean | undefined>} [context] */
export function diagnosticFrom(error: unknown, context: DiagnosticContext = {}) {
  const verifyError =
    error instanceof PublisherVerifyError ? error : new PublisherVerifyError("origin_unavailable");
  return {
    code: verifyError.code,
    retryable: verifyError.retryable,
    context: { ...verifyError.context, ...context },
  };
}
