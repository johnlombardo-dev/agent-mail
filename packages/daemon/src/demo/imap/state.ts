import type {
  DemoImapCommand,
  DemoImapFault,
  DemoImapFaultState,
  DemoImapSessionEvent,
  DemoImapSessionState,
} from "./types";

export class DemoImapTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoImapTransitionError";
  }
}

export function transitionDemoImapSession(
  state: DemoImapSessionState,
  event: DemoImapSessionEvent,
): DemoImapSessionState {
  if (event.kind === "connection-closed") return Object.freeze({ kind: "closed" });

  switch (state.kind) {
    case "not-authenticated":
      if (event.kind === "authentication-succeeded") {
        return Object.freeze({ kind: "authenticated" });
      }
      break;
    case "authenticated":
      if (event.kind === "mailbox-selected") {
        return Object.freeze({
          kind: "selected",
          mailbox: event.mailbox,
          readOnly: event.readOnly,
        });
      }
      break;
    case "selected":
      if (event.kind === "mailbox-selected") {
        return Object.freeze({
          kind: "selected",
          mailbox: event.mailbox,
          readOnly: event.readOnly,
        });
      }
      if (event.kind === "idle-started") {
        return Object.freeze({ ...state, kind: "idling", idleTag: event.idleTag });
      }
      if (event.kind === "mailbox-closed") return Object.freeze({ kind: "authenticated" });
      break;
    case "idling":
      if (event.kind === "idle-completed") {
        return Object.freeze({
          kind: "selected",
          mailbox: state.mailbox,
          readOnly: state.readOnly,
        });
      }
      break;
    case "closed":
      break;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }

  throw new DemoImapTransitionError(`invalid ${event.kind} transition from ${state.kind}`);
}

export function scheduleDemoImapFault(fault: DemoImapFault): DemoImapFaultState {
  return Object.freeze({ kind: "scheduled", fault });
}

export function beginDemoImapFault(
  state: DemoImapFaultState,
  command: DemoImapCommand,
): DemoImapFaultState {
  if (state.kind !== "scheduled") {
    throw new DemoImapTransitionError(`cannot begin a fault from ${state.kind}`);
  }
  return Object.freeze({ kind: "applying", fault: state.fault, command });
}

export function completeDemoImapFault(state: DemoImapFaultState): DemoImapFaultState {
  if (state.kind !== "applying") {
    throw new DemoImapTransitionError(`cannot complete a fault from ${state.kind}`);
  }
  return Object.freeze({ kind: "completed", fault: state.fault, command: state.command });
}
