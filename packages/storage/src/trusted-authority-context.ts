/** Runtime provenance for the storage authority boundary. */
const trustedContexts = new WeakSet<object>();

export function registerTrustedAuthorityContext<T extends object>(value: T): T {
  trustedContexts.add(value);
  return value;
}

export function isTrustedAuthorityContext(value: unknown): value is object {
  return typeof value === "object" && value !== null && trustedContexts.has(value);
}
