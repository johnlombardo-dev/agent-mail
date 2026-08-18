import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DaemonOperatorPresenceIssueClient,
  OPERATOR_PRESENCE_PROTOCOL_VERSION,
  OperatorPresenceError,
  type OperatorPresenceChallenge,
} from "../src/operator-presence";
import { startOperatorPresenceIssueServer } from "../src/operator-presence-issue-server";
import { startOperatorAuthorityMutationServer } from "../src/operator-authority-mutation-server";
import type { OperatorPresenceRequest } from "../src/operator-presence";
import type { OperatorPresenceAuthority, OperatorSessionAuthority } from "../src/action-authority-auth";

const roots: string[] = [];
const authorityLock = {
  runShared: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
  runExclusive: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
};
const darwinLibc = dlopen("/usr/lib/libSystem.B.dylib", {
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

function shutdownWriteHalf(socket: import("node:net").Socket): void {
  const handle = Reflect.get(socket, "_handle");
  const fd = handle !== null && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined;
  if (typeof fd === "number" && darwinLibc.symbols.shutdown(fd, 1) === 0) return;
  socket.end();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon-owned operator presence issue socket", () => {
  test("returns only the frozen capacity and unsupported error registry entries", async () => {
    const runtime = join("/tmp", `am-error-registry-${process.pid}-${Date.now()}`);
    roots.push(runtime);
    await mkdir(runtime, { mode: 0o700 });
    const request = JSON.stringify({
      version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
      command: "issue",
      credentialId: `credential:operator:${"a".repeat(64)}`,
      operation: "open-session",
      requestMethod: "POST",
      requestPath: "/v1/operator-sessions",
      requestBodyBase64url: Buffer.from("{}").toString("base64url"),
    }) + "\n";
    const responseFor = async (
      code: "action.operator_challenge_capacity" | "action.operator_presence_unsupported",
    ): Promise<unknown> => {
      const authority = {
        currentBinding: async () => ({
          authorityInstanceId: "instance:00000000-0000-4000-8000-000000000031",
          configurationRevision: 1,
        }),
        issueChallenge: async (): Promise<never> => {
          throw new OperatorPresenceError("internal detail must not cross UDS", code);
        },
      };
      const socketPath = join(runtime, `${code.slice(code.lastIndexOf(".") + 1)}.sock`);
      const server = await startOperatorPresenceIssueServer({
        socketPath,
        sessionAuthority: authority as unknown as OperatorSessionAuthority,
        approvalAuthority: authority as unknown as OperatorPresenceAuthority,
        sealKeyAuthority: authority as unknown as OperatorPresenceAuthority,
        authorityLock,
        peerCheck: () => true,
      });
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const socket = connect(socketPath);
          const chunks: Buffer[] = [];
          socket.on("error", reject);
          socket.on("data", (chunk) => {
            chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            if (bytes.includes(0x0a)) {
              socket.destroy();
              try {
                resolve(JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8")));
              } catch (error: unknown) {
                reject(error);
              }
            }
          });
          socket.once("connect", () => {
            socket.write(request);
            shutdownWriteHalf(socket);
          });
        });
      } finally {
        await server.close();
      }
    };
    await expect(responseFor("action.operator_challenge_capacity")).resolves.toEqual({
      version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
      error: {
        code: "action.operator_challenge_capacity",
        message: "operator challenge capacity is exhausted",
      },
    });
    await expect(responseFor("action.operator_presence_unsupported")).resolves.toEqual({
      version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
      error: {
        code: "action.operator_presence_unsupported",
        message: "secure operator presence is unavailable",
      },
    });
  });

  test("frames a strict request and returns a durable challenge without identity fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-presence-issue-server-"));
    roots.push(root);
    await chmod(root, 0o700);
    const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000020";
    const requestBody = new TextEncoder().encode(
      JSON.stringify({ requestedScopes: ["mail:action.create", "mail:action.inspect"] }),
    );
    const issuedAt = "2026-08-19T00:00:00.000Z";
    const expiresAt = "2026-08-19T00:01:00.000Z";
    const displayCode = "0000-0000-0000-0000-0000";
    let observed: OperatorPresenceRequest | undefined;
    const authority = {
      authorityInstanceId,
      configurationRevision: 3,
      currentBinding: async () => ({ authorityInstanceId, configurationRevision: 3 }),
      issueChallenge: async (request: OperatorPresenceRequest): Promise<OperatorPresenceChallenge> => {
        observed = request;
        const bodySha256 = await crypto.subtle.digest("SHA-256", request.rawBody);
        const bodyHash = Buffer.from(bodySha256).toString("hex");
        const challengeId = "operator-challenge:socket";
        const nonce = Buffer.alloc(32, 7).toString("base64url");
        return {
          challengeId,
          nonceBase64url: nonce,
          commitment: JSON.stringify([
            "agent-mail-operator-challenge-v1",
            authorityInstanceId,
            challengeId,
            nonce,
            request.credentialId,
            "principal:local-operator",
            "operator-interactive",
            request.operation,
            request.method,
            request.path,
            bodyHash,
            displayCode,
            3,
            issuedAt,
            expiresAt,
          ]),
          displayCode,
          issuedAt,
          expiresAt,
          request: {
            ...request,
            bodySha256: bodyHash,
            operatorDisplayCode: displayCode,
          },
        };
      },
    };
    const runtime = join("/tmp", `am-${process.pid}-${Date.now()}`);
    await mkdir(runtime, { mode: 0o700 });
    await chmod(runtime, 0o700);
    const socketPath = join(runtime, "issue.sock");
    const server = await startOperatorPresenceIssueServer({
      socketPath,
      sessionAuthority: authority as unknown as OperatorSessionAuthority,
      approvalAuthority: authority as unknown as OperatorPresenceAuthority,
      sealKeyAuthority: authority as unknown as OperatorPresenceAuthority,
      authorityLock,
    });
    try {
      const client = new DaemonOperatorPresenceIssueClient(
        socketPath,
      );
      const challenge = await client.issue({
        operation: "open-session",
        method: "POST",
        path: "/v1/operator-sessions",
        rawBody: requestBody,
        credentialId: `credential:operator:${"a".repeat(64)}`,
        principalId: "principal:local-operator",
        authorityInstanceId,
        configurationRevision: 3,
      });
      expect(challenge.challengeId).toBe("operator-challenge:socket");
      expect(observed?.principalId).toBe("principal:local-operator");
      expect(observed?.authorityInstanceId).toBe(authorityInstanceId);
      expect(challenge).not.toHaveProperty("token");
      expect(OPERATOR_PRESENCE_PROTOCOL_VERSION).toBe("agent-mail-macos-operator-presence-v1");
      const sealBody = Buffer.from(
        JSON.stringify({
          expectedKeyringRevision: 1,
          expectedActiveKeyId: "approval-seal-key:00000000-0000-4000-8000-000000000020",
        }),
      );
      await client.issue({
        operation: "seal-key-rotate",
        method: "ADMIN",
        path: "/internal/action-authority/seal-keyring/rotate",
        rawBody: sealBody,
        credentialId: `credential:operator:${"a".repeat(64)}`,
        principalId: "principal:local-operator",
        authorityInstanceId,
        configurationRevision: 3,
      });
      expect(observed?.operation).toBe("seal-key-rotate");
      expect(observed?.method).toBe("ADMIN");
    } finally {
      await server.close();
      await rm(runtime, { recursive: true, force: true });
    }
  });

  test("rejects unsafe paths and trailing/non-UTF-8 frames with one frozen error", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-presence-issue-adversarial-"));
    roots.push(root);
    await chmod(root, 0o700);
    const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000021";
    const authority = {
      authorityInstanceId,
      configurationRevision: 1,
      currentBinding: async () => ({ authorityInstanceId, configurationRevision: 1 }),
      issueChallenge: async (): Promise<never> => {
        throw new Error("must not issue malformed frames");
      },
    };
    await expect(
      startOperatorPresenceIssueServer({
        socketPath: "relative/operator.sock",
        sessionAuthority: authority as unknown as OperatorSessionAuthority,
        approvalAuthority: authority as unknown as OperatorPresenceAuthority,
        sealKeyAuthority: authority as unknown as OperatorPresenceAuthority,
        authorityLock,
      }),
    ).rejects.toThrow(/invalid/);

    const runtime = join("/tmp", `am-adversarial-${process.pid}-${Date.now()}`);
    roots.push(runtime);
    await mkdir(runtime, { mode: 0o700 });
    const occupied = join(runtime, "occupied.sock");
    await Bun.write(occupied, "preserve");
    await expect(
      startOperatorPresenceIssueServer({
        socketPath: occupied,
        sessionAuthority: authority as unknown as OperatorSessionAuthority,
        approvalAuthority: authority as unknown as OperatorPresenceAuthority,
        sealKeyAuthority: authority as unknown as OperatorPresenceAuthority,
        authorityLock,
      }),
    ).rejects.toThrow(/unsafe/);
    expect(await Bun.file(occupied).text()).toBe("preserve");

    const socketPath = join(runtime, "issue.sock");
    const server = await startOperatorPresenceIssueServer({
      socketPath,
      sessionAuthority: authority as unknown as OperatorSessionAuthority,
      approvalAuthority: authority as unknown as OperatorPresenceAuthority,
      sealKeyAuthority: authority as unknown as OperatorPresenceAuthority,
      authorityLock,
    });
    const read = (frame: Uint8Array, delayedTrailing = false): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        const chunks: Buffer[] = [];
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          if (bytes.includes(0x0a)) {
            socket.destroy();
            resolve(bytes.toString("utf8"));
          }
        });
        socket.once("connect", () => {
          if (!delayedTrailing) {
            socket.write(frame);
            shutdownWriteHalf(socket);
            return;
          }
          const terminal = frame.subarray(0, frame.byteLength - 1);
          const trailing = frame.subarray(frame.byteLength - 1);
          socket.write(terminal);
          setTimeout(() => {
            socket.write(Buffer.concat([trailing, Buffer.from("trailing", "utf8")]));
            shutdownWriteHalf(socket);
          }, 10);
        });
      });
    try {
      const valid = Buffer.from(JSON.stringify({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        command: "issue",
        credentialId: `credential:operator:${"a".repeat(64)}`,
        operation: "open-session",
        requestMethod: "POST",
        requestPath: "/v1/operator-sessions",
        requestBodyBase64url: Buffer.from("{}").toString("base64url"),
      }) + "\n", "utf8");
      const trailing = await read(valid, true);
      expect(JSON.parse(trailing)).toEqual({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        error: {
          code: "action.operator_assertion_invalid",
          message: "operator presence assertion is invalid",
        },
      });
      const invalidUtf8 = await read(Buffer.from([0xff, 0xfe, 0x0a]));
      expect(JSON.parse(invalidUtf8)).toEqual({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        error: {
          code: "action.operator_assertion_invalid",
          message: "operator presence assertion is invalid",
        },
      });

      let issuedWithoutHalfClose = false;
      const noHalfCloseAuthority = {
        ...authority,
        issueChallenge: async (): Promise<never> => {
          issuedWithoutHalfClose = true;
          throw new Error("must not issue without write-half close");
        },
      };
      const noHalfCloseSocketPath = join(runtime, "no-half-close.sock");
      const noHalfCloseServer = await startOperatorPresenceIssueServer({
        socketPath: noHalfCloseSocketPath,
        sessionAuthority: noHalfCloseAuthority as unknown as OperatorSessionAuthority,
        approvalAuthority: noHalfCloseAuthority as unknown as OperatorPresenceAuthority,
        sealKeyAuthority: noHalfCloseAuthority as unknown as OperatorPresenceAuthority,
        authorityLock,
      });
      try {
        const noHalfClose = await new Promise<boolean>((resolve, reject) => {
          const socket = connect(noHalfCloseSocketPath);
          socket.on("error", reject);
          socket.on("data", () => resolve(true));
          socket.write(valid);
          setTimeout(() => {
            socket.destroy();
            resolve(false);
          }, 50);
        });
        expect(noHalfClose).toBe(false);
        expect(issuedWithoutHalfClose).toBe(false);
      } finally {
        await noHalfCloseServer.close();
      }

      let peerRejectedIssueCount = 0;
      const peerRejectedAuthority = {
        ...authority,
        issueChallenge: async (): Promise<never> => {
          peerRejectedIssueCount += 1;
          throw new Error("peer-rejected authority must not issue");
        },
      };
      const peerRejectedSocketPath = join(runtime, "peer-rejected.sock");
      const peerRejectedServer = await startOperatorPresenceIssueServer({
        socketPath: peerRejectedSocketPath,
        sessionAuthority: peerRejectedAuthority as unknown as OperatorSessionAuthority,
        approvalAuthority: peerRejectedAuthority as unknown as OperatorPresenceAuthority,
        sealKeyAuthority: peerRejectedAuthority as unknown as OperatorPresenceAuthority,
        authorityLock,
        peerCheck: () => false,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = connect(peerRejectedSocketPath);
          socket.on("error", reject);
          socket.once("connect", () => {
            socket.write(valid);
            shutdownWriteHalf(socket);
            setTimeout(() => {
              socket.destroy();
              resolve();
            }, 25);
          });
        });
        expect(peerRejectedIssueCount).toBe(0);
      } finally {
        await peerRejectedServer.close();
      }
    } finally {
      await server.close();
    }
  });

  test("native mutation adapter rejects a non-owner before any file or database write", async () => {
    const root = await mkdtemp(join(tmpdir(), "am-mut-"));
    roots.push(root);
    await chmod(root, 0o700);
    const database = new Database(":memory:", { strict: true });
    const socketPath = join(root, "mutation.sock");
    const mutationServer = await startOperatorAuthorityMutationServer({
      socketPath,
      privateRoot: root,
      database,
      authorityLock,
      peerCheck: () => false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(socketPath);
        socket.on("error", reject);
        socket.once("connect", () => {
          socket.write(`${JSON.stringify({
            version: "agent-mail-authority-mutation-v1",
            command: "apply",
            proof: { kind: "seal-key-rotate" },
          })}\n`);
          shutdownWriteHalf(socket);
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 25);
        });
      });
      expect(await Bun.file(join(root, "config", "operator-credentials.v1.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, "secrets", "action-approval-seal-keyring.v1.json")).exists()).toBe(false);
    } finally {
      await mutationServer.close();
      database.close();
    }
  });

  test("rejects the retired bare seal discriminant even for the owner peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "am-mut-bare-"));
    roots.push(root);
    await chmod(root, 0o700);
    const database = new Database(":memory:", { strict: true });
    const socketPath = join(root, "mutation.sock");
    const mutationServer = await startOperatorAuthorityMutationServer({
      socketPath,
      privateRoot: root,
      database,
      authorityLock,
      peerCheck: () => true,
    });
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(socketPath);
        const chunks: Buffer[] = [];
        socket.on("error", reject);
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.once("connect", () => {
          socket.end(`${JSON.stringify({
            version: "agent-mail-authority-mutation-v1",
            command: "apply",
            proof: { kind: "seal-key-rotate" },
          })}\n`);
        });
      });
      if (response.length > 0) {
        expect(JSON.parse(response)).toEqual({
          version: "agent-mail-authority-mutation-v1",
          error: {
            code: "action.operator_assertion_invalid",
            message: "operator authority mutation is invalid",
          },
        });
      }
      expect(await Bun.file(join(root, "config", "operator-credentials.v1.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, "secrets", "action-approval-seal-keyring.v1.json")).exists()).toBe(false);
    } finally {
      await mutationServer.close();
      database.close();
    }
  });
});
