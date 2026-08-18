import { z } from "zod";
import {
  publicErrorEnvelopeSchema,
  type ErrorDefinition,
  type ErrorRegistry,
} from "./error-envelope";
import type { OperationDefinition, OperationRegistry } from "./operation-registry";

export type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: { readonly schemas: Record<string, unknown> };
};
function schemaName(prefix: string, key: string): string {
  return `${prefix}_${key.replaceAll(/[^a-zA-Z0-9]+/gu, "_")}`;
}
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    target: "openapi-3.1",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
function requestSchema(operation: OperationDefinition): Record<string, unknown> {
  return jsonSchema(operation.request);
}
function parameterList(
  operation: OperationDefinition,
  request: Record<string, unknown>,
): unknown[] {
  const paths = new Set([...operation.route.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]));
  const properties = (request.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(request.required) ? request.required : []);
  return Object.entries(properties)
    .filter(([name]) => operation.method === "GET" || paths.has(name))
    .map(([name, schema]) => ({
      name,
      in: paths.has(name) ? "path" : "query",
      required: paths.has(name) || required.has(name),
      schema,
    }));
}
function content(operation: OperationDefinition, responseName: string): Record<string, unknown> {
  if (operation.streaming === "bytes") {
    const mediaType = operation.key === "exports.selected" ? "application/octet-stream" : "*/*";
    return { [mediaType]: { schema: { type: "string", format: "binary" } } };
  }
  if (operation.streaming === "ndjson")
    return { "application/x-ndjson": { schema: { type: "string" } } };
  return { "application/json": { schema: { $ref: `#/components/schemas/${responseName}` } } };
}
function errorName(operation: OperationDefinition | undefined, error: ErrorDefinition): string {
  return operation === undefined
    ? schemaName("ErrorDetails", error.code)
    : schemaName("ErrorDetails", `${operation.key}_${error.code}`);
}
function errorResponses(
  operation: OperationDefinition,
  registry: ErrorRegistry,
): Record<string, unknown> {
  const definitions = [
    ...registry.errors.map((error) => ({ owner: undefined, error })),
    ...operation.errors.map((error) => ({ owner: operation, error })),
  ];
  const statuses = new Map<number, typeof definitions>();
  for (const definition of definitions)
    statuses.set(definition.error.status, [
      ...(statuses.get(definition.error.status) ?? []),
      definition,
    ]);
  return Object.fromEntries(
    [...statuses].map(([status, entries]) => [
      String(status),
      {
        description: `Registered public error (${entries.map(({ error }) => error.code).join(", ")})`,
        content: {
          "application/json": {
            schema: {
              oneOf: entries.map(({ owner, error }) => ({
                allOf: [
                  { $ref: "#/components/schemas/PublicError" },
                  {
                    type: "object",
                    properties: {
                      code: { const: error.code },
                      details: { $ref: `#/components/schemas/${errorName(owner, error)}` },
                    },
                  },
                ],
              })),
            },
          },
        },
      },
    ]),
  );
}
export function generateOpenApiDocument(
  registry: OperationRegistry,
  errors: ErrorRegistry,
): OpenApiDocument {
  const schemas: Record<string, unknown> = {
    PublicError: jsonSchema(publicErrorEnvelopeSchema),
  };
  for (const operation of registry.operations) {
    schemas[schemaName("Request", operation.key)] = requestSchema(operation);
    schemas[schemaName("Response", operation.key)] = jsonSchema(operation.response);
    for (const error of operation.errors)
      schemas[errorName(operation, error)] = jsonSchema(error.details);
  }
  for (const error of errors.errors)
    schemas[errorName(undefined, error)] = jsonSchema(error.details);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of registry.operations) {
    const requestName = schemaName("Request", operation.key);
    const responseName = schemaName("Response", operation.key);
    const entry: Record<string, unknown> = {
      operationId: operation.key,
      summary: `${operation.key} operation`,
      parameters: parameterList(operation, schemas[requestName] as Record<string, unknown>),
      responses: {
        "200": { description: "Successful operation", content: content(operation, responseName) },
        ...errorResponses(operation, errors),
      },
    };
    if (operation.method !== "GET")
      entry.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${requestName}` } },
        },
      };
    paths[operation.route] = { [operation.method.toLowerCase()]: entry };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Agent Mail API", version: "1" },
    paths,
    components: { schemas },
  };
}
export function assertOpenApiCompleteness(
  registry: OperationRegistry,
  document: OpenApiDocument,
  errors?: ErrorRegistry,
): void {
  const registered = new Set(registry.operations.map((operation) => operation.route));
  const described = new Set(Object.keys(document.paths));
  for (const route of registered)
    if (!described.has(route)) throw new Error(`OpenAPI is missing registered route: ${route}`);
  for (const route of described)
    if (!registered.has(route)) throw new Error(`OpenAPI describes unregistered route: ${route}`);
  for (const operation of registry.operations) {
    const path = document.paths[operation.route];
    const method = operation.method.toLowerCase();
    if (path?.[method] === undefined)
      throw new Error(`OpenAPI is missing ${operation.method} operation: ${operation.key}`);
    const extraMethods = Object.keys(path).filter(
      (key) => ![method, "$ref", "summary", "description", "servers", "parameters"].includes(key),
    );
    if (extraMethods.length > 0)
      throw new Error(
        `OpenAPI has extra HTTP operation for ${operation.key}: ${extraMethods.join(", ")}`,
      );
    const actual = new Set(
      Object.keys(
        ((path[method] as Record<string, unknown>).responses ?? {}) as Record<string, unknown>,
      ),
    );
    const expected = new Set([
      "200",
      ...[...(errors?.errors ?? []), ...operation.errors].map((error) => String(error.status)),
    ]);
    if (actual.size !== expected.size || [...expected].some((status) => !actual.has(status)))
      throw new Error(`OpenAPI response statuses drift for ${operation.key}`);
    for (const error of operation.errors)
      if (document.components.schemas[errorName(operation, error)] === undefined)
        throw new Error(`OpenAPI is missing operation error: ${operation.key}/${error.code}`);
  }
  if (errors !== undefined)
    for (const error of errors.errors)
      if (document.components.schemas[errorName(undefined, error)] === undefined)
        throw new Error(`OpenAPI is missing registered error: ${error.code}`);
}
export function assertOpenApi31(document: OpenApiDocument): void {
  if (document.openapi !== "3.1.0") throw new Error("OpenAPI document must be version 3.1.0");
  if (typeof document.paths !== "object" || document.paths === null)
    throw new Error("OpenAPI document must contain paths");
  if (document.components?.schemas === undefined)
    throw new Error("OpenAPI document must contain component schemas");
}
export function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sort(child)]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
