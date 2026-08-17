import { describe, expect, test } from "bun:test";
import { HERMES_PORT_RANGE, PORT_ROLES, portRoleConfigSchema } from "./ports";

describe("root Hermes port-role configuration", () => {
  test("contains every required role with distinct in-range ports", () => {
    expect(PORT_ROLES).toEqual({
      productionService: 6110,
      mockImap: 6111,
      apiIntegration: 6112,
      browserPreview: 6113,
      destructiveLiveHarness: 6117,
    });
    const ports = Object.values(PORT_ROLES);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.every((port) => port >= HERMES_PORT_RANGE.min)).toBe(true);
    expect(ports.every((port) => port <= HERMES_PORT_RANGE.max)).toBe(true);
  });

  test("rejects a duplicate mock IMAP and API integration port", () => {
    const duplicate = { ...PORT_ROLES, apiIntegration: PORT_ROLES.mockImap };
    expect(portRoleConfigSchema.safeParse(duplicate).success).toBe(false);
  });

  test("rejects missing roles and ports outside the Hermes range", () => {
    const missing = { ...PORT_ROLES };
    delete (missing as Partial<typeof PORT_ROLES>).browserPreview;
    expect(portRoleConfigSchema.safeParse(missing).success).toBe(false);
    expect(
      portRoleConfigSchema.safeParse({ ...PORT_ROLES, mockImap: HERMES_PORT_RANGE.max + 1 })
        .success,
    ).toBe(false);
  });
});
