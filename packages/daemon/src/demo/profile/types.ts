import { z } from "zod";

export const DEMO_PROFILE_MARKER_NAME = ".agent-mail-demo-owner.json";
export const DEMO_PROFILE_VERSION = 1 as const;

export const demoProfileMarkerSchema = z.strictObject({
  version: z.literal(DEMO_PROFILE_VERSION),
  kind: z.literal("agent-mail-disposable-demo"),
  root: z.string().min(1).max(4096),
  ownerToken: z.uuid(),
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1).max(512),
  createdAt: z.iso.datetime({ offset: true }),
});

export type DemoProfileMarker = z.infer<typeof demoProfileMarkerSchema>;

export type DemoProfile = Readonly<{
  readonly root: string;
  readonly markerPath: string;
  readonly marker: DemoProfileMarker;
}>;

export type DemoProfileOptions = Readonly<{
  readonly root?: unknown;
}>;
