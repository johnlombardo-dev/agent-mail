import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { OPERATOR_PRESENCE_PROTOCOL_VERSION, OperatorPresenceError, type OperatorPresenceAssertion, type OperatorPresenceChallenge, type OperatorPresenceRequest } from "../../src/operator-presence";

const ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const MAX_AGE = 60_000;

export function createTestA1Key(): Readonly<{ readonly privateKey: KeyObject; readonly publicKey: KeyObject }> {
  return Object.freeze(generateKeyPairSync("ec", { namedCurve: "prime256v1" }));
}

function bodyShape(request: OperatorPresenceRequest): void {
  if (request.rawBody.byteLength > 2_048) throw new OperatorPresenceError("operator request body is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody)); } catch { throw new OperatorPresenceError("operator request body is invalid"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new OperatorPresenceError("operator request body is invalid");
}

function commitment(request: OperatorPresenceRequest, id: string, nonce: string, issued: string, expires: string, display: string): string {
  return JSON.stringify([
    "agent-mail-operator-challenge-v1", request.authorityInstanceId, id, nonce, request.credentialId,
    request.principalId, "operator-interactive", request.operation, request.method, request.path,
    createHash("sha256").update(request.rawBody).digest("hex"), display, request.configurationRevision,
    issued, expires,
  ]);
}

export class TestOperatorPresenceVerifier {
  readonly #publicKey: KeyObject;
  readonly #challenges = new Map<string, OperatorPresenceChallenge>();
  readonly #consumed = new Set<string>();

  constructor(publicKey: KeyObject) { this.#publicKey = publicKey; }

  issue(request: OperatorPresenceRequest, issuedAt: string): OperatorPresenceChallenge {
    bodyShape(request);
    if ([...this.#challenges.values()].filter((challenge) => challenge.request.credentialId === request.credentialId && !this.#consumed.has(challenge.challengeId)).length >= 4) throw new OperatorPresenceError("operator challenge capacity is exhausted", "action.operator_challenge_capacity");
    const id = `operator-challenge:${randomUUID()}`;
    const nonce = randomBytes(32).toString("base64url");
    const expires = new Date(Date.parse(issuedAt) + MAX_AGE).toISOString();
    const display = "0000-0000-0000-0000-0000";
    const value: OperatorPresenceChallenge = Object.freeze({
      challengeId: id,
      nonceBase64url: nonce,
      commitment: commitment(request, id, nonce, issuedAt, expires, display),
      displayCode: display,
      issuedAt,
      expiresAt: expires,
      request: Object.freeze({
        operation: request.operation,
        method: request.method,
        path: request.path,
        bodySha256: createHash("sha256").update(request.rawBody).digest("hex"),
        principalId: request.principalId,
        credentialId: request.credentialId,
        authorityInstanceId: request.authorityInstanceId,
        configurationRevision: request.configurationRevision,
        operatorDisplayCode: display,
      }),
    });
    this.#challenges.set(id, value);
    return value;
  }

  signForTest(challenge: OperatorPresenceChallenge, privateKey: KeyObject): OperatorPresenceAssertion {
    const bytes = Buffer.from(sign("sha256", Buffer.from(challenge.commitment), { key: privateKey, dsaEncoding: "ieee-p1363" }));
    const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
    if (s > ORDER / 2n) bytes.set(Buffer.from((ORDER - s).toString(16).padStart(64, "0"), "hex"), 32);
    return { version: OPERATOR_PRESENCE_PROTOCOL_VERSION, challengeId: challenge.challengeId, credentialId: challenge.request.credentialId, signatureP1363Base64url: bytes.toString("base64url") };
  }

  verifyAndConsume(assertion: OperatorPresenceAssertion, request: OperatorPresenceRequest, now: string): OperatorPresenceAssertion {
    const challenge = this.#challenges.get(assertion.challengeId);
    if (challenge === undefined || this.#consumed.has(assertion.challengeId)) throw new OperatorPresenceError("challenge is unavailable");
    if (Date.parse(now) < Date.parse(challenge.issuedAt) || Date.parse(now) >= Date.parse(challenge.expiresAt)) throw new OperatorPresenceError("challenge is expired");
    if (request.path !== challenge.request.path || request.method !== challenge.request.method || createHash("sha256").update(request.rawBody).digest("hex") !== challenge.request.bodySha256) throw new OperatorPresenceError("challenge binding is invalid");
    const signature = Buffer.from(assertion.signatureP1363Base64url, "base64url");
    const s = signature.length === 64 ? BigInt(`0x${signature.subarray(32).toString("hex")}`) : 0n;
    if (signature.length !== 64 || s <= 0n || s > ORDER / 2n || !verify("sha256", Buffer.from(challenge.commitment), { key: this.#publicKey, dsaEncoding: "ieee-p1363" }, signature)) throw new OperatorPresenceError("operator signature is invalid");
    this.#consumed.add(assertion.challengeId);
    return assertion;
  }
}
