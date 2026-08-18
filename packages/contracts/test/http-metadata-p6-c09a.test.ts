import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createOperationRegistry,
  defineOperation,
  type OperationDefinition,
} from "../src/operation-registry";
import { defineError } from "../src/error-envelope";
import { httpErrorRegistry, publicOperationRegistry } from "../../daemon/src/http";

const expectedMethods = {
  "messages.search": "POST",
  "messages.get": "GET",
  "threads.get": "POST",
  "messages.raw": "GET",
  "attachments.get": "GET",
  "routing.preview": "POST",
  "routing.commit": "POST",
  "messages.label": "POST",
  "action-plans.create": "POST",
  "action-plans.inspect": "GET",
  "operator-sessions.create": "POST",
  "action-plans.approve": "POST",
  "action-plans.cancel-approval": "DELETE",
  "action-plans.commit": "POST",
  "reports.create": "POST",
  "exports.selected": "POST",
  "admin.backup": "POST",
  "admin.restore": "POST",
  "admin.doctor": "POST",
  "admin.reindex": "POST",
  "sync.status": "GET",
  "sync.start": "POST",
  "sync.pause": "POST",
  "sync.resume": "POST",
  "sync.stop": "POST",
} as const satisfies Readonly<Record<string, "GET" | "POST" | "DELETE">>;

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

const expectedOperationErrors = {
  "messages.search": ["invalid_query", "invalid_cursor"],
  "messages.get": ["not_found"],
  "threads.get": ["invalid_cursor", "not_found"],
  "messages.raw": ["not_found"],
  "attachments.get": ["not_found"],
  "routing.preview": [],
  "routing.commit": [],
  "messages.label": [],
  "action-plans.create": [],
  "action-plans.inspect": [],
  "operator-sessions.create": [],
  "action-plans.approve": [],
  "action-plans.cancel-approval": [],
  "action-plans.commit": [],
  "reports.create": [],
  "exports.selected": [],
  "admin.backup": [],
  "admin.restore": [],
  "admin.doctor": [],
  "admin.reindex": [],
  "sync.status": [],
  "sync.start": [
    "sync.control-rejected",
    "sync.control-failed",
    "sync.control-cancelled",
    "sync.control-timeout",
  ],
  "sync.pause": [
    "sync.control-rejected",
    "sync.control-failed",
    "sync.control-cancelled",
    "sync.control-timeout",
    "sync.control-idempotency-conflict",
    "sync.control-capacity",
  ],
  "sync.resume": [
    "sync.control-rejected",
    "sync.control-failed",
    "sync.control-cancelled",
    "sync.control-timeout",
    "sync.control-idempotency-conflict",
    "sync.control-capacity",
  ],
  "sync.stop": [
    "sync.control-rejected",
    "sync.control-failed",
    "sync.control-cancelled",
    "sync.control-timeout",
    "sync.control-idempotency-conflict",
    "sync.control-capacity",
  ],
} as const;

