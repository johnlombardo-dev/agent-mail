import type { AuthenticatedRequestContext } from "./http";

/**
 * Runtime provenance for authenticator output. The public TypeScript shape is
 * intentionally not sufficient to mint authority: only boundary decoders and
 * the native verifier register objects in this private set.
 */
const trustedContexts = new WeakSet<object>();

export function registerTrustedAuthContext<T extends object>(value: T): T {
  trustedContexts.add(value);
  return value;
}

export function isTrustedAuthContext(value: unknown): value is AuthenticatedRequestContext {
  return typeof value === "object" && value !== null && trustedContexts.has(value);
}
