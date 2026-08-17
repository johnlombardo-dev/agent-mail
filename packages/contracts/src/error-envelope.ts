import { z } from "zod";

const FORBIDDEN_DETAIL_KEYS = new Set([
  "cause",
  "credential",
  "credentials",
  "password",
  "rawmail",
  "secret",
  "stack",
  "token",
]);

export const errorCodeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
export const safeErrorMessageSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !hasControlCharacters(value), "message contains control characters");
export const correlationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacters(value), "correlation ID contains control characters");

export type SafeErrorDetails = Readonly<Record<string, unknown>>;

function isSafeErrorDetails(value: unknown): value is SafeErrorDetails {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))) return true;
  }
  return false;
}

function rejectForbiddenDetailKeys(value: unknown, context: z.RefinementCtx): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => rejectForbiddenDetailKeys(entry, context));
    return;
  }
  if (!isSafeErrorDetails(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if (FORBIDDEN_DETAIL_KEYS.has(normalizedKey))
      context.addIssue({ code: "custom", message: `forbidden public error detail: ${key}` });
    rejectForbiddenDetailKeys(entry, context);
  }
}

function parseStrictDetails(schema: z.ZodType, input: unknown): unknown {
  if (schema instanceof z.ZodObject) return schema.strict().parse(input);
  return schema.parse(input);
}

export type PublicErrorEnvelope<
  TCode extends string = string,
  TDetails extends SafeErrorDetails = SafeErrorDetails,
> = Readonly<{
  readonly code: TCode;
  readonly message: string;
  readonly correlationId: string;
  readonly details: TDetails;
}>;

const detailsSchema = z.record(z.string(), z.json()).superRefine(rejectForbiddenDetailKeys);

/** Strict public shape. It has no path for stack, credentials, raw mail, or cause. */
export const publicErrorEnvelopeSchema = z.strictObject({
  code: errorCodeSchema,
  message: safeErrorMessageSchema,
  correlationId: correlationIdSchema,
  details: detailsSchema,
});

export type ErrorDefinition<TDetails extends z.ZodType = z.ZodType> = Readonly<{
  readonly code: string;
  readonly details: TDetails;
}>;

export function defineError<TDetails extends z.ZodType>(
  definition: ErrorDefinition<TDetails>,
): ErrorDefinition<TDetails> {
  errorCodeSchema.parse(definition.code);
  if (typeof definition.details?.parse !== "function")
    throw new TypeError(`error ${definition.code} has no details schema`);
  return Object.freeze({ ...definition });
}

function assertUniqueErrorCodes(definitions: readonly ErrorDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.code)) throw new Error(`duplicate error code: ${definition.code}`);
    seen.add(definition.code);
  }
}

export type ErrorRegistry = Readonly<{
  readonly errors: readonly ErrorDefinition[];
  readonly codes: readonly string[];
  readonly get: (code: string) => ErrorDefinition | undefined;
  readonly parse: (input: unknown) => PublicErrorEnvelope;
  readonly safeParse: (input: unknown) => ErrorParseResult;
}>;

export type ErrorParseResult =
  | Readonly<{ readonly success: true; readonly data: PublicErrorEnvelope }>
  | Readonly<{ readonly success: false; readonly error: Error }>;

/** Register stable errors and parse only envelopes whose code and details are registered. */
export function createErrorRegistry(definitions: readonly ErrorDefinition[]): ErrorRegistry {
  definitions.forEach((definition) => {
    errorCodeSchema.parse(definition.code);
    if (typeof definition.details?.parse !== "function")
      throw new TypeError(`error ${definition.code} has no details schema`);
  });
  assertUniqueErrorCodes(definitions);
  const errors = Object.freeze(definitions.map((definition) => Object.freeze({ ...definition })));
  const codes = Object.freeze(definitions.map((definition) => definition.code));
  const get = (code: string): ErrorDefinition | undefined =>
    errors.find((definition) => definition.code === code);

  const parseEnvelope = (input: unknown): PublicErrorEnvelope => {
    const envelope = publicErrorEnvelopeSchema.parse(input);
    const definition = get(envelope.code);
    if (definition === undefined) throw new Error(`unregistered error code: ${envelope.code}`);
    const details = parseStrictDetails(definition.details, envelope.details);
    if (!isSafeErrorDetails(details))
      throw new Error(`error ${envelope.code} details must be an object`);
    return { ...envelope, details };
  };
  const safeParse = (input: unknown): ErrorParseResult => {
    try {
      return { success: true, data: parseEnvelope(input) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error("invalid public error envelope"),
      };
    }
  };
  return Object.freeze({ errors, codes, get, parse: parseEnvelope, safeParse });
}

export type InternalError = Readonly<{
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly details: SafeErrorDetails;
  readonly cause?: unknown;
  readonly stack?: string;
}>;

/** Explicitly project an internal failure into its public, stable fields. */
export function toPublicErrorEnvelope(
  error: unknown,
  registry: ErrorRegistry,
): PublicErrorEnvelope {
  if (!isSafeErrorDetails(error)) throw new TypeError("internal error must be an object");
  return registry.parse({
    code: error.code,
    message: error.message,
    correlationId: error.correlationId,
    details: error.details,
  });
}
