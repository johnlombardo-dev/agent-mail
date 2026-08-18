import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { dlopen, FFIType } from "bun:ffi";
import {
  OPERATOR_PRESENCE_PROTOCOL_VERSION,
  OperatorPresenceError,
  type OperatorPresenceChallenge,
  type OperatorPresenceRequest,
} from "./operator-presence";
import type { OperatorPresenceAuthority, OperatorSessionAuthority } from "./action-authority-auth";
import type { AuthorityFileLock } from "./action-authority-lock";
import { ApprovalAuthorityError } from "../../storage/src/action-approval-authority";

const MAX_FRAME_BYTES = 4_096;
const MAX_BODY_BYTES = 2_048;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_SOCKET_MODE = 0o600;

const darwinLibc =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        dup: { args: [FFIType.i32], returns: FFIType.i32 },
        getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      })
    : undefined;

type IssueAuthority = Readonly<{
  readonly currentBinding: () => Promise<
    Readonly<{
      readonly authorityInstanceId: string;
      readonly configurationRevision: number;
    }>
  >;
  readonly issueChallenge: (request: OperatorPresenceRequest) => Promise<OperatorPresenceChallenge>;
}>;

export type OperatorPresenceIssueServerOptions = Readonly<{
  readonly socketPath: string;
  readonly sessionAuthority: OperatorSessionAuthority;
  readonly approvalAuthority: OperatorPresenceAuthority;
  readonly sealKeyAuthority: OperatorPresenceAuthority;
  /** Shared admission spans live binding resolution through durable insert. */
  readonly authorityLock: AuthorityFileLock;
  /** Test-only peer verifier; production uses the mandatory Darwin getpeereid check. */
  readonly peerCheck?: (descriptor: number) => boolean;
}>;

export type OperatorPresenceIssueServer = Readonly<{
  readonly close: () => Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function fail(
  message: string,
  code:
    | "action.operator_assertion_invalid"
    | "action.operator_presence_unsupported" = "action.operator_assertion_invalid",
): never {
  throw new OperatorPresenceError(message, code);
}

async function parseIssueRequest(
  value: unknown,
  authority: IssueAuthority,
): Promise<OperatorPresenceRequest> {
  if (!isRecord(value)) fail("operator challenge request is invalid");
  if (
    !exactKeys(value, [
      "version",
      "command",
      "credentialId",
      "operation",
      "requestMethod",
      "requestPath",
      "requestBodyBase64url",
    ]) ||
    value.version !== OPERATOR_PRESENCE_PROTOCOL_VERSION ||
    value.command !== "issue" ||
    typeof value.credentialId !== "string" ||
    !/^credential:operator:[0-9a-f]{64}$/u.test(value.credentialId) ||
    (value.operation !== "open-session" &&
      value.operation !== "approve" &&
      value.operation !== "cancel-approval" &&
      value.operation !== "seal-key-rotate" &&
      value.operation !== "seal-key-remove") ||
    typeof value.requestMethod !== "string" ||
    (value.operation === "cancel-approval"
      ? value.requestMethod !== "DELETE"
      : value.operation === "seal-key-rotate" || value.operation === "seal-key-remove"
        ? value.requestMethod !== "ADMIN"
        : value.requestMethod !== "POST") ||
    typeof value.requestPath !== "string" ||
    value.requestPath.length === 0 ||
    value.requestPath.length > 2_048 ||
    !value.requestPath.startsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.requestPath) ||
    typeof value.requestBodyBase64url !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value.requestBodyBase64url) ||
    Buffer.from(value.requestBodyBase64url, "base64url").byteLength > MAX_BODY_BYTES ||
    Buffer.from(value.requestBodyBase64url, "base64url").toString("base64url") !==
      value.requestBodyBase64url
  )
    fail("operator challenge request is invalid");
  const operation = value.operation;
  if (
    operation !== "open-session" &&
    operation !== "approve" &&
    operation !== "cancel-approval" &&
    operation !== "seal-key-rotate" &&
    operation !== "seal-key-remove"
  )
    fail("operator challenge request is invalid");
  const method = value.requestMethod;
  if (method !== "POST" && method !== "DELETE" && method !== "ADMIN")
    fail("operator challenge request is invalid");
  const binding = await authority.currentBinding();
  return Object.freeze({
    operation,
    method,
    path: value.requestPath,
    rawBody: Uint8Array.from(Buffer.from(value.requestBodyBase64url, "base64url")),
    credentialId: value.credentialId,
    principalId: "principal:local-operator",
    authorityInstanceId: binding.authorityInstanceId,
    configurationRevision: binding.configurationRevision,
  });
}