describe("P6-C09A HTTP metadata authorities", () => {
  it("freezes the complete 25-operation method matrix", () => {
    expect(publicOperationRegistry.operations).toHaveLength(25);
    expect(Object.fromEntries(publicOperationRegistry.operations.map(({ key, method }) => [key, method]))).toEqual(
      expectedMethods,
    );
    expect(publicOperationRegistry.get("action-plans.cancel-approval")?.method).toBe("DELETE");
    expect(
      Object.fromEntries(
        publicOperationRegistry.operations.map(({ key, errors }) => [
          key,
          errors.map(({ code }) => code),
        ]),
      ),
    ).toEqual(expectedOperationErrors);
  });

  it("freezes one status for each registered public error", () => {
    expect(httpErrorRegistry.errors).toHaveLength(26);
    expect(Object.fromEntries(httpErrorRegistry.errors.map(({ code, status }) => [code, status]))).toEqual(
      expectedStatuses,
    );
    expect(new Set(httpErrorRegistry.errors.map(({ code }) => code)).size).toBe(26);
    expect(httpErrorRegistry.get("request_too_large")?.status).toBe(413);
  });

  it("scopes duplicate feature codes to an operation while retaining exact statuses", () => {
    const firstError = defineError({
      code: "adjacent_duplicate",
      status: 400,
      details: z.strictObject({ resource: z.literal("first") }),
    });
    const secondError = defineError({
      code: "adjacent_duplicate",
      status: 400,
      details: z.strictObject({ resource: z.literal("second") }),
    });
    const first = defineOperation({
      key: "adjacent.first",
      route: "/v1/adjacent/first",
      method: "POST",
      cliName: "adjacent-first",
      scope: "adjacent:first",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      errors: [firstError],
      streaming: "none",
      strictness: "strict",
    });
    const second = defineOperation({
      key: "adjacent.second",
      route: "/v1/adjacent/second",
      method: "POST",
      cliName: "adjacent-second",
      scope: "adjacent:second",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      errors: [secondError],
      streaming: "none",
      strictness: "strict",
    });
    expect(createOperationRegistry([first, second]).metadata.map(({ errors }) => errors[0]?.status)).toEqual([
      400,
      400,
    ]);
    const conflictingStatusOperation = defineOperation({
      ...second,
      key: "adjacent.conflicting-status",
      route: "/v1/adjacent/conflicting-status",
      cliName: "adjacent-conflicting-status",
      scope: "adjacent:conflicting-status",
      errors: [
        defineError({
          code: "adjacent_duplicate",
          status: 409,
          details: z.strictObject({ resource: z.literal("conflict") }),
        }),
      ],
    });
    expect(() => createOperationRegistry([first, conflictingStatusOperation])).toThrow(
      /conflicting operation error status/,
    );
    expect(() =>
      defineOperation({
        ...first,
        key: "adjacent.duplicate",
        route: "/v1/adjacent/duplicate",
        cliName: "adjacent-duplicate",
        scope: "adjacent:duplicate",
        errors: [firstError, firstError],
      }),
    ).toThrow(/duplicate error code/);

    const unknownErrorMetadata = Object.assign(
      { code: "adjacent_unknown", status: 400, details: z.strictObject({}) },
      { unexpected: true },
    );
    expect(() =>
      defineOperation({
        ...first,
        key: "adjacent.unknown-error-metadata",
        route: "/v1/adjacent/unknown-error-metadata",
        cliName: "adjacent-unknown-error-metadata",
        scope: "adjacent:unknown-error-metadata",
        errors: [unknownErrorMetadata] as never,
      }),
    ).toThrow(/unknown metadata/);
    expect(() =>
      defineOperation({
        ...first,
        key: "adjacent.invalid-error-status",
        route: "/v1/adjacent/invalid-error-status",
        cliName: "adjacent-invalid-error-status",
        scope: "adjacent:invalid-error-status",
        errors: [{ code: "adjacent_invalid", status: 418, details: z.strictObject({}) }] as never,
      }),
    ).toThrow();
    expect(() =>
      defineOperation({
        ...first,
        key: "adjacent.missing-error-status",
        route: "/v1/adjacent/missing-error-status",
        cliName: "adjacent-missing-error-status",
        scope: "adjacent:missing-error-status",
        errors: [{ code: "adjacent_missing", details: z.strictObject({}) }] as never,
      }),
    ).toThrow();
  });

  it("rejects missing, duplicate, and unknown operation metadata at construction boundaries", () => {
    const missingMethod = {
      key: "synthetic.missing-method",
      route: "/v1/synthetic/missing-method",
      cliName: "synthetic-missing-method",
      scope: "synthetic:test",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      streaming: "none",
      strictness: "strict" as const,
    };
    expect(() => defineOperation(missingMethod as never)).toThrow(/invalid/);

    const complete = defineOperation({
      key: "synthetic.complete",
      route: "/v1/synthetic/complete",
      method: "POST",
      cliName: "synthetic-complete",
      scope: "synthetic:test",
      request: z.strictObject({}),
      response: z.strictObject({ ok: z.literal(true) }),
      streaming: "none",
      strictness: "strict",
    });
    expect(() => createOperationRegistry([complete, complete])).toThrow(/duplicate operation key/);

    const unknownMetadata = Object.assign(
      {
        key: "synthetic.unknown-metadata",
        route: "/v1/synthetic/unknown-metadata",
        method: "POST" as const,
        cliName: "synthetic-unknown-metadata",
        scope: "synthetic:test",
        request: z.strictObject({}),
        response: z.strictObject({ ok: z.literal(true) }),
        streaming: "none" as const,
        strictness: "strict" as const,
      },
      { unexpected: true },
    );
    expect(() => defineOperation(unknownMetadata)).toThrow(/unknown metadata/);
  });
});
