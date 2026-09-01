/**
 * Security & Token Redaction Utilities
 *
 * Ensures tokens are never logged, never exposed in error messages,
 * and never leaked through UI notices or modal dialogs.
 */

const GITHUB_PAT_REGEX = /github_pat_[a-zA-Z0-9_]{22,255}/g;
const GITHUB_LEGACY_TOKEN_REGEX = /gh[pousr]_[a-zA-Z0-9]{36,255}/g;
const BEARER_AUTH_REGEX = /Bearer\s+[a-zA-Z0-9_.-]+/gi;
const AUTH_HEADER_REGEX = /(authorization\s*:\s*)([^\r\n]+)/gi;
const URL_TOKEN_PARAM_REGEX = /([?&](?:access_token|token|key|secret)=)[^&]+/gi;

/**
 * Redacts tokens from a string.
 * @param text The input string that may contain sensitive tokens.
 * @param specificToken Optional specific configured token to redact.
 * @returns Sanitized string with tokens replaced by [REDACTED_TOKEN].
 */
export function redactTokens(text: string, specificToken?: string): string {
  if (!text) return text;

  let sanitized = text;

  // Redact specific configured token first if available and non-trivial
  if (specificToken && specificToken.trim().length >= 4) {
    const escaped = specificToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "g"), "[REDACTED_TOKEN]");
  }

  // Redact standard GitHub PAT patterns
  sanitized = sanitized
    .replace(GITHUB_PAT_REGEX, "[REDACTED_TOKEN]")
    .replace(GITHUB_LEGACY_TOKEN_REGEX, "[REDACTED_TOKEN]")
    .replace(BEARER_AUTH_REGEX, "Bearer [REDACTED_TOKEN]")
    .replace(AUTH_HEADER_REGEX, "$1[REDACTED_TOKEN]")
    .replace(URL_TOKEN_PARAM_REGEX, "$1[REDACTED_TOKEN]");

  return sanitized;
}

/**
 * Sanitizes an error message or exception object to ensure no token leaks.
 * @param error Any error or unknown caught object.
 * @param specificToken Optional specific configured token to redact.
 * @returns A safe, sanitized error message string.
 */
export function sanitizeErrorMessage(error: unknown, specificToken?: string): string {
  if (!error) return "Unknown error occurred";

  let rawMessage: string;

  if (typeof error === "string") {
    rawMessage = error;
  } else if (error instanceof Error) {
    rawMessage = error.message || error.toString();
  } else if (typeof error === "object") {
    try {
      rawMessage = JSON.stringify(error);
    } catch {
      rawMessage = String(error);
    }
  } else {
    rawMessage = String(error);
  }

  return redactTokens(rawMessage, specificToken);
}
