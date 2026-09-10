// @ts-check

export class PublisherBuildError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly retryable: false;

  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [context]
   */
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "PublisherBuildError";
    this.code = code;
    this.retryable = false;
    this.context = context;
  }
}

/** @param {string} message @param {Record<string, unknown>} [context] */
export function invalidBuild(message: string, context: Record<string, unknown> = {}) {
  return new PublisherBuildError("configuration_invalid", message, context);
}

/** @param {string} message @param {Record<string, unknown>} context */
export function buildLimit(message: string, context: Record<string, unknown>) {
  return new PublisherBuildError("limit_exceeded", message, context);
}
