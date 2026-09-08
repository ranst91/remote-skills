export type CacheErrorContext = {
  expected_digest?: string;
  layout_version?: string;
};

export class CacheCorruptError extends Error {
  readonly code = "cache_corrupt" as const;
  readonly retryable = false;
  readonly context: CacheErrorContext;

  constructor(message: string, context: CacheErrorContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheCorruptError";
    this.context = context;
  }
}

export class CacheConfigurationError extends Error {
  readonly code = "configuration_invalid" as const;
  readonly retryable = false;
  readonly context: { field: string };

  constructor(field: string) {
    super("cache configuration is invalid");
    this.name = "CacheConfigurationError";
    this.context = { field };
  }
}

export function requireFiniteLimit(
  field: string,
  value: number,
  options: { allowZero?: boolean } = {},
): number {
  if (!Number.isSafeInteger(value) || (options.allowZero === true ? value < 0 : value <= 0)) {
    throw new CacheConfigurationError(field);
  }
  return value;
}

export function requireSafeNonce(field: string, value: string): string {
  if (!isSafeNonce(value)) throw new CacheConfigurationError(field);
  return value;
}

export function isSafeNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
