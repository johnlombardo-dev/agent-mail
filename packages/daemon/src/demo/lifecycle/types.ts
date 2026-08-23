import { z } from "zod";
import type { DemoCompositionReady, DemoCompositionSnapshot } from "../composition";
import type { DemoProfileOptions } from "../profile";

export const demoLifecycleStateSchema = z.enum([
  "absent",
  "generating",
  "startingImap",
  "startingDaemon",
  "syncing",
  "ready",
  "stopping",
  "resetting",
  "failed",
]);

export type DemoLifecycleState = z.infer<typeof demoLifecycleStateSchema>;

export type DemoLifecycleDiagnostic = Readonly<{
  readonly code:
    | "demo.generate"
    | "demo.imap"
    | "demo.daemon"
    | "demo.sync"
    | "demo.cleanup"
    | "demo.deadline";
  readonly message: string;
}>;

export type DemoLifecycleStatus = Readonly<{
  readonly state: DemoLifecycleState;
  readonly ready: boolean;
  readonly root: string | null;
  readonly baseUrl: string | null;
  readonly diagnostic: DemoLifecycleDiagnostic | null;
  readonly resources: DemoCompositionSnapshot;
}>;

export type DemoLifecycleSupervisor = Readonly<{
  readonly start: () => Promise<DemoCompositionReady>;
  readonly status: () => DemoLifecycleStatus;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly shutdown: (signal: string) => Promise<void>;
}>;

export type DemoLifecycleOptions = DemoProfileOptions;

export class DemoLifecycleError extends Error {
  readonly diagnostic: DemoLifecycleDiagnostic;

  constructor(diagnostic: DemoLifecycleDiagnostic) {
    super(diagnostic.message);
    this.name = "DemoLifecycleError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}
