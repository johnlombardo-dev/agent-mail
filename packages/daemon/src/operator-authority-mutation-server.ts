import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { dlopen, FFIType } from "bun:ffi";
import { z } from "zod";
import {
  applySealKeyAdministration,
  authorityMutationProofSchema,
  sealKeyAdministrationEnvelopeSchema,
  replaceOperatorCredentialConfiguration,
  type AuthorityMutationOptions,
} from "./action-authority-mutations";

const MAX_FRAME_BYTES = 4_096;
const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PROTOCOL_VERSION = "agent-mail-authority-mutation-v1";
const credentialRequestSchema = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  command: z.literal("apply"),
  proof: authorityMutationProofSchema,
});
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

export type OperatorAuthorityMutationServerOptions = Readonly<
  AuthorityMutationOptions & {
    readonly socketPath: string;
    readonly peerCheck?: (descriptor: number) => boolean;
  }
>;
export type OperatorAuthorityMutationServer = Readonly<{ readonly close: () => Promise<void> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function descriptorOf(socket: Socket): number | undefined {
  const handle = Reflect.get(socket, "_handle");
  const value =
    handle !== null && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function ownerPeer(descriptor: number): boolean {
  if (darwinLibc === undefined || typeof process.getuid !== "function") return false;
  const uid = new Uint32Array(1);
  const gid = new Uint32Array(1);
  return darwinLibc.symbols.getpeereid(descriptor, uid, gid) === 0 && uid[0] === process.getuid();
}

function writeFrame(descriptor: number, value: unknown): void {
  if (darwinLibc === undefined) return;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_FRAME_BYTES) return;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = darwinLibc.symbols.write(
      descriptor,
      bytes.subarray(offset),
      bytes.byteLength - offset,
    );
    const count = typeof written === "bigint" ? Number(written) : written;
    if (!Number.isSafeInteger(count) || count <= 0) break;
    offset += count;
  }
  darwinLibc.symbols.shutdown(descriptor, 1);
  darwinLibc.symbols.close(descriptor);
}

function errorResponse(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: PROTOCOL_VERSION,
    error: {
      code: "action.operator_assertion_invalid",
      message: "operator authority mutation is invalid",
    },
  });
}

async function assertSocketPath(socketPath: string): Promise<void> {
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.length > 104 ||
    socketPath.includes("\0")
  )
    throw new TypeError("operator mutation socket path is invalid");
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(parent, DIRECTORY_MODE);
  const info = await lstat(parent);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== DIRECTORY_MODE ||
    (uid !== undefined && info.uid !== uid)
  )
    throw new Error("operator mutation socket parent is unsafe");
  const existing = await lstat(socketPath).catch(() => undefined);
  if (
    existing !== undefined &&
    (!existing.isSocket() ||
      existing.isSymbolicLink() ||
      (existing.mode & 0o777) !== SOCKET_MODE ||
      (uid !== undefined && existing.uid !== uid))
  )
    throw new Error("operator mutation socket is unsafe");
}

function handleConnection(socket: Socket, options: OperatorAuthorityMutationServerOptions): void {
  socket.setTimeout(2_000);
  socket.allowHalfOpen = true;
  const descriptor = descriptorOf(socket);
  if (descriptor === undefined || !(options.peerCheck?.(descriptor) ?? ownerPeer(descriptor))) {
    socket.destroy();
    return;
  }
  const responseDescriptor = darwinLibc?.symbols.dup(descriptor);
  if (typeof responseDescriptor !== "number" || responseDescriptor < 0) {
    socket.destroy();
    return;
  }
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (response: unknown) => {
    if (settled) return;
    settled = true;
    writeFrame(responseDescriptor, response);
    socket.destroy();
  };
  socket.on("error", () => socket.destroy());
  socket.on("timeout", () => finish(errorResponse()));
  socket.on("data", (chunk: Buffer) => {
    if (settled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > MAX_FRAME_BYTES) finish(errorResponse());
    if (buffer.indexOf(0x0a) >= 0 && buffer.indexOf(0x0a) !== buffer.byteLength - 1)
      finish(errorResponse());
  });
  socket.on("end", () => {
    if (settled) return;
    const newline = buffer.indexOf(0x0a);
    if (
      buffer.byteLength === 0 ||
      newline !== buffer.byteLength - 1 ||
      buffer.subarray(0, newline).includes(0x0a)
    ) {
      finish(errorResponse());
      return;
    }
    let value: unknown;
    try {
      const frameText = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, newline),
      );
      value = JSON.parse(frameText);
      if (JSON.stringify(value) !== frameText) throw new Error("non-canonical mutation frame");
      const operation = async () => {
        if (isRecord(value)) {
          const candidate = value;
          if (candidate.version === "agent-mail-action-authority-admin-v1") {
            if (!exactKeys(candidate, ["version", "requestBodyBase64url", "assertion"]))
              throw new Error("invalid administration envelope");
            if (
              !isRecord(candidate.assertion) ||
              !exactKeys(candidate.assertion, [
                "version",
                "challengeId",
                "credentialId",
                "signatureBase64url",
              ])
            )
              throw new Error("invalid administration assertion");
            await applySealKeyAdministration(
              options,
              sealKeyAdministrationEnvelopeSchema.parse(value),
            );
            return;
          }
        }
        const request = credentialRequestSchema.parse(value);
        await replaceOperatorCredentialConfiguration(options, request.proof);
      };
      void operation().then(
        () => finish({ version: PROTOCOL_VERSION, ok: true }),
        () => finish(errorResponse()),
      );
    } catch {
      finish(errorResponse());
    }
  });
}

export async function startOperatorAuthorityMutationServer(
  options: OperatorAuthorityMutationServerOptions,
): Promise<OperatorAuthorityMutationServer> {
  await assertSocketPath(options.socketPath);
  const existing = await lstat(options.socketPath).catch(() => undefined);
  if (existing !== undefined) await unlink(options.socketPath);
  const server: Server = createServer({ allowHalfOpen: true }, (socket) =>
    handleConnection(socket, options),
  );
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  await chmod(options.socketPath, SOCKET_MODE);
  return Object.freeze({
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await unlink(options.socketPath).catch(() => undefined);
    },
  });
}
