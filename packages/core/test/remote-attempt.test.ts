import { describe, expect, it } from "bun:test";
import {
  createRemoteAttempt,
  createRemoteAttemptResult,
  parseRemoteAttempt,
  parseRemoteAttemptResult,
  serializeRemoteAttempt,
  serializeRemoteAttemptResult,
} from "../src/remote-attempt";

const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 42,
  uid: 7,
  precondition: { modseq: 12 },
} as const;

const attempt = {
  kind: "attempt",
  planId: "plan:one",
  action: { kind: "markSeen" },
  target,
  attemptId: "attempt:one",
  idempotencyKey: "idempotency:one",
  startedAt: "2026-08-18T00:01:00.000Z",
  certainty: "unresolved",
} as const;

const resultBase = {
  planId: attempt.planId,
  action: attempt.action,
  target: attempt.target,
  attemptId: attempt.attemptId,
  idempotencyKey: attempt.idempotencyKey,
  startedAt: attempt.startedAt,
  resultAt: "2026-08-18T00:02:00.000Z",
} as const;

const postcondition = {
  kind: "flags",
  observedAt: "2026-08-18T00:01:30.000Z",
  flags: ["\\Seen"],
  modseq: 13,
} as const;

describe("remote attempt and result algebra", () => {
  it("round-trips every result while retaining recovery-critical fields", () => {
    const values = [
      {
        ...resultBase,
        kind: "success",
        certainty: "definite",
        postcondition,
      },
      {
        ...resultBase,
        kind: "stale",
        certainty: "definite",
        detail: "server MODSEQ no longer matches the frozen precondition",
      },
      {
        ...resultBase,
        kind: "rejected",
        certainty: "definite",
        detail: "operator confirmation was not present",
      },
      {
        ...resultBase,
        kind: "failed",
        certainty: "definite",
        failureReason: "server-rejected",
        detail: "server rejected the requested mutation",
      },
      {
        ...resultBase,
        kind: "uncertain",
        certainty: "uncertain",
        uncertainReason: "socket-timeout-after-transmission",
        detail: "the command was sent before the socket timed out",
      },
    ] as const;

    for (const value of values) {
      const parsed = createRemoteAttemptResult(value);
      const roundTrip = parseRemoteAttemptResult(
        JSON.parse(JSON.stringify(serializeRemoteAttemptResult(parsed))),
      );
      expect(roundTrip).toEqual(parsed);
      expect(roundTrip.planId).toBe(attempt.planId);
      expect(roundTrip.attemptId).toBe(attempt.attemptId);
      expect(roundTrip.idempotencyKey).toBe(attempt.idempotencyKey);
      expect(roundTrip.target).toEqual(target);
      expect(roundTrip.target.precondition).toEqual(target.precondition);
      expect(roundTrip.certainty).toBe(value.certainty);
    }
  });

  it("round-trips an immutable attempt and clones its target snapshot", () => {
    const parsed = createRemoteAttempt(attempt);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.target)).toBe(true);
    expect(Object.isFrozen(parsed.target.precondition)).toBe(true);
    expect(parseRemoteAttempt(JSON.parse(JSON.stringify(serializeRemoteAttempt(parsed))))).toEqual(
      parsed,
    );
  });

  it("requires a server-observed postcondition for success", () => {
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "success",
        certainty: "definite",
      }),
    ).toThrow();
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "success",
        certainty: "definite",
        postcondition: { kind: "mailbox", observedAt: resultBase.resultAt },
      }),
    ).toThrow();
  });

  it("requires a chronologically valid and action-consistent postcondition", () => {
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "success",
        certainty: "definite",
        postcondition: { ...postcondition, observedAt: "2026-08-17T23:59:00.000Z" },
      }),
    ).toThrow();
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "success",
        certainty: "definite",
        postcondition: { ...postcondition, flags: ["\\Answered"] },
      }),
    ).toThrow();
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        action: { kind: "markUnseen" },
        kind: "success",
        certainty: "definite",
        postcondition,
      }),
    ).toThrow();
  });

  it("rejects missing identities, preconditions, and contradictory fields", () => {
    const missingIdentity = {
      ...resultBase,
      kind: "stale",
      certainty: "definite",
      detail: "stale",
    };
    const { attemptId: _attemptId, ...withoutAttemptId } = missingIdentity;
    expect(() => createRemoteAttemptResult(withoutAttemptId)).toThrow();

    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "uncertain",
        certainty: "definite",
        uncertainReason: "local-result-not-durable",
        detail: "local result was not durable",
      }),
    ).toThrow();
    expect(() =>
      createRemoteAttemptResult({
        ...resultBase,
        kind: "success",
        certainty: "definite",
        postcondition: { ...postcondition, kind: "mailbox", mailboxId: "mailbox:archive" },
      }),
    ).toThrow();
    expect(() =>
      createRemoteAttempt({ ...attempt, target: { ...target, precondition: undefined } }),
    ).toThrow();
  });

  it("keeps a transmitted socket timeout uncertain and not definite failure", () => {
    const uncertain = createRemoteAttemptResult({
      ...resultBase,
      kind: "uncertain",
      certainty: "uncertain",
      uncertainReason: "socket-timeout-after-transmission",
      detail: "command transmitted; response was not durably confirmed",
    });
    expect(uncertain.kind).toBe("uncertain");
    for (const detail of [
      "socket-timeout-after-transmission",
      "request timed out after send",
      "connection lost after command was transmitted",
    ]) {
      expect(() =>
        createRemoteAttemptResult({
          ...resultBase,
          kind: "failed",
          certainty: "definite",
          failureReason: "server-rejected",
          detail,
        }),
      ).toThrow();
    }
  });

  it("does not expose credential or token material in operator detail", () => {
    for (const detail of [
      "password=secret-value",
      "bearer token abc123",
      "Authorization: Bearer abc123",
      "imap://user:pass@example.test/Inbox",
    ]) {
      expect(() =>
        createRemoteAttemptResult({
          ...resultBase,
          kind: "stale",
          certainty: "definite",
          detail,
        }),
      ).toThrow();
    }
  });
});
