import { z } from "zod";
import {
  errorCodeSchema,
  publicErrorStatusSchema,
  safeErrorMessageSchema,
  type ErrorDefinition,
  type ErrorRegistry,
} from "./error-envelope";

/** The only stream modes understood by a public operation. */
export const operationStreamingSchema = z.enum(["none", "ndjson", "bytes"]);
export type OperationStreaming = z.infer<typeof operationStreamingSchema>;

/** HTTP methods currently admitted by the public operation surface. */
export const operationHttpMethodSchema = z.enum(["GET", "POST", "DELETE"]);
export type OperationHttpMethod = z.infer<typeof operationHttpMethodSchema>;
/** Short alias for consumers describing transport metadata. */
export const httpMethodSchema = operationHttpMethodSchema;
export type HttpMethod = OperationHttpMethod;

/** Registry consumers must opt into the unknown-field policy explicitly. */
export const operationStrictnessSchema = z.literal("strict");
export type OperationStrictness = z.infer<typeof operationStrictnessSchema>;

const operationNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const routeSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "operation route must start with /")
  .refine(
    (value) => !/[\s?#]/u.test(value),
    "operation route must be a path without whitespace, query, or fragment",
  )
  .refine((value) => !hasControlCharacters(value), "operation route has control characters");
const scopeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u);

export type OperationSchema = z.ZodType;

export type OperationDefinition<
  TRequest extends OperationSchema = OperationSchema,
  TResponse extends OperationSchema = OperationSchema,
> = Readonly<{
  readonly key: string;
  readonly route: string;
  readonly method: OperationHttpMethod;
  readonly cliName: string;
  readonly scope: string | null;
  readonly request: TRequest;
  readonly response: TResponse;
  readonly errors: readonly ErrorDefinition[];
  readonly streaming: OperationStreaming;
  readonly strictness: OperationStrictness;
}>;

export type OperationDefinitionInput<
  TRequest extends OperationSchema = OperationSchema,
  TResponse extends OperationSchema = OperationSchema,
> = Omit<OperationDefinition<TRequest, TResponse>, "errors"> &
  Partial<Pick<OperationDefinition<TRequest, TResponse>, "errors">>;

export type OperationMetadata = Readonly<{
  readonly key: string;
  readonly route: string;
  readonly method: OperationHttpMethod;
  readonly cliName: string;
  readonly scope: string | null;
  readonly errors: readonly ErrorDefinition[];
  readonly streaming: OperationStreaming;
  readonly strictness: OperationStrictness;
}>;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))) return true;
  }
  return false;
}

function parseStrict(schema: OperationSchema, input: unknown): unknown {
  if (schema instanceof z.ZodObject) return schema.strict().parse(input);
  return schema.parse(input);
}

function checkedText(value: unknown, schema: z.ZodType<string>, label: string): string {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(`${label} is invalid`);
  return result.data;
}

function freezeErrorDefinitions(
  definitions: readonly ErrorDefinition[],
): readonly ErrorDefinition[] {
  return Object.freeze(definitions.map((definition) => Object.freeze({ ...definition })));
}

function validateOperationDefinition(definition: OperationDefinition): void {
  const expectedKeys = new Set([
    "key",
    "route",
    "method",
    "cliName",
    "scope",
    "request",
    "response",
    "errors",
    "streaming",
    "strictness",
  ]);
  const unknownKey = Object.keys(definition).find((key) => !expectedKeys.has(key));
  if (unknownKey !== undefined)
    throw new TypeError(`operation ${definition.key} has unknown metadata: ${unknownKey}`);
  checkedText(definition.key, operationNameSchema, "operation key");
  checkedText(definition.route, routeSchema, "operation route");
  operationHttpMethodSchema.parse(definition.method);
  checkedText(definition.cliName, operationNameSchema, "operation CLI name");
  if (definition.scope !== null) checkedText(definition.scope, scopeSchema, "operation scope");
  operationStreamingSchema.parse(definition.streaming);
  operationStrictnessSchema.parse(definition.strictness);
  if (typeof definition.request?.parse !== "function")
    throw new TypeError(`operation ${definition.key} has no request schema`);
  if (typeof definition.response?.parse !== "function")
    throw new TypeError(`operation ${definition.key} has no response schema`);
  if (!Array.isArray(definition.errors))
    throw new TypeError(`operation ${definition.key} has no error metadata`);
  const errorCodes = new Set<string>();
  for (const error of definition.errors) {
    const unknownErrorKey = Object.keys(error).find(
      (key) => !new Set(["code", "status", "message", "details"]).has(key),
    );
    if (unknownErrorKey !== undefined)
      throw new TypeError(
        `operation ${definition.key} error ${error.code} has unknown metadata: ${unknownErrorKey}`,
      );
    errorCodeSchema.parse(error.code);
    publicErrorStatusSchema.parse(error.status);
    if (error.message !== undefined) safeErrorMessageSchema.parse(error.message);
    if (errorCodes.has(error.code))
      throw new TypeError(`operation ${definition.key} has duplicate error code: ${error.code}`);
    errorCodes.add(error.code);
    if (typeof error.details?.parse !== "function")
      throw new TypeError(`operation ${definition.key} error ${error.code} has no details schema`);
  }
}

