/**
 * The portion of an IMAP adapter fault that the lifecycle actor is allowed to
 * consume.  It is deliberately structural so the IMAP package does not depend
 * on the daemon's workflow implementation.
 */
export type ImapAuthenticationDiagnostic = Readonly<{
  readonly code: "imap.auth-required";
  readonly message: "IMAP authentication was rejected.";
  readonly account: string;
  readonly serverCategory: ImapAuthenticationServerCategory;
}>;

export type ImapAuthenticationServerCategory =
  | "AUTHENTICATIONFAILED"
  | "AUTHORIZATIONFAILED"
  | "OAUTH-INVALID-TOKEN"
  | "CREDENTIAL-REJECTION";

/** A safe WorkflowFault-shaped result for the daemon's authentication route. */
export type ImapAuthenticationFault = Readonly<{
  readonly category: "authentication";
  readonly code: "auth_required";
  readonly safeMessage: "Credentials were rejected.";
  readonly authReason: "provider-rejected";
  readonly diagnostics: readonly [ImapAuthenticationDiagnostic];
}>;

export type ImapAuthenticationClassifierOptions = Readonly<{
  /** The configured account identity, never a password or authorization value. */
  readonly account?: unknown;
}>;

type RecordValue = Readonly<Record<string, unknown>>;

const AUTHENTICATION_CODES = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHENTICATION_FAILED",
  "AUTHENTICATION_FAILURE",
  "AUTHFAILED",
  "AUTHFAILURE",
  "AUTHREJECTED",
  "CREDENTIALSINVALID",
  "CREDENTIALSREJECTED",
  "INVALIDCREDENTIALS",
  "INVALIDPASSWORD",
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase().replaceAll("-", "_");
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized) ? normalized : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function serverCategory(value: RecordValue): ImapAuthenticationServerCategory | undefined {
  const response = isRecord(value.response) ? value.response : undefined;
  const candidates = [
    value.serverResponseCode,
    value.responseCode,
    value.code,
    response?.serverResponseCode,
    response?.responseCode,
    response?.code,
  ];
  for (const candidate of candidates) {
    const normalized = token(candidate);
    if (normalized === "AUTHENTICATIONFAILED") return "AUTHENTICATIONFAILED";
    if (normalized === "AUTHORIZATIONFAILED") return "AUTHORIZATIONFAILED";
    if (normalized !== undefined && AUTHENTICATION_CODES.has(normalized))
      return "CREDENTIAL-REJECTION";
  }

  const responseText = [value.response, value.responseText, value.message].find(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (responseText !== undefined) {
    if (/\bAUTHENTICATIONFAILED\b/iu.test(responseText)) return "AUTHENTICATIONFAILED";
    if (/\bAUTHORIZATIONFAILED\b/iu.test(responseText)) return "AUTHORIZATIONFAILED";
  }

  const oauthError = value.oauthError;
  if (isRecord(oauthError)) {
    const oauthStatus = token(oauthError.status ?? oauthError.error);
    if (oauthStatus === "INVALID_TOKEN" || oauthStatus === "INVALID_GRANT")
      return "OAUTH-INVALID-TOKEN";
  }
  return undefined;
}

function hasCredentialRejectionText(value: RecordValue): boolean {
  const response = isRecord(value.response) ? value.response : undefined;
  const candidates = [
    value.message,
    value.response,
    value.responseText,
    response?.text,
    response?.responseText,
  ];
  return candidates.some((candidate) => {
    const text = stringValue(candidate);
    return (
      text !== undefined &&
      /(?:authentication|login)\s+(?:failed|failure|rejected)|(?:invalid|incorrect|wrong|bad)\s+(?:password|credentials?|username|login)|(?:password|credentials?|login)\s+(?:is\s+)?(?:invalid|incorrect|wrong|rejected|failed)/iu.test(
        text,
      )
    );
  });
}

function isAuthenticationFailure(value: RecordValue): boolean {
  if (value.authenticationFailed === true) return true;
  const category = token(value.category);
  if (
    category === "AUTHENTICATION" ||
    category === "AUTHORIZATION" ||
    category === "CREDENTIALS_INVALID"
  )
    return true;
  if (serverCategory(value) !== undefined) return true;
  return hasCredentialRejectionText(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function safeAccount(value: unknown): string {
  if (typeof value !== "string") return "unknown-account";
  const account = value.trim();
  if (
    account.length === 0 ||
    account.length > 320 ||
    hasControlCharacters(account) ||
    /(?:password|passwd|secret|credential|token|authorization|bearer)\s*[:=]/iu.test(account) ||
    /:\/\/[^/\s:]+:[^/@\s]+@/u.test(account)
  )
    return "unknown-account";
  return account;
}

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * Classify the production-shaped ImapFlow authentication failures that are
 * otherwise easy to mistake for transient connection errors.  Only fixed,
 * bounded metadata crosses this boundary; provider messages and nested error
 * objects are used as predicates and are never copied into the result.
 */
export function classifyImapAuthenticationFailure(
  value: unknown,
  options: ImapAuthenticationClassifierOptions = {},
): ImapAuthenticationFault | null {
  const input = asRecord(value);
  if (input === undefined || !isAuthenticationFailure(input)) return null;
  const category = serverCategory(input) ?? "CREDENTIAL-REJECTION";
  return {
    category: "authentication",
    code: "auth_required",
    safeMessage: "Credentials were rejected.",
    authReason: "provider-rejected",
    diagnostics: [
      {
        code: "imap.auth-required",
        message: "IMAP authentication was rejected.",
        account: safeAccount(options.account),
        serverCategory: category,
      },
    ],
  };
}

/** Explicit alias for callers that classify an arbitrary IMAP adapter error. */
export const classifyImapError = classifyImapAuthenticationFailure;
