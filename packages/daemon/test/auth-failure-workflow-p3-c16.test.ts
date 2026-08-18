import { describe, expect, test } from "bun:test";
import { fromPromise } from "xstate";
import fixtures from "../../imap/test/fixtures/auth-failure-production-labeled.json";
import { classifyImapAuthenticationFailure } from "../../imap/src/auth-failure-classifier";
import {
  createSyncLifecycleActor,
  projectSyncStatus,
} from "../src/sync-statechart";

const configuration = {
  retryBaseMs: 1,
  retryCapMs: 1,
  retryJitterRatio: 0,
  maxRetryAttempts: 3,
  periodicStatusIntervalMs: 1,
  controlDeadlineMs: 1,
  controlResultRetentionMs: 1,
  maxControlIdempotencyEntries: 1,
  maxReleaseSlotEntries: 8,
} as const;

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

const waitForActor = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("P3-C16 captured authentication fault to workflow state", () => {
  test("enters authBlocked without retrying and retains no raw auth material", async () => {
    const captured = [
      fixtures.authenticationFailure,
      fixtures.authorizationFailure,
      fixtures.oauthFailure,
      fixtures.credentialTextFailure,
      fixtures.responseOnlyFailure,
      fixtures.invalidPasswordWithNetworkCode,
    ] as const;

    for (const [index, error] of captured.entries()) {
      const bootstrapSession = fromPromise(async () => {
        const fault = classifyImapAuthenticationFailure(error, {
          account: "agent-mail@example.com",
        });
        if (fault === null) throw new Error("captured fixture was not classified as authentication");
        throw fault;
      });
      const actor = createSyncLifecycleActor(
        {
          configuration,
          initialCheckpoint: checkpoint,
          initialCredentialRevision: 0,
          incarnationId: `incarnation:auth-${index}`,
        },
        { bootstrapSession },
      );

      actor.start();
      actor.send({ type: "control.start.requested", commandId: `auth-${index}` });
      await waitForActor();

      const snapshot = actor.getSnapshot();
      const status = projectSyncStatus(snapshot);
      expect(snapshot.matches("authBlocked")).toBe(true);
      expect(snapshot.context.retryAttempt).toBe(0);
      expect(snapshot.children).toEqual({});
      expect(status).toMatchObject({
        actorState: "authBlocked",
        activeOperation: null,
        authBlocked: {
          reason: "provider-rejected",
          detail: "Credentials were rejected.",
        },
      });
      const serialized = JSON.stringify({ status, diagnostics: snapshot.context.diagnostics });
      expect(serialized).not.toContain("fixture-secret");
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("password=");
      expect(serialized).not.toContain("authorization:");
      actor.stop();
    }
  });
});
