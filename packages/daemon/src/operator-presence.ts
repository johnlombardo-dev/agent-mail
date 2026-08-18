import { createHash } from "node:crypto";
import { connect } from "node:net";
import { dlopen, FFIType } from "bun:ffi";

const MAX_BODY_BYTES = 2_048;
const MAX_FRAME_BYTES = 4_096;
export const OPERATOR_PRESENCE_PROTOCOL_VERSION = "agent-mail-macos-operator-presence-v1" as const;

const darwinLibc =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
    : undefined;

/** Bun's node:net adapter closes the read half when end() is called. */
function shutdownWriteHalf(socket: import("node:net").Socket): void {
  const handle = Reflect.get(socket, "_handle");
  const fd = handle !== null && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined;
  if (
    darwinLibc !== undefined &&
    typeof fd === "number" &&
    darwinLibc.symbols.shutdown(fd, 1) === 0
  )
    return;
  socket.end();
}

export type OperatorPresenceRequest = Readonly<{
  readonly operation:
    | "open-session"
    | "approve"
    | "cancel-approval"
    | "seal-key-rotate"
    | "seal-key-remove";
  readonly method: "POST" | "DELETE" | "ADMIN";
  readonly path: string;
  readonly rawBody: Uint8Array;
  readonly credentialId: string;
  readonly principalId: "principal:local-operator";
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
}>;

export type OperatorPresenceChallenge = Readonly<{
  readonly challengeId: string;
  readonly nonceBase64url: string;
  readonly commitment: string;
  readonly displayCode: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly request: Readonly<{
    readonly operation: OperatorPresenceRequest["operation"];
    readonly method: OperatorPresenceRequest["method"];
    readonly path: string;
    readonly bodySha256: string;
    readonly principalId: "principal:local-operator";
    readonly credentialId: string;
    readonly authorityInstanceId: string;
    readonly configurationRevision: number;
    readonly operatorDisplayCode: string;
  }>;
}>;

export type OperatorPresenceAssertion = Readonly<{
  readonly version: typeof OPERATOR_PRESENCE_PROTOCOL_VERSION;
  readonly challengeId: string;
  readonly credentialId: string;
  readonly signatureP1363Base64url: string;
}>;

export type OperatorPresenceBroker = Readonly<{
  readonly issue: (request: OperatorPresenceRequest) => Promise<OperatorPresenceChallenge>;
  readonly verify: (
    assertion: OperatorPresenceAssertion,
    request: OperatorPresenceRequest,
    challengeCommitment: string,
  ) => Promise<void>;
  /** Present only on the native broker; test verifiers intentionally cannot mint production assertions. */
  readonly sign?: (
    request: OperatorPresenceRequest,
    challenge: OperatorPresenceChallenge,
  ) => Promise<OperatorPresenceAssertion>;
}>;

/** Narrow native ceremony adapter. It never accepts a caller-supplied key or signature. */
export type OperatorPresenceSigner = Readonly<{
  readonly sign: (
    request: OperatorPresenceRequest,
    challenge: OperatorPresenceChallenge,
  ) => Promise<OperatorPresenceAssertion>;
}>;

export class OperatorPresenceError extends Error {
  readonly code:
    | "action.operator_assertion_invalid"
    | "action.operator_challenge_capacity"
    | "action.operator_presence_unsupported";

