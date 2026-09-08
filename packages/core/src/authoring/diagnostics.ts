// @ts-check

export interface AuthoringDiagnosticContext {
  field?: string;
  limit?: string;
  path?: string;
  skill_name?: string;
}

export interface AuthoringDiagnostic {
  severity: "error" | "warning";
  code: string;
  retryable: false;
  context: AuthoringDiagnosticContext;
  message: string;
}

/**
 * @param {"error" | "warning"} severity
 * @param {string} code
 * @param {string} message
 * @param {AuthoringDiagnosticContext} context
 * @returns {AuthoringDiagnostic}
 */
export function authoringDiagnostic(
  severity: "error" | "warning",
  code: string,
  message: string,
  context: AuthoringDiagnosticContext,
): AuthoringDiagnostic {
  return { severity, code, retryable: false, context, message };
}
