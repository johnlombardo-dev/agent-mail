import { z } from "zod";
import {
  defineOperation,
  parseErrorDefinition,
  publicErrorEnvelopeSchema,
  retrievalInstantSchema,
  streamMetadataSchema,
  threadRequestSchema,
  threadSuccessResponseSchema,
  utcInstantSchema,
  validateThreadSuccess,
} from "../src/index";
import { cliCommandRegistry, publicCliOperations } from "../../cli/src/command-registry";
import { publicOperationDefinitions } from "../../daemon/src/http";
import {
  assertCorpusComplete,
  operationCorpus,
  parseNdjsonRecord,
  parseByteStreamMetadata,
  parseStreamMetadata,
} from "./operation-corpus";

const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("public operation corpus", () => {
  it("proves completeness before parsing and covers the exact CLI registry", () => {
    assertCorpusComplete(publicOperationDefinitions, operationCorpus);
    expect(Object.keys(operationCorpus)).toHaveLength(25);
    expect(publicOperationDefinitions).toHaveLength(25);
    expect(cliCommandRegistry.commands.map(({ operationKey }) => operationKey)).toEqual(
      publicCliOperations.map(({ key }) => key),
    );
  });

  it("round-trips every request, success, applicable error, and stream through shared schemas", () => {
    assertCorpusComplete(publicOperationDefinitions, operationCorpus);
    for (const operation of publicOperationDefinitions) {
      const entry = operationCorpus[operation.key];
      if (entry === undefined) throw new Error(`missing corpus entry for ${operation.key}`);
      const requests = [entry.request, ...(entry.requestVariants ?? [])];
      for (const request of requests) {
        const requestCanonical = operation.request.parse(request);
        expect(operation.request.parse(jsonRoundTrip(requestCanonical))).toEqual(requestCanonical);
      }

      const successVariants = [entry.success, ...(entry.successVariants ?? [])];
      for (const success of successVariants) {
        const responseCanonical = operation.response.parse(success);
        expect(operation.response.parse(jsonRoundTrip(responseCanonical))).toEqual(responseCanonical);
      }
      for (const error of entry.errors) {
        const definition = operation.errors.find(({ code }) => code === error.code);
        if (definition === undefined) throw new Error(`missing error definition for ${error.code}`);
        const errorCanonical = parseErrorDefinition(definition, error.response);
        expect(parseErrorDefinition(definition, jsonRoundTrip(errorCanonical))).toEqual(errorCanonical);
      }

      if (entry.stream !== undefined) {
        const parseMetadata = operation.key === "exports.selected" ? parseByteStreamMetadata : parseStreamMetadata;
        const metadataCanonical = parseMetadata(entry.stream);
        expect(parseMetadata({ metadata: jsonRoundTrip(metadataCanonical) })).toEqual(
          metadataCanonical,
        );
        if (operation.streaming === "ndjson") {
          const recordCanonical = parseNdjsonRecord(entry.stream);
          expect(
            parseNdjsonRecord({ metadata: entry.stream.metadata, ndjsonRecord: jsonRoundTrip(recordCanonical) }),
          ).toEqual(recordCanonical);
        }
      }
    }

    const threadEntry = operationCorpus["threads.get"];
    if (threadEntry === undefined) throw new Error("threads.get corpus fixture is missing");
    const continuationFixture = threadEntry.requestVariants?.[0];
    const emptyFixture = threadEntry.successVariants?.[1];
    if (continuationFixture === undefined || emptyFixture === undefined)
      throw new Error("threads.get empty continuation fixtures are missing");
    expect(
      validateThreadSuccess(
        threadRequestSchema.parse(continuationFixture),
        threadSuccessResponseSchema.parse(emptyFixture),
      ),
    ).toEqual(emptyFixture);
  });

  it("fails completeness for an adjacent operation without a success fixture", () => {
    const adjacentOperation = defineOperation({
      key: "adjacent.missing-success",
      route: "/v1/adjacent/missing-success",
      method: "POST",
      cliName: "adjacent-missing-success",
      scope: "adjacent:test",
      request: z.strictObject({ value: z.string() }),
      response: z.strictObject({ accepted: z.literal(true) }),
      streaming: "none",
      strictness: "strict",
    });
    const adjacentCorpus = {
      ...operationCorpus,
      [adjacentOperation.key]: { request: { value: "unused" }, errors: [] },
    };
    expect(() => assertCorpusComplete([...publicCliOperations, adjacentOperation], adjacentCorpus)).toThrow(
      /adjacent\.missing-success missing success fixture/,
    );
  });

  it("rejects unknown fields at every strict request and response root", () => {
    assertCorpusComplete(publicOperationDefinitions, operationCorpus);
    for (const operation of publicOperationDefinitions) {
      const entry = operationCorpus[operation.key];
      if (entry === undefined) throw new Error(`missing corpus entry for ${operation.key}`);
      expect(() => operation.request.parse({ ...(entry.request as Record<string, unknown>), unknownField: true })).toThrow();
      expect(() => operation.response.parse({ ...(entry.success as Record<string, unknown>), unknownField: true })).toThrow();
    }
    expect(() => publicErrorEnvelopeSchema.parse({ code: "not_found", message: "x", correlationId: "x", details: {}, unknownField: true })).toThrow();
    expect(() => streamMetadataSchema.parse({ contentType: "x", contentLength: 0, digest: "0".repeat(64), filename: null, unknownField: true })).toThrow();
  });

  it("covers timezone boundaries and rejects timezone-less or non-canonical instants", () => {
    expect(retrievalInstantSchema.parse("2024-02-29T23:59:59.999+14:00")).toBe(
      "2024-02-29T23:59:59.999+14:00",
    );
    expect(() => retrievalInstantSchema.parse("2024-02-29T23:59:59.999")).toThrow();
    expect(utcInstantSchema.parse("2024-03-01T00:00:00.000Z")).toBe("2024-03-01T00:00:00.000Z");
    expect(() => utcInstantSchema.parse("2024-03-01T01:00:00.000+01:00")).toThrow();
  });

  it("retains Unicode and maximum safe identifiers and integers in canonical fixtures", () => {
    const search = operationCorpus["messages.search"];
    const action = operationCorpus["action-plans.create"];
    expect(JSON.stringify(search)).toContain("réunion");
    expect(JSON.stringify(action)).toContain("9007199254740991");
    expect(publicOperationDefinitions.find(({ key }) => key === "messages.get")?.errors.map(({ code }) => code)).toEqual([
      "not_found",
    ]);
    expect(publicOperationDefinitions.find(({ key }) => key === "messages.search")?.errors.map(({ code }) => code)).toEqual([
      "invalid_query",
      "invalid_cursor",
    ]);
  });

  it("rejects missing routing errors and status/detail drift", () => {
    const routing = operationCorpus["routing.commit"];
    if (routing === undefined) throw new Error("routing.commit corpus fixture is missing");
    const withoutTampered = {
      ...operationCorpus,
      "routing.commit": { ...routing, errors: routing.errors.slice(0, 2) },
    };
    expect(() => assertCorpusComplete(publicOperationDefinitions, withoutTampered)).toThrow(
      /routing\.commit has incorrect applicable error fixtures/,
    );

    const statusDrift = {
      ...operationCorpus,
      "routing.commit": {
        ...routing,
        errors: routing.errors.map((error) =>
          error.code === "routing.preview_replayed" ? { ...error, status: 400 } : error,
        ),
      },
    };
    expect(() => assertCorpusComplete(publicOperationDefinitions, statusDrift)).toThrow(
      /routing\.commit error routing\.preview_replayed has status 400; expected 409/,
    );

    const detailDrift = {
      ...operationCorpus,
      "routing.commit": {
        ...routing,
        errors: routing.errors.map((error) =>
          error.code === "routing.preview_tampered"
            ? {
                ...error,
                response: {
                  code: "routing.preview_tampered",
                  message: "routing preview authority does not match",
                  correlationId: "correlation:routing-preview-tampered-例",
                  details: { previewId: "preview:authority", digest: "a".repeat(64) },
                },
              }
            : error,
        ),
      },
    };
    expect(() => assertCorpusComplete(publicOperationDefinitions, detailDrift)).toThrow(
      /routing\.commit error routing\.preview_tampered has invalid response/,
    );
  });
});