  constructor(
    message: string,
    code:
      | "action.operator_assertion_invalid"
      | "action.operator_challenge_capacity"
      | "action.operator_presence_unsupported" = "action.operator_assertion_invalid",
  ) {
    super(message);
    this.name = "OperatorPresenceError";
    this.code = code;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalBody(body: Uint8Array): string {
  if (!(body instanceof Uint8Array) || body.byteLength > MAX_BODY_BYTES)
    throw new OperatorPresenceError("operator request body is invalid");
  return Buffer.from(body).toString("base64url");
}

function canonicalNonce(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  return value;
}

/**
 * The native success envelope intentionally omits the nonce.  It is not a
 * secret response field: the daemon recovers it from the exact commitment
 * bytes it is about to persist, and rejects any commitment that is not the
 * oracle's canonical challenge array.  This keeps the wire envelope closed
 * while ensuring the durable nonce and signed commitment cannot diverge.
 */
function nonceFromCommitment(
  commitment: string,
  expected: Readonly<{
    readonly challengeId: string;
    readonly credentialId: string;
    readonly operatorDisplayCode: string;
  }>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commitment) as unknown;
  } catch {
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 15 ||
    parsed[0] !== "agent-mail-operator-challenge-v1" ||
    parsed[2] !== expected.challengeId ||
    parsed[4] !== expected.credentialId ||
    parsed[11] !== expected.operatorDisplayCode ||
    parsed.some((item) => typeof item !== "string" && typeof item !== "number") ||
    JSON.stringify(parsed) !== commitment
  )
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  return canonicalNonce(parsed[3]);
}

function validateCommitmentBinding(
  commitment: string,
  request: OperatorPresenceRequest,
  challenge: Readonly<{
    readonly challengeId: string;
    readonly operatorDisplayCode: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }>,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commitment) as unknown;
  } catch {
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  }
  const bodySha256 = createHash("sha256").update(request.rawBody).digest("hex");
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 15 ||
    parsed[0] !== "agent-mail-operator-challenge-v1" ||
    parsed[1] !== request.authorityInstanceId ||
    parsed[2] !== challenge.challengeId ||
    parsed[4] !== request.credentialId ||
    parsed[5] !== request.principalId ||
    parsed[6] !== "operator-interactive" ||
    parsed[7] !== request.operation ||
    parsed[8] !== request.method ||
    parsed[9] !== request.path ||
    parsed[10] !== bodySha256 ||
    parsed[11] !== challenge.operatorDisplayCode ||
    parsed[12] !== request.configurationRevision ||
    parsed[13] !== challenge.issuedAt ||
    parsed[14] !== challenge.expiresAt ||
    JSON.stringify(parsed) !== commitment
  )
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
}

function parseBrokerResponse(value: unknown): OperatorPresenceChallenge {
  if (!isPlainRecord(value))
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  const candidate = value;
  if (
    !exactKeys(candidate, [
      "version",
      "challengeId",
      "challengeCommitment",
      "operatorDisplayCode",
      "issuedAt",
      "expiresAt",
      "credentialId",
      "algorithm",
    ])
  )
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  if (
    candidate.version !== OPERATOR_PRESENCE_PROTOCOL_VERSION ||
    typeof candidate.challengeId !== "string" ||
    typeof candidate.challengeCommitment !== "string" ||
    candidate.challengeCommitment.length === 0 ||
    candidate.challengeCommitment.length > MAX_FRAME_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.challengeCommitment) ||
    typeof candidate.operatorDisplayCode !== "string" ||
    !/^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(candidate.operatorDisplayCode) ||
    typeof candidate.issuedAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.credentialId !== "string" ||
    candidate.algorithm !== "ES256"
  )
    throw new OperatorPresenceError(
      "operator broker response is invalid",
      "action.operator_presence_unsupported",
    );
  const nonceBase64url = nonceFromCommitment(candidate.challengeCommitment, {
    challengeId: candidate.challengeId,
    credentialId: candidate.credentialId,
    operatorDisplayCode: candidate.operatorDisplayCode,
  });
  return Object.freeze({
    challengeId: candidate.challengeId,
    nonceBase64url,
    commitment: candidate.challengeCommitment,
    displayCode: candidate.operatorDisplayCode,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    request: Object.freeze({
      operation: "open-session",
      method: "POST",
      path: "",
      bodySha256: "",
      principalId: "principal:local-operator",
      credentialId: candidate.credentialId,
      authorityInstanceId: "",
      configurationRevision: 0,
      operatorDisplayCode: candidate.operatorDisplayCode,
    }),
  });
}