function publicChallenge(challenge: OperatorPresenceChallenge): Readonly<Record<string, unknown>> {
  return {
    version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
    challengeId: challenge.challengeId,
    challengeCommitment: challenge.commitment,
    operatorDisplayCode: challenge.displayCode,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    credentialId: challenge.request.credentialId,
    algorithm: "ES256",
  };
}

const ISSUE_ERROR_MESSAGES = Object.freeze({
  "action.approval_forbidden": "request credentials cannot perform this approval operation",
  "action.operator_presence_unsupported": "secure operator presence is unavailable",
  "action.operator_challenge_capacity": "operator challenge capacity is exhausted",
  "action.operator_assertion_invalid": "operator presence assertion is invalid",
} as const);

type IssueErrorCode = keyof typeof ISSUE_ERROR_MESSAGES;

function isIssueErrorCode(value: string | undefined): value is IssueErrorCode {
  return value !== undefined && Object.prototype.hasOwnProperty.call(ISSUE_ERROR_MESSAGES, value);
}

function errorResponse(error: unknown): string {
  const candidate =
    error instanceof OperatorPresenceError || error instanceof ApprovalAuthorityError
      ? error.code
      : undefined;
  const code: IssueErrorCode = isIssueErrorCode(candidate)
    ? candidate
    : "action.operator_assertion_invalid";
  return JSON.stringify({
    version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
    error: {
      code,
      message: ISSUE_ERROR_MESSAGES[code],
    },
  });
}

function socketDescriptor(socket: Socket): number | undefined {
  const handle = Reflect.get(socket, "_handle");
  const descriptor =
    handle !== null && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined;
  return typeof descriptor === "number" && Number.isInteger(descriptor) && descriptor >= 0
    ? descriptor
    : undefined;
}

function ownerPeer(descriptor: number): boolean {
  if (darwinLibc === undefined || typeof process.getuid !== "function") return false;
  const uid = new Uint32Array(1);
  const gid = new Uint32Array(1);
  return darwinLibc.symbols.getpeereid(descriptor, uid, gid) === 0 && uid[0] === process.getuid();
}

function duplicateDescriptor(descriptor: number): number | undefined {
  const duplicate = darwinLibc?.symbols.dup(descriptor);
  return typeof duplicate === "number" && duplicate >= 0 ? duplicate : undefined;
}

function writeAndClose(descriptor: number, response: string): boolean {
  if (darwinLibc === undefined) return false;
  const bytes = Buffer.from(`${response}\n`, "utf8");
  if (bytes.byteLength > MAX_FRAME_BYTES) return false;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = darwinLibc.symbols.write(
      descriptor,
      bytes.subarray(offset),
      bytes.byteLength - offset,
    );
    const count = typeof written === "bigint" ? Number(written) : written;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
      darwinLibc.symbols.close(descriptor);
      return false;
    }
    offset += count;
  }
  darwinLibc.symbols.shutdown(descriptor, 1);
  darwinLibc.symbols.close(descriptor);
  return true;
}

