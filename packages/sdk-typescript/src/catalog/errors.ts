export type RemoteSkillsErrorCode =
  | "archive_unsafe"
  | "artifact_unsupported"
  | "authentication_failed"
  | "authorization_denied"
  | "cache_corrupt"
  | "catalog_invalid"
  | "configuration_invalid"
  | "digest_mismatch"
  | "limit_exceeded"
  | "origin_unavailable"
  | "path_invalid"
  | "policy_denied"
  | "request_timeout"
  | "resource_not_found"
  | "resource_not_text"
  | "session_closed"
  | "skill_not_found"
  | "unsupported_schema"
  | "version_unavailable";

export interface RemoteSkillsErrorContext {
  artifact_type?: string;
  expected_digest?: string;
  field?: string;
  layout_version?: string;
  limit?: string;
  origin_alias?: string;
  path?: string;
  requested_range?: string;
  schema?: string;
  scope?: string;
  skill_name?: string;
  status?: number;
}

export interface RemoteSkillsDiagnostic {
  code: RemoteSkillsErrorCode;
  retryable: boolean;
  context: RemoteSkillsErrorContext;
}

const RETRYABLE_CODES = new Set<RemoteSkillsErrorCode>(["origin_unavailable", "request_timeout"]);

export class RemoteSkillsError extends Error {
  readonly code: RemoteSkillsErrorCode;
  readonly retryable: boolean;
  readonly context: RemoteSkillsErrorContext;

  constructor(code: RemoteSkillsErrorCode, context: RemoteSkillsErrorContext = {}) {
    super(`Remote Skills request failed: ${code}`);
    this.name = "RemoteSkillsError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.context = context;
  }

  toDiagnostic(): RemoteSkillsDiagnostic {
    return {
      code: this.code,
      retryable: this.retryable,
      context: { ...this.context },
    };
  }
}
