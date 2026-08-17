import { z } from "zod";

/** The inclusive Hermes allocation for Agent Mail. */
export const HERMES_PORT_RANGE = Object.freeze({ min: 6110, max: 6119 });

export const portRoleSchema = z.enum([
  "productionService",
  "mockImap",
  "apiIntegration",
  "browserPreview",
  "destructiveLiveHarness",
]);

const portNumberSchema = z.number().int().min(HERMES_PORT_RANGE.min).max(HERMES_PORT_RANGE.max);

/** Data-only role assignments. Binding and leasing belong to runtime adapters. */
export const portRoleConfigSchema = z
  .strictObject({
    productionService: portNumberSchema,
    mockImap: portNumberSchema,
    apiIntegration: portNumberSchema,
    browserPreview: portNumberSchema,
    destructiveLiveHarness: portNumberSchema,
  })
  .superRefine((config, context) => {
    const assignments = Object.entries(config);
    const seen = new Map<number, string>();
    for (const [role, port] of assignments) {
      const previousRole = seen.get(port);
      if (previousRole !== undefined) {
        context.addIssue({
          code: "custom",
          path: [role],
          message: `port ${port} is already assigned to ${previousRole}`,
        });
      } else {
        seen.set(port, role);
      }
    }
  });

export type PortRole = z.infer<typeof portRoleSchema>;
export type PortRoleConfig = Readonly<z.infer<typeof portRoleConfigSchema>>;

export const PORT_ROLES: PortRoleConfig = Object.freeze(
  portRoleConfigSchema.parse({
    productionService: 6110,
    mockImap: 6111,
    apiIntegration: 6112,
    browserPreview: 6113,
    destructiveLiveHarness: 6117,
  }),
);