function parseBrokerAssertion(value: unknown): OperatorPresenceAssertion {
  if (!isPlainRecord(value))
    throw new OperatorPresenceError(
      "operator broker assertion response is invalid",
      "action.operator_presence_unsupported",
    );
  if (
    !exactKeys(value, ["version", "challengeId", "credentialId", "signatureBase64url"]) ||
    value.version !== OPERATOR_PRESENCE_PROTOCOL_VERSION ||
    typeof value.challengeId !== "string" ||
    !value.challengeId.startsWith("operator-challenge:") ||
    typeof value.credentialId !== "string" ||
    !value.credentialId.startsWith("credential:") ||
    typeof value.signatureBase64url !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(value.signatureBase64url) ||
    Buffer.from(value.signatureBase64url, "base64url").toString("base64url") !==
      value.signatureBase64url
  )
    throw new OperatorPresenceError(
      "operator broker assertion response is invalid",
      "action.operator_presence_unsupported",
    );
  return Object.freeze({
    version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
    challengeId: value.challengeId,
    credentialId: value.credentialId,
    signatureP1363Base64url: value.signatureBase64url,
  });
}

/** Client for the owner-only native agent-mail-operator-broker UDS. */
export class NativeOperatorPresenceBroker {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    if (
      typeof socketPath !== "string" ||
      socketPath.length === 0 ||
      socketPath.length > 104 ||
      socketPath.includes("\0")
    )
      throw new OperatorPresenceError(
        "operator broker socket path is invalid",
        "action.operator_presence_unsupported",
      );
    this.#socketPath = socketPath;
  }

  async issue(_request: OperatorPresenceRequest): Promise<OperatorPresenceChallenge> {
    throw new OperatorPresenceError(
      "operator challenge issuance is daemon-owned",
      "action.operator_presence_unsupported",
    );
  }

  async verify(
    assertion: OperatorPresenceAssertion,
    request: OperatorPresenceRequest,
    challengeCommitment: string,
  ): Promise<void> {
    if (
      assertion.version !== OPERATOR_PRESENCE_PROTOCOL_VERSION ||
      typeof assertion.challengeId !== "string" ||
      typeof assertion.credentialId !== "string" ||
      typeof assertion.signatureP1363Base64url !== "string" ||
      typeof challengeCommitment !== "string" ||
      challengeCommitment.length === 0
    )
      throw new OperatorPresenceError("operator assertion is invalid");
    const frame = Buffer.from(
      `${JSON.stringify({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        command: "verify",
        challengeId: assertion.challengeId,
        credentialId: assertion.credentialId,
        signatureBase64url: assertion.signatureP1363Base64url,
        challengeCommitment,
        operation: request.operation,
        requestMethod: request.method,
        requestPath: request.path,
        requestBodyBase64url: canonicalBody(request.rawBody),
      })}\n`,
      "utf8",
    );
    if (frame.byteLength > MAX_FRAME_BYTES)
      throw new OperatorPresenceError("operator broker frame is too large");
    const response = await this.#roundTrip(frame);
    if (!isPlainRecord(response) || response.verified !== true)
      throw new OperatorPresenceError("operator assertion is invalid");
  }

  async sign(
    request: OperatorPresenceRequest,
    challenge: OperatorPresenceChallenge,
  ): Promise<OperatorPresenceAssertion> {
    validateCommitmentBinding(challenge.commitment, request, {
      challengeId: challenge.challengeId,
      operatorDisplayCode: challenge.displayCode,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    const frame = Buffer.from(
      `${JSON.stringify({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        command: "sign",
        challengeId: challenge.challengeId,
        credentialId: request.credentialId,
        challengeCommitment: challenge.commitment,
        operation: request.operation,
        requestMethod: request.method,
        requestPath: request.path,
        requestBodyBase64url: canonicalBody(request.rawBody),
      })}\n`,
      "utf8",
    );
    if (frame.byteLength > MAX_FRAME_BYTES)
      throw new OperatorPresenceError("operator broker frame is too large");
    const assertion = parseBrokerAssertion(await this.#roundTrip(frame));
    if (
      assertion.challengeId !== challenge.challengeId ||
      assertion.credentialId !== request.credentialId
    )
      throw new OperatorPresenceError(
        "operator broker assertion response is invalid",
        "action.operator_presence_unsupported",
      );
    return assertion;
  }

  async #roundTrip(frame: Uint8Array): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new OperatorPresenceError(
            "operator broker request failed",
            "action.operator_presence_unsupported",
          ),
        );
      };
      socket.on("error", fail);
      socket.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_FRAME_BYTES) return fail();
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== bytes.byteLength - 1 || bytes.subarray(0, newline).includes(0x0a)) {
          return fail();
        }
        settled = true;
        socket.destroy();
        try {
          resolve(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
            ) as unknown,
          );
        } catch {
          reject(
            new OperatorPresenceError(
              "operator broker response is invalid",
              "action.operator_presence_unsupported",
            ),
          );
        }
      });
      socket.on("end", () => {
        if (!settled) fail();
      });
      socket.once("connect", () => {
        socket.write(frame);
        shutdownWriteHalf(socket);
      });
    });
  }
}

