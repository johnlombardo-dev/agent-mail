import { z } from "zod";

/** The only stream modes understood by a public operation. */
export const operationStreamingSchema = z.enum(["none", "ndjson", "bytes"]);
export type OperationStreaming = z.infer<typeof operationStreamingSchema>;

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
  readonly cliName: string;
  readonly scope: string;
  readonly request: TRequest;
  readonly response: TResponse;
  readonly streaming: OperationStreaming;
  readonly strictness: OperationStrictness;
}>;

export type OperationDefinitionInput<
  TRequest extends OperationSchema = OperationSchema,
  TResponse extends OperationSchema = OperationSchema,
> = OperationDefinition<TRequest, TResponse>;

export type OperationMetadata = Readonly<{
  readonly key: string;
  readonly route: string;
  readonly cliName: string;
  readonly scope: string;
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

function validateOperationDefinition(definition: OperationDefinition): void {
  checkedText(definition.key, operationNameSchema, "operation key");
  checkedText(definition.route, routeSchema, "operation route");
  checkedText(definition.cliName, operationNameSchema, "operation CLI name");
  checkedText(definition.scope, scopeSchema, "operation scope");
  operationStreamingSchema.parse(definition.streaming);
  operationStrictnessSchema.parse(definition.strictness);
  if (typeof definition.request?.parse !== "function")
    throw new TypeError(`operation ${definition.key} has no request schema`);
  if (typeof definition.response?.parse !== "function")
    throw new TypeError(`operation ${definition.key} has no response schema`);
}

/** Define one operation at the typed boundary. */
export function defineOperation<
  TRequest extends OperationSchema,
  TResponse extends OperationSchema,
>(
  definition: OperationDefinitionInput<TRequest, TResponse>,
): OperationDefinition<TRequest, TResponse> {
  validateOperationDefinition(definition);
  return Object.freeze({ ...definition });
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
  assertUnique(
    definitions.map((definition) => definition.scope),
    "scope",
  );

  const operations = Object.freeze(
    definitions.map((definition) => Object.freeze({ ...definition })),
  );
  const metadata = Object.freeze(
    definitions.map(({ key, route, cliName, scope, streaming, strictness }) =>
      Object.freeze({ key, route, cliName, scope, streaming, strictness }),
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
