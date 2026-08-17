import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createErrorRegistry,
  defineError,
  publicErrorEnvelopeSchema,
  toPublicErrorEnvelope,
} from "../src/error-envelope";

const registry = createErrorRegistry([
  defineError({
    code: "not-found",
    details: z.strictObject({ resource: z.string() }),
  }),
  defineError({
    code: "invalid-query",
    details: z.strictObject({ field: z.string(), reason: z.string() }),
  }),
] as const);

describe("public error envelope", () => {
  it("supports registering errors incrementally", () => {
    const empty = createErrorRegistry([] as const);
    expect(empty.codes).toEqual([]);
    expect(empty.get("future-error")).toBeUndefined();
  });

  it("parses only registered, strict, safe envelopes", () => {
    const envelope = registry.parse({
      code: "not-found",
      message: "Message was not found",
      correlationId: "corr-123",
      details: { resource: "message" },
    });
    expect(envelope).toEqual({
      code: "not-found",
      message: "Message was not found",
      correlationId: "corr-123",
      details: { resource: "message" },
    });
    expect(registry.safeParse(envelope).success).toBe(true);
    expect(() => registry.parse({ ...envelope, extra: true })).toThrow();
    expect(() =>
      registry.parse({ ...envelope, details: { resource: "message", stack: "secret" } }),
    ).toThrow();
    expect(() => registry.parse({ ...envelope, code: "unregistered" })).toThrow();
    expect(() =>
      registry.parse({ ...envelope, details: { resource: "message", cause: "secret" } }),
    ).toThrow();
    expect(() =>
      registry.parse({ ...envelope, details: { resource: "message", raw_mail: "raw" } }),
    ).toThrow();
    expect(() =>
      registry.parse({ ...envelope, details: { resource: "message", extra: true } }),
    ).toThrow();
    expect(() =>
      registry.parse({
        ...envelope,
        details: { resource: "message", context: { stack: "private stack" } },
      }),
    ).toThrow();
  });

  it("rejects internal fields and raw mail at the public schema boundary", () => {
    const valid = {
      code: "not-found",
      message: "Message was not found",
      correlationId: "corr-123",
      details: { resource: "message" },
    };
    expect(() => publicErrorEnvelopeSchema.parse({ ...valid, stack: "private stack" })).toThrow();
    expect(() => publicErrorEnvelopeSchema.parse({ ...valid, credentials: "bearer" })).toThrow();
    expect(() =>
      publicErrorEnvelopeSchema.parse({ ...valid, rawMail: "From: attacker@example.com" }),
    ).toThrow();
    expect(() =>
      publicErrorEnvelopeSchema.parse({ ...valid, cause: new Error("private") }),
    ).toThrow();
  });

  it("projects internal errors without serializing stack, credentials, raw mail, or cause", () => {
    const publicEnvelope = toPublicErrorEnvelope(
      {
        code: "not-found",
        message: "Message was not found",
        correlationId: "corr-123",
        details: { resource: "message" },
        stack: "private stack",
        credentials: "bearer",
        rawMail: "From: attacker@example.com",
        cause: new Error("private"),
      },
      registry,
    );
    const serialized = JSON.stringify(publicEnvelope);
    expect(serialized).not.toContain("private stack");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("attacker@example.com");
    expect(serialized).not.toContain("private");
    expect(publicEnvelope).toEqual({
      code: "not-found",
      message: "Message was not found",
      correlationId: "corr-123",
      details: { resource: "message" },
    });
  });

  it("rejects duplicate registered error codes", () => {
    expect(() =>
      createErrorRegistry([
        defineError({ code: "same-code", details: z.strictObject({}) }),
        defineError({ code: "same-code", details: z.strictObject({}) }),
      ]),
    ).toThrow(/duplicate error code/);
  });
});
