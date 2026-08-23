import { describe, expect, test } from "bun:test";
import {
  derivePrivatePaths,
  DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES,
  parseStartupConfig,
  safeParseStartupConfig,
  startupConfigSchema,
  startupConfigErrorMessages,
} from "../src/config.ts";

const fixture = {
  privateRoot: "/tmp/agent-mail-private",
  paths: {
    data: "/tmp/agent-mail-private/data",
    blob: "/tmp/agent-mail-private/blobs",
    journal: "/tmp/agent-mail-private/journal",
    backup: "/tmp/agent-mail-private/backups",
    runtime: "/tmp/agent-mail-private/runtime",
  },
  secretFile: {
    path: "/tmp/agent-mail-private/secrets/api-token",
    mode: 0o600,
  },
  ports: {
    productionService: 6110,
    mockImap: 6111,
    apiIntegration: 6112,
    browserPreview: 6113,
    destructiveLiveHarness: 6117,
    demoService: 6119,
  },
} as const;

describe("startup configuration", () => {
  test("round-trips a complete valid fixture and derives private paths", () => {
    const parsed = parseStartupConfig(fixture);
    expect(parsed.privateRoot).toBe(fixture.privateRoot);
    expect(parsed.paths).toEqual(fixture.paths);
    expect(parsed.secretFile).toEqual(fixture.secretFile);
    expect(parsed.http.maxRequestBodyBytes).toBe(DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES);
    expect(parsed.ports).toEqual(fixture.ports);
    expect(parseStartupConfig(parsed)).toEqual(parsed);
    expect(startupConfigSchema.parse(fixture)).toEqual(parsed);
    expect(derivePrivatePaths(fixture.privateRoot)).toEqual(fixture.paths);
  });

  test("accepts a positive bounded HTTP body limit and rejects an unsafe value", () => {
    const configured = parseStartupConfig({
      ...fixture,
      http: { maxRequestBodyBytes: 2 * 1024 * 1024 },
    });
    expect(configured.http.maxRequestBodyBytes).toBe(2 * 1024 * 1024);
    expect(safeParseStartupConfig({ ...fixture, http: { maxRequestBodyBytes: 0 } }).success).toBe(
      false,
    );
    expect(safeParseStartupConfig({ ...fixture, http: { maxRequestBodyBytes: 100 * 1024 * 1024 + 1 } }).success).toBe(
      false,
    );
  });

  test("rejects unknown keys with a stable safe error", () => {
    const result = safeParseStartupConfig({ ...fixture, secret: "do-not-log" });
    expect(result).toEqual({
      success: false,
      error: { code: "unknownKey", message: startupConfigErrorMessages.unknownKey },
    });
  });

  test("rejects relative and traversal roots without normalizing them", () => {
    expect(safeParseStartupConfig({ ...fixture, privateRoot: "./private" }).success).toBe(false);
    expect(safeParseStartupConfig({ ...fixture, privateRoot: "/" }).success).toBe(false);
    expect(
      safeParseStartupConfig({
        ...fixture,
        privateRoot: "/tmp/agent-mail-private/../other-project",
      }),
    ).toEqual({
      success: false,
      error: { code: "unsafePath", message: startupConfigErrorMessages.unsafePath },
    });
  });

  test("rejects path overrides outside the derived private tree", () => {
    const result = safeParseStartupConfig({
      ...fixture,
      paths: { ...fixture.paths, data: "/tmp/other-project/data" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects relative and traversal path metadata", () => {
    expect(
      safeParseStartupConfig({
        ...fixture,
        paths: { ...fixture.paths, data: "./data" },
      }),
    ).toEqual({
      success: false,
      error: { code: "unsafePath", message: startupConfigErrorMessages.unsafePath },
    });
    expect(
      safeParseStartupConfig({
        ...fixture,
        secretFile: {
          ...fixture.secretFile,
          path: "/tmp/agent-mail-private/secrets/../other-secret",
        },
      }),
    ).toEqual({
      success: false,
      error: { code: "unsafePath", message: startupConfigErrorMessages.unsafePath },
    });
  });

  test("rejects world-readable secret metadata", () => {
    const result = safeParseStartupConfig({
      ...fixture,
      secretFile: { ...fixture.secretFile, mode: 0o644 },
    });
    expect(result).toEqual({
      success: false,
      error: { code: "secretPermissions", message: startupConfigErrorMessages.secretPermissions },
    });
  });

  test("rejects a port that is in range but not assigned to its role", () => {
    const result = safeParseStartupConfig({
      ...fixture,
      ports: { ...fixture.ports, productionService: 6118 },
    });
    expect(result).toEqual({
      success: false,
      error: { code: "portAssignment", message: startupConfigErrorMessages.portAssignment },
    });
  });
});