/** Client for the daemon-owned issue socket. NativeOperatorPresenceBroker is signer-only. */
export class DaemonOperatorPresenceIssueClient {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    if (
      typeof socketPath !== "string" ||
      socketPath.length === 0 ||
      socketPath.length > 104 ||
      socketPath.includes("\0")
    )
      throw new OperatorPresenceError(
        "operator challenge socket path is invalid",
        "action.operator_presence_unsupported",
      );
    this.#socketPath = socketPath;
  }

  async issue(request: OperatorPresenceRequest): Promise<OperatorPresenceChallenge> {
    const frame = Buffer.from(
      `${JSON.stringify({
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        command: "issue",
        credentialId: request.credentialId,
        operation: request.operation,
        requestMethod: request.method,
        requestPath: request.path,
        requestBodyBase64url: canonicalBody(request.rawBody),
      })}\n`,
      "utf8",
    );
    if (frame.byteLength > MAX_FRAME_BYTES)
      throw new OperatorPresenceError("operator broker frame is too large");
    const challenge = parseBrokerResponse(await this.#roundTrip(frame));
    validateCommitmentBinding(challenge.commitment, request, {
      challengeId: challenge.challengeId,
      operatorDisplayCode: challenge.displayCode,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    return Object.freeze({
      ...challenge,
      request: Object.freeze({
        ...challenge.request,
        operation: request.operation,
        method: request.method,
        path: request.path,
        bodySha256: createHash("sha256").update(request.rawBody).digest("hex"),
        credentialId: request.credentialId,
        authorityInstanceId: request.authorityInstanceId,
        configurationRevision: request.configurationRevision,
      }),
    });
  }

  async #roundTrip(frame: Uint8Array): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: this.#socketPath, allowHalfOpen: true });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new OperatorPresenceError(
            "operator broker request failed",
            "action.operator_presence_unsupported",
          ),
        );
      };
      socket.on("error", fail);
      socket.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_FRAME_BYTES) return fail();
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== bytes.byteLength - 1 || bytes.subarray(0, newline).includes(0x0a))
          return fail();
        settled = true;
        socket.destroy();
        try {
          resolve(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
            ) as unknown,
          );
        } catch {
          reject(
            new OperatorPresenceError(
              "operator broker response is invalid",
              "action.operator_presence_unsupported",
            ),
          );
        }
      });
      socket.on("end", () => {
        if (!settled) fail();
      });
      socket.once("connect", () => {
        socket.write(frame);
        shutdownWriteHalf(socket);
      });
    });
  }
}

export function operatorPresenceBodyDigest(rawBody: Uint8Array): string {
  canonicalBody(rawBody);
  return createHash("sha256").update(rawBody).digest("hex");
}