/** Define one operation at the typed boundary. */
export function defineOperation<
  TRequest extends OperationSchema,
  TResponse extends OperationSchema,
>(
  definition: OperationDefinitionInput<TRequest, TResponse>,
): OperationDefinition<TRequest, TResponse> {
  const normalized = {
    ...definition,
    errors: freezeErrorDefinitions(definition.errors ?? []),
  };
  validateOperationDefinition(normalized);
  return Object.freeze(normalized);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate operation ${label}: ${value}`);
    seen.add(value);
  }
}

export type OperationRegistry = Readonly<{
  readonly operations: readonly OperationDefinition[];
  readonly metadata: readonly OperationMetadata[];
  readonly get: (key: string) => OperationDefinition | undefined;
  readonly parseRequest: (key: string, input: unknown) => unknown;
  readonly parseResponse: (key: string, input: unknown) => unknown;
}>;

/** Ensure operation-scoped errors agree with the shared public authority. */
export function assertPublicErrorStatusConsistency(
  errorRegistry: Pick<ErrorRegistry, "get">,
  definitions: readonly OperationDefinition[],
): void {
  for (const definition of definitions)
    for (const error of definition.errors) {
      const shared = errorRegistry.get(error.code);
      if (shared !== undefined && shared.status !== error.status)
        throw new Error(
          `conflicting public error status for ${error.code}: ${shared.status} and ${error.status}`,
        );
    }
}

/**
 * Build the single source of operation metadata used by REST and CLI layers.
 * All four public names are unique; in particular CLI names are not scoped.
 */
export function createOperationRegistry(
  definitions: readonly OperationDefinition[],
): OperationRegistry {
  definitions.forEach(validateOperationDefinition);
  assertUnique(
    definitions.map((definition) => definition.key),
    "key",
  );
  assertUnique(
    definitions.map((definition) => definition.route),
    "route",
  );
  assertUnique(
    definitions.map((definition) => definition.cliName),
    "CLI name",
  );
  const scopes = new Map<string, string>();
  const errorStatuses = new Map<string, number>();
  for (const definition of definitions) {
    for (const error of definition.errors) {
      const previousStatus = errorStatuses.get(error.code);
      if (previousStatus !== undefined && previousStatus !== error.status)
        throw new Error(
          `conflicting operation error status for ${error.code}: ${previousStatus} and ${error.status}`,
        );
      errorStatuses.set(error.code, error.status);
    }
    if (definition.scope === null) continue;
    const previous = scopes.get(definition.scope);
    const sharedApprovalScope =
      definition.scope === "mail:action.approve" &&
      previous !== undefined &&
      ((previous === "action-plans.approve" && definition.key === "action-plans.cancel-approval") ||
        (previous === "action-plans.cancel-approval" && definition.key === "action-plans.approve"));
    if (previous !== undefined && !sharedApprovalScope)
      throw new Error(`duplicate operation scope: ${definition.scope}`);
    scopes.set(definition.scope, definition.key);
  }

  const operations = Object.freeze(
    definitions.map((definition) =>
      Object.freeze({ ...definition, errors: freezeErrorDefinitions(definition.errors) }),
    ),
  );
  const metadata = Object.freeze(
    operations.map(({ key, route, method, cliName, scope, streaming, strictness, errors }) =>
      Object.freeze({ key, route, method, cliName, scope, streaming, strictness, errors }),
    ),
  );
  const get = (key: string): OperationDefinition | undefined =>
    operations.find((definition) => definition.key === key);
  const parseRequest = (key: string, input: unknown): unknown => {
    const operation = get(key);
    if (operation === undefined) throw new Error(`unknown operation: ${key}`);
    return parseStrict(operation.request, input);
  };
  const parseResponse = (key: string, input: unknown): unknown => {
    const operation = get(key);
    if (operation === undefined) throw new Error(`unknown operation: ${key}`);
    return parseStrict(operation.response, input);
  };
  return Object.freeze({ operations, metadata, get, parseRequest, parseResponse });
}
