import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createErrorRegistry,
  createOperationRegistry,
  defineError,
  defineOperation,
  generateOpenApiDocument,
  httpErrorRegistry as contractsHttpErrorRegistry,
  type ErrorRegistry,
} from "@agent-mail/contracts";
import {
  httpErrorRegistry as daemonHttpErrorRegistry,
  publicOperationRegistry,
} from "../src/http";

const expectedStatuses = {
  invalid_request: 400,
  missing_credentials: 401,
  invalid_credentials: 401,
  expired_credentials: 401,
  insufficient_scope: 403,
  request_too_large: 413,
  not_found: 404,
  internal_error: 500,
  "action.approval_forbidden": 403,
  "action.approval_presence_required": 403,
  "action.operator_presence_unsupported": 503,
  "action.operator_challenge_capacity": 429,
  "action.operator_challenge_not_found": 404,
  "action.operator_challenge_expired": 409,
  "action.operator_challenge_consumed": 409,
  "action.operator_assertion_invalid": 403,
  "action.approval_not_found": 409,
  "action.approval_mismatch": 409,
  "action.approval_expired": 409,
  "action.approval_cancelled": 409,
  "action.approval_invalidated": 409,
  "action.approval_consumed": 409,
  "action.plan_version_stale": 409,
  "action.plan_not_pending": 409,
  "action.plan_expired": 409,
  "action.legacy_authority": 409,
} as const;

function assertExactAuthority(registry: ErrorRegistry): void {
  if (registry.errors.length !== 26)
    throw new Error(`public HTTP authority row count drifted: ${registry.errors.length}`);
  const actual = Object.fromEntries(registry.errors.map(({ code, status }) => [code, status]));
  if (JSON.stringify(actual) !== JSON.stringify(expectedStatuses))
    throw new Error("public HTTP authority status matrix drifted");
}

function assertContractsIdentity(registry: ErrorRegistry): void {
  if (registry !== contractsHttpErrorRegistry)
    throw new Error("daemon must consume the contracts-owned HTTP authority object");
}

describe("P6-C10A shared HTTP error authority", () => {
  it("keeps contracts, daemon compatibility, and the exact 26-row matrix identical", () => {
    expect(daemonHttpErrorRegistry).toBe(contractsHttpErrorRegistry);
    assertExactAuthority(contractsHttpErrorRegistry);
    expect(new Set(contractsHttpErrorRegistry.errors.map(({ code }) => code)).size).toBe(26);
  });

  it("rejects missing, altered, duplicated, and reconstructed authorities", () => {
    expect(() =>
      assertExactAuthority(createErrorRegistry(contractsHttpErrorRegistry.errors.slice(0, -1))),
    ).toThrow(/row count drifted/);
    const altered = createErrorRegistry(
      contractsHttpErrorRegistry.errors.map((error) =>
        error.code === "request_too_large" ? { ...error, status: 400 as const } : error,
      ),
    );
    expect(() => assertExactAuthority(altered)).toThrow(/status matrix drifted/);
    expect(() =>
      createErrorRegistry([...contractsHttpErrorRegistry.errors, contractsHttpErrorRegistry.errors[0]!]),
    ).toThrow(/duplicate error code/);
    const reconstructed = createErrorRegistry(
      contractsHttpErrorRegistry.errors.map((error) => ({ ...error })),
    );
    expect(() => assertContractsIdentity(reconstructed)).toThrow(/contracts-owned/);
  });

  it("rejects conflicting operation status metadata", () => {
    const first = defineOperation({
      key: "authority.first",
      route: "/v1/authority/first",
      method: "POST",
      cliName: "authority-first",
      scope: "authority:first",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      errors: [defineError({ code: "authority_conflict", status: 400, details: z.strictObject({}) })],
      streaming: "none",
      strictness: "strict",
    });
    const second = defineOperation({
      key: "authority.second",
      route: "/v1/authority/second",
      method: "POST",
      cliName: "authority-second",
      scope: "authority:second",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      errors: [defineError({ code: "authority_conflict", status: 409, details: z.strictObject({}) })],
      streaming: "none",
      strictness: "strict",
    });
    expect(() => createOperationRegistry([first, second])).toThrow(/conflicting operation error status/);
  });

  it("feeds OpenAPI from the same contracts object without changing the accepted digest", () => {
    const document = generateOpenApiDocument(publicOperationRegistry, contractsHttpErrorRegistry);
    const checkedDigest = createHash("sha256")
      .update(readFileSync(new URL("../../../docs/openapi.json", import.meta.url)))
      .digest("hex");
    expect(Object.keys(document.paths)).toHaveLength(25);
    expect(Object.keys(document.components.schemas)).toHaveLength(106);
    expect(checkedDigest).toBe("ff9c2286e461c0402857e51f727d1fc36ae7f4cb0037308de76ba4ef7e4483ac");
  });
});
