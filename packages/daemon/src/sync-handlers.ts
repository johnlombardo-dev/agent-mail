import {
  syncPauseRequestSchema,
  syncResumeRequestSchema,
  syncStartRequestSchema,
  syncStopRequestSchema,
  type SyncStatusResponse,
} from "@agent-mail/contracts";
import type { OperationHandler, OperationHandlerContext, OperationHandlerMap } from "./http";
import type { SyncControlActor, SyncControlService } from "./sync-control-service";
import { projectSyncStatus } from "./sync-statechart";

/** The actor observation used by the read-only status operation. */
export type SyncStatusReader = Pick<SyncControlActor, "getSnapshot">;

/** Dependencies shared by status and all four observed control operations. */
export type SyncHandlerServices = Readonly<{
  readonly actor: SyncStatusReader;
  readonly control: SyncControlService;
}>;

function commandId(context: OperationHandlerContext, command: string): string {
  // Correlation IDs are bounded by the shared error contract (200 characters),
  // keeping this derived lifecycle identity within the actor's 256-character
  // command-id boundary without trusting request body fields.
  return `http:${command}:${context.correlationId}`;
}

function statusHandler(services: SyncHandlerServices): OperationHandler {
  return (_input: unknown): SyncStatusResponse => projectSyncStatus(services.actor.getSnapshot());
}

function controlHandler(
  services: SyncHandlerServices,
  command: "start" | "pause" | "resume" | "stop",
): OperationHandler {
  return async (input: unknown, context: OperationHandlerContext) => {
    switch (command) {
      case "start": {
        syncStartRequestSchema.parse(input);
        return services.control.execute({
          command,
          commandId: commandId(context, command),
          correlationId: context.correlationId,
        });
      }
      case "pause": {
        const request = syncPauseRequestSchema.parse(input);
        return services.control.execute({
          command,
          commandId: commandId(context, command),
          correlationId: context.correlationId,
          idempotencyKey: request.idempotencyKey,
        });
      }
      case "resume": {
        const request = syncResumeRequestSchema.parse(input);
        return services.control.execute({
          command,
          commandId: commandId(context, command),
          correlationId: context.correlationId,
          idempotencyKey: request.idempotencyKey,
        });
      }
      case "stop": {
        const request = syncStopRequestSchema.parse(input);
        return services.control.execute({
          command,
          commandId: commandId(context, command),
          correlationId: context.correlationId,
          idempotencyKey: request.idempotencyKey,
        });
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  };
}

/**
 * Wire the registry-defined sync operations to one actor observation and the
 * actor-observed control service. The service, rather than a local route
 * boolean, is the sole owner of lifecycle command delivery and completion.
 */
export function createSyncHandlers(services: SyncHandlerServices): OperationHandlerMap {
  return Object.freeze({
    "sync.status": statusHandler(services),
    "sync.start": controlHandler(services, "start"),
    "sync.pause": controlHandler(services, "pause"),
    "sync.resume": controlHandler(services, "resume"),
    "sync.stop": controlHandler(services, "stop"),
  });
}