async function assertSocketParent(socketPath: string): Promise<void> {
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.length === 0 ||
    socketPath.length > 104 ||
    socketPath.includes("\0")
  )
    throw new TypeError("operator presence issue socket path is invalid");
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  await chmod(parent, OWNER_DIRECTORY_MODE);
  const info = await lstat(parent);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== OWNER_DIRECTORY_MODE ||
    (uid !== undefined && info.uid !== uid)
  )
    throw new Error("operator presence issue socket parent is unsafe");
  const existing = await lstat(socketPath).catch(() => undefined);
  if (
    existing !== undefined &&
    (existing.isSymbolicLink() ||
      !existing.isSocket() ||
      (existing.mode & 0o777) !== OWNER_SOCKET_MODE ||
      (uid !== undefined && existing.uid !== uid))
  )
    throw new Error("operator presence issue socket is unsafe");
}

function handleConnection(
  socket: Socket,
  authorities: readonly IssueAuthority[],
  authorityLock: AuthorityFileLock,
  peerCheck: ((descriptor: number) => boolean) | undefined,
): void {
  socket.setTimeout(2_000);
  socket.allowHalfOpen = true;
  const descriptor = socketDescriptor(socket);
  if (descriptor === undefined || !(peerCheck?.(descriptor) ?? ownerPeer(descriptor))) {
    socket.destroy();
    return;
  }
  const responseDescriptor = duplicateDescriptor(descriptor);
  if (responseDescriptor === undefined) {
    socket.destroy();
    return;
  }
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (response: string) => {
    if (settled) return;
    settled = true;
    writeAndClose(responseDescriptor, response);
    socket.destroy();
  };
  socket.on("timeout", () =>
    finish(errorResponse(new Error("operator challenge request timed out"))),
  );
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (settled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > MAX_FRAME_BYTES) {
      finish(errorResponse(new Error("operator challenge frame is too large")));
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (
      newline >= 0 &&
      (newline !== buffer.byteLength - 1 || buffer.subarray(0, newline).includes(0x0a))
    ) {
      finish(errorResponse(new Error("operator challenge framing is invalid")));
    }
  });
  socket.on("end", () => {
    if (settled) return;
    const newline = buffer.indexOf(0x0a);
    if (
      buffer.byteLength === 0 ||
      newline !== buffer.byteLength - 1 ||
      buffer.subarray(0, newline).includes(0x0a)
    ) {
      finish(errorResponse(new Error("operator challenge framing is invalid")));
      return;
    }
    try {
      const frameText = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, newline),
      );
      const parsed: unknown = JSON.parse(frameText);
      if (JSON.stringify(parsed) !== frameText) fail("operator challenge request is invalid");
      if (!isRecord(parsed) || parsed.operation === undefined)
        fail("operator challenge request is invalid");
      const operation = parsed.operation;
      const authority =
        operation === "open-session"
          ? authorities[0]
          : operation === "approve" || operation === "cancel-approval"
            ? authorities[1]
            : authorities[2];
      if (authority === undefined)
        fail("operator challenge authority is unavailable", "action.operator_presence_unsupported");
      const issue = async () =>
        authority.issueChallenge(await parseIssueRequest(parsed, authority));
      void authorityLock.runShared(issue).then(
        (challenge) => finish(JSON.stringify(publicChallenge(challenge))),
        (error: unknown) => finish(errorResponse(error)),
      );
    } catch (error: unknown) {
      finish(errorResponse(error));
    }
  });
}

/** Start the daemon-owned, owner-only framed challenge issuer. */
export async function startOperatorPresenceIssueServer(
  options: OperatorPresenceIssueServerOptions,
): Promise<OperatorPresenceIssueServer> {
  await assertSocketParent(options.socketPath);
  const existing = await lstat(options.socketPath).catch(() => undefined);
  if (existing !== undefined) await unlink(options.socketPath);
  const server: Server = createServer({ allowHalfOpen: true }, (socket) =>
    handleConnection(
      socket,
      [options.sessionAuthority, options.approvalAuthority, options.sealKeyAuthority],
      options.authorityLock,
      options.peerCheck,
    ),
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  await chmod(options.socketPath, OWNER_SOCKET_MODE);
  return Object.freeze({
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => undefined);
    },
  });
}
