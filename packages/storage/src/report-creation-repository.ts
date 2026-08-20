import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseAccountId, parseMessageId, type AccountId, type MessageId } from "@agent-mail/core";

export type ReportCreateRequest = Readonly<{
  readonly title: string;
  readonly sourceMessageIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}>;

export type ReportCreateResponse = Readonly<{
  readonly reportId: string;
  readonly title: string;
  readonly citations: readonly Readonly<{ readonly id: string; readonly label: string }>[];
  readonly authorization: Readonly<{
    readonly principal: string;
    readonly scope: string;
    readonly method: "bearer";
    readonly requestId: string;
    readonly authorizedAt: string;
  }>;
  readonly createdAt: string;
}>;

export const REPORT_HTTP_BODY_LIMIT_BYTES = 1_048_576;
export const REPORT_IDENTITY_LIMIT_BYTES = 1_048_576;
export const REPORT_METADATA_LIMIT_BYTES = 1_048_576;
export const REPORT_SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;
export const REPORT_SOURCE_JSON_LIMIT_BYTES = 50_331_650;
export const REPORT_SOURCE_TOTAL_BYTES = 10 * 1024 * 1024;
export const REPORT_SOURCE_JSON_TOTAL_BYTES = 62_914_760;
export const REPORT_MODEL_LIMIT_BYTES = 1_048_576;
export const REPORT_MARKDOWN_LIMIT_BYTES = 16 * 1024 * 1024;
export const REPORT_HTML_LIMIT_BYTES = 16 * 1024 * 1024;
export const REPORT_MAX_COUNT = 10_000;
export const REPORT_MAX_CHARGED_BYTES = 2_147_483_648;
export const REPORT_MAX_ATTEMPTS = 10;
export const REPORT_WINDOW_MS = 60_000;
export const REPORT_PROJECTION_VERSION = 1;
export const REPORT_RENDERER_VERSION = 1;
export const REPORT_PARSER_ID = "mailparser:3.9.15";

export type ReportRepositoryErrorCode =
  | "invalid"
  | "corrupt"
  | "busy"
  | "capacity"
  | "source-not-found"
  | "storage";

export class ReportRepositoryError extends Error {
  readonly code: ReportRepositoryErrorCode;

  constructor(code: ReportRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReportRepositoryError";
    this.code = code;
  }
}

export type ReportIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly principal: string;
  readonly title: string;
  readonly sourceMessageIds: readonly MessageId[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly reportId: string;
  readonly fingerprintSha256: string;
  readonly authorizationRequestId: string;
  readonly identityMaterialJson: Uint8Array;
  readonly accountIdJson: Uint8Array;
  readonly principalJson: Uint8Array;
  readonly titleJson: Uint8Array;
  readonly metadataJson: Uint8Array;
}>;

export type ReportSourceEvidence = Readonly<{
  readonly messageId: MessageId;
  readonly text: string;
  readonly sourceTextJson: Uint8Array;
  readonly sourceTextSha256: string;
  readonly sourceTextBytes: number;
}>;

export type ReportStoredArtifact = Readonly<{
  readonly reportId: string;
  readonly owner: string;
  readonly scope: "reports:read";
  readonly accountId: AccountId;
  readonly model: unknown;
  readonly modelJson: Uint8Array;
  readonly modelSha256: string;
  readonly markdownSha256: string;
  readonly htmlSha256: string;
  readonly cspSha256: string;
  readonly modelBytes: number;
  readonly markdownBytes: number;
  readonly htmlBytes: number;
  readonly modelVersion: number;
  readonly projectionVersion: number;
  readonly rendererVersion: number;
}>;

export type ReportStoredSource = Readonly<{
  readonly messageId: MessageId;
  readonly owner: string;
  readonly scope: "mail:read.message";
  readonly accountId: AccountId;
  readonly text: string;
  readonly sourceTextJson: Uint8Array;
  readonly sourceTextSha256: string;
  readonly sourceTextBytes: number;
  readonly projectionVersion: number;
}>;

export type ReportPublication = Readonly<{
  readonly identity: ReportIdentity;
  readonly model: unknown;
  readonly modelJson: Uint8Array;
  readonly modelSha256: string;
  readonly markdownSha256: string;
  readonly htmlSha256: string;
  readonly cspSha256: string;
  readonly modelBytes: number;
  readonly markdownBytes: number;
  readonly htmlBytes: number;
  readonly requestBodySha256: string;
  readonly authorizationAt: string;
  readonly createdAt: string;
  readonly sources: readonly ReportSourceEvidence[];
}>;

export type ReportCreationRepositoryOptions = Readonly<{
  readonly materializeLegacyText?: (messageId: MessageId) => Promise<void>;
  readonly onWrite?: (table: string) => void;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

/** Canonical JSON-string BLOB encoding; JSON.stringify preserves code units. */
export function canonicalJsonStringBytes(value: string): Uint8Array {
  return bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new ReportRepositoryError("invalid", "value is not JSON serializable");
  return bytes(Buffer.from(json, "utf8"));
}

function decodeBytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new ReportRepositoryError("corrupt", `${name} is not a BLOB`);
  return bytes(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function decodeJsonString(value: unknown, name: string): string {
  const raw = decodeBytes(value, name);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "string" || JSON.stringify(parsed) !== text)
      throw new Error("non-canonical");
    return parsed;
  } catch (error: unknown) {
    throw new ReportRepositoryError("corrupt", `${name} is not canonical JSON-string bytes`, {
      cause: error,
    });
  }
}

function decodeCanonicalJson(value: unknown, name: string): Uint8Array {
  const raw = decodeBytes(value, name);
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed: unknown = JSON.parse(serialized);
    if (JSON.stringify(parsed) !== serialized) throw new Error("non-canonical");
    return raw;
  } catch (error: unknown) {
    throw new ReportRepositoryError("corrupt", `${name} is not canonical JSON bytes`, {
      cause: error,
    });
  }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    throw new ReportRepositoryError("invalid", "report instant is invalid");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new ReportRepositoryError("invalid", "report instant is invalid");
  return value;
}

function metadataEntries(
  metadata: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return Object.entries(metadata).sort((left, right) => {
    const a = Buffer.from(JSON.stringify(left[0]), "utf8");
    const b = Buffer.from(JSON.stringify(right[0]), "utf8");
    return Buffer.compare(a, b);
  });
}

function parseMessageIdentity(value: string): MessageId {
  try {
    const id = parseMessageId(value);
    if (!/^message:[0-9a-f]{64}$/u.test(id)) throw new Error("invalid message identity");
    return id;
  } catch {
    throw new ReportRepositoryError("invalid", "report source identity is invalid");
  }
}

export function createReportIdentity(
  request: ReportCreateRequest,
  accountId: AccountId,
  principal: string,
): ReportIdentity {
  const parsed = request;
  const sourceMessageIds = parsed.sourceMessageIds.map(parseMessageIdentity);
  if (sourceMessageIds.length > 100)
    throw new ReportRepositoryError("capacity", "report request exceeds configured limit");
  const metadata = parsed.metadata;
  const entries = metadataEntries(metadata);
  const metadataJson = canonicalJsonBytes(entries);
  if (metadataJson.byteLength > REPORT_METADATA_LIMIT_BYTES)
    throw new ReportRepositoryError("capacity", "report request exceeds configured limit");
  const material = canonicalJsonBytes([
    "agent-mail/report-create/v1",
    accountId,
    principal,
    parsed.title,
    sourceMessageIds,
    entries,
  ]);
  if (material.byteLength > REPORT_IDENTITY_LIMIT_BYTES)
    throw new ReportRepositoryError("capacity", "report request exceeds configured limit");
  const fingerprintSha256 = digest(material);
  const requestMaterial = canonicalJsonBytes([
    "agent-mail/report-create-request/v1",
    fingerprintSha256,
  ]);
  return {
    accountId,
    principal,
    title: parsed.title,
    sourceMessageIds,
    metadata,
    reportId: `report:${fingerprintSha256}`,
    fingerprintSha256,
    authorizationRequestId: `request:${digest(requestMaterial)}`,
    identityMaterialJson: material,
    accountIdJson: canonicalJsonStringBytes(accountId),
    principalJson: canonicalJsonStringBytes(principal),
    titleJson: canonicalJsonStringBytes(parsed.title),
    metadataJson,
  };
}

function sourceText(
  value: unknown,
): Readonly<{ text: string; json: Uint8Array; digest: string; bytes: number }> {
  const json = decodeBytes(value, "source text");
  const text = decodeJsonString(json, "source text");
  const emittedBytes = Buffer.byteLength(text, "utf8");
  if (emittedBytes > REPORT_SOURCE_LIMIT_BYTES || json.byteLength > REPORT_SOURCE_JSON_LIMIT_BYTES)
    throw new ReportRepositoryError("capacity", "report request exceeds configured limit");
  return { text, json, digest: digest(json), bytes: emittedBytes };
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new ReportRepositoryError("corrupt", `${name} is invalid`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ReportRepositoryError("corrupt", `${name} is invalid`);
  return value;
}

function reportResponse(
  row: Readonly<Record<string, unknown>>,
  links: readonly Readonly<Record<string, unknown>>[],
): ReportCreateResponse {
  const title = decodeJsonString(row.title_json, "report title");
  const authorizationAt = canonicalInstant(text(row.authorization_at, "authorization time"));
  const citations = links.map((link) => ({
    id: parseMessageIdentity(text(link.message_id, "report source message")),
    label: text(link.citation_label, "citation label"),
  }));
  return {
    reportId: text(row.report_id, "report ID"),
    title,
    citations,
    authorization: {
      principal: decodeJsonString(row.owner_principal_json, "report owner"),
      scope: text(row.create_scope, "report scope"),
      method: "bearer",
      requestId: text(row.authorization_request_id, "report request ID"),
      authorizedAt: authorizationAt,
    },
    createdAt: canonicalInstant(text(row.created_at, "report creation time")),
  };
}

function rowRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ReportRepositoryError("corrupt", `${name} row is invalid`);
  return value;
}

function modelRowCharge(row: Readonly<Record<string, unknown>>): number {
  let total = 0;
  for (const value of Object.values(row)) {
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
    else if (value instanceof Uint8Array) total += value.byteLength;
    else if (typeof value === "number" && Number.isSafeInteger(value)) total += 8;
    else throw new ReportRepositoryError("corrupt", "report charge row contains an invalid value");
  }
  if (!Number.isSafeInteger(total))
    throw new ReportRepositoryError("corrupt", "report charge overflow");
  return total;
}

function addCharge(total: number, row: Readonly<Record<string, unknown>>): number {
  const charge = modelRowCharge(row);
  if (total > REPORT_MAX_CHARGED_BYTES - charge)
    throw new ReportRepositoryError("capacity", "report capacity is exhausted");
  return total + charge;
}

function scanLogicalRows(
  database: Database,
  query: string,
  parameter: Uint8Array,
  name: string,
): Readonly<{ count: number; logicalCharge: number }> {
  let count = 0;
  let logicalCharge = 0;
  const statement = database.query(query);
  for (const row of statement.iterate(parameter)) {
    count += 1;
    logicalCharge = addCharge(logicalCharge, rowRecord(row, name));
  }
  return { count, logicalCharge };
}

function verifyPublicationReadback(database: Database, publication: ReportPublication): void {
  const reportRow = database
    .query("SELECT request_body_sha256, created_at, source_count FROM reports WHERE report_id = ?;")
    .get(publication.identity.reportId);
  if (reportRow === null) throw new ReportRepositoryError("corrupt", "report read-back failed");
  const report = rowRecord(reportRow, "report read-back");
  if (
    text(report.request_body_sha256, "request body digest") !== publication.requestBodySha256 ||
    canonicalInstant(text(report.created_at, "report creation time")) !== publication.createdAt ||
    integer(report.source_count, "report source count") !== publication.sources.length
  )
    throw new ReportRepositoryError("corrupt", "report provenance read-back failed");

  const artifactRow = database
    .query(
      "SELECT model_json, model_sha256, markdown_sha256, html_sha256, csp_sha256, model_bytes, markdown_bytes, html_bytes FROM report_artifacts WHERE report_id = ?;",
    )
    .get(publication.identity.reportId);
  if (artifactRow === null)
    throw new ReportRepositoryError("corrupt", "report artifact read-back failed");
  const artifact = rowRecord(artifactRow, "report artifact read-back");
  const modelJson = decodeCanonicalJson(artifact.model_json, "report model");
  if (
    !equalBytes(modelJson, publication.modelJson) ||
    text(artifact.model_sha256, "model digest") !== publication.modelSha256 ||
    text(artifact.markdown_sha256, "markdown digest") !== publication.markdownSha256 ||
    text(artifact.html_sha256, "HTML digest") !== publication.htmlSha256 ||
    text(artifact.csp_sha256, "CSP digest") !== publication.cspSha256 ||
    integer(artifact.model_bytes, "model bytes") !== publication.modelBytes ||
    integer(artifact.markdown_bytes, "markdown bytes") !== publication.markdownBytes ||
    integer(artifact.html_bytes, "HTML bytes") !== publication.htmlBytes ||
    publication.modelBytes !== modelJson.byteLength
  )
    throw new ReportRepositoryError("corrupt", "report artifact read-back differs");

  for (const [index, source] of publication.sources.entries()) {
    const linkRow = database
      .query(
        "SELECT ordinal, owner_principal_json, account_id_json, message_id, projection_version, citation_label, source_text_sha256 FROM report_sources WHERE report_id = ? AND ordinal = ?;",
      )
      .get(publication.identity.reportId, index + 1);
    const snapshotRow = database
      .query(
        "SELECT owner_principal_json, account_id_json, message_id, projection_version, source_text_json, source_text_sha256, source_text_bytes, created_at FROM report_source_snapshots WHERE owner_principal_json = ? AND account_id_json = ? AND message_id = ? AND projection_version = 1;",
      )
      .get(
        publication.identity.principalJson,
        publication.identity.accountIdJson,
        source.messageId,
      );
    if (linkRow === null || snapshotRow === null)
      throw new ReportRepositoryError("corrupt", "report source read-back failed");
    const link = rowRecord(linkRow, "report source read-back");
    const snapshot = rowRecord(snapshotRow, "report source snapshot read-back");
    const snapshotText = sourceText(snapshot.source_text_json);
    if (
      integer(link.ordinal, "report source ordinal") !== index + 1 ||
      !equalBytes(
        decodeBytes(link.owner_principal_json, "source owner"),
        publication.identity.principalJson,
      ) ||
      !equalBytes(
        decodeBytes(link.account_id_json, "source account"),
        publication.identity.accountIdJson,
      ) ||
      text(link.message_id, "source message") !== source.messageId ||
      integer(link.projection_version, "source projection version") !== 1 ||
      text(link.citation_label, "citation label") !== `Source ${index + 1}` ||
      text(link.source_text_sha256, "source link digest") !== source.sourceTextSha256 ||
      !equalBytes(
        decodeBytes(snapshot.owner_principal_json, "snapshot owner"),
        publication.identity.principalJson,
      ) ||
      !equalBytes(
        decodeBytes(snapshot.account_id_json, "snapshot account"),
        publication.identity.accountIdJson,
      ) ||
      text(snapshot.message_id, "snapshot message") !== source.messageId ||
      integer(snapshot.projection_version, "snapshot projection version") !== 1 ||
      !equalBytes(snapshotText.json, source.sourceTextJson) ||
      snapshotText.digest !== source.sourceTextSha256 ||
      integer(snapshot.source_text_bytes, "snapshot text bytes") !== source.sourceTextBytes ||
      canonicalInstant(text(snapshot.created_at, "snapshot creation time")) !==
        publication.createdAt
    )
      throw new ReportRepositoryError("corrupt", "report source read-back differs");
  }
}

export class ReportCreationRepository {
  readonly #database: Database;
  readonly #accountId: AccountId;
  readonly #accountJson: Uint8Array;
  readonly #options: ReportCreationRepositoryOptions;

  constructor(
    database: Database,
    accountId: AccountId,
    options: ReportCreationRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#accountId = parseAccountId(accountId);
    this.#accountJson = canonicalJsonStringBytes(this.#accountId);
    this.#options = options;
  }

  get accountId(): AccountId {
    return this.#accountId;
  }

  get accountJson(): Uint8Array {
    return bytes(this.#accountJson);
  }

  /** Metadata-only replay projection. Artifact and source text BLOBs are not selected. */
  findReplay(identity: ReportIdentity): ReportCreateResponse | undefined {
    const row = this.#database
      .query(
        "SELECT report_id, fingerprint_sha256, identity_material_json, account_id_json, owner_principal_json, create_scope, read_scope, authorization_method, authorization_request_id, authorization_at, request_body_sha256, created_at, title_json, metadata_json, source_count FROM reports WHERE fingerprint_sha256 = ?;",
      )
      .get(identity.fingerprintSha256);
    if (row === null) return undefined;
    const report = rowRecord(row, "report");
    const storedMaterial = decodeBytes(report.identity_material_json, "report identity material");
    const storedAccount = decodeBytes(report.account_id_json, "report account");
    const storedPrincipal = decodeBytes(report.owner_principal_json, "report owner");
    const storedTitle = canonicalJsonStringBytes(
      decodeJsonString(report.title_json, "report title"),
    );
    const storedMetadata = decodeCanonicalJson(report.metadata_json, "report metadata");
    if (
      text(report.report_id, "report ID") !== identity.reportId ||
      text(report.fingerprint_sha256, "report fingerprint") !== identity.fingerprintSha256 ||
      text(report.authorization_request_id, "report request ID") !==
        identity.authorizationRequestId ||
      !/^[0-9a-f]{64}$/u.test(text(report.request_body_sha256, "report body digest")) ||
      text(report.create_scope, "report create scope") !== "reports:write" ||
      text(report.read_scope, "report read scope") !== "reports:read" ||
      text(report.authorization_method, "report authorization method") !== "bearer" ||
      integer(report.source_count, "report source count") !== identity.sourceMessageIds.length ||
      !equalBytes(storedMaterial, identity.identityMaterialJson) ||
      !equalBytes(storedAccount, identity.accountIdJson) ||
      !equalBytes(storedPrincipal, identity.principalJson) ||
      !equalBytes(storedTitle, identity.titleJson) ||
      !equalBytes(storedMetadata, identity.metadataJson) ||
      canonicalInstant(text(report.authorization_at, "authorization time")) !==
        canonicalInstant(text(report.created_at, "creation time"))
    )
      throw new ReportRepositoryError("corrupt", "report identity collision or corruption");
    const links = this.#database
      .query(
        "SELECT ordinal, owner_principal_json, account_id_json, message_id, projection_version, citation_label, source_text_sha256 FROM report_sources WHERE report_id = ? ORDER BY ordinal;",
      )
      .all(identity.reportId)
      .map((link: unknown) => rowRecord(link, "report source"));
    const artifact = this.#database
      .query(
        "SELECT report_id, model_version, projection_version, renderer_version, model_sha256, markdown_sha256, html_sha256, csp_sha256, model_bytes, markdown_bytes, html_bytes FROM report_artifacts WHERE report_id = ?;",
      )
      .get(identity.reportId);
    if (artifact === null || links.length !== identity.sourceMessageIds.length)
      throw new ReportRepositoryError("corrupt", "report publication graph is incomplete");
    const artifactValue = rowRecord(artifact, "report artifact");
    if (
      text(artifactValue.report_id, "artifact report ID") !== identity.reportId ||
      integer(artifactValue.model_version, "artifact model version") !== 1 ||
      integer(artifactValue.projection_version, "artifact projection version") !== 1 ||
      integer(artifactValue.renderer_version, "artifact renderer version") !== 1 ||
      !/^[0-9a-f]{64}$/u.test(text(artifactValue.model_sha256, "artifact model digest")) ||
      !/^[0-9a-f]{64}$/u.test(text(artifactValue.markdown_sha256, "artifact markdown digest")) ||
      !/^[0-9a-f]{64}$/u.test(text(artifactValue.html_sha256, "artifact HTML digest")) ||
      !/^[0-9a-f]{64}$/u.test(text(artifactValue.csp_sha256, "artifact CSP digest")) ||
      integer(artifactValue.model_bytes, "artifact model bytes") < 1 ||
      integer(artifactValue.markdown_bytes, "artifact markdown bytes") < 1 ||
      integer(artifactValue.html_bytes, "artifact HTML bytes") < 1
    )
      throw new ReportRepositoryError("corrupt", "report artifact metadata is invalid");
    for (const [index, link] of links.entries()) {
      const snapshot = this.#database
        .query(
          "SELECT owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256, source_text_bytes FROM report_source_snapshots WHERE owner_principal_json = ? AND account_id_json = ? AND message_id = ? AND projection_version = 1 AND source_text_sha256 = ?;",
        )
        .get(
          identity.principalJson,
          identity.accountIdJson,
          text(link.message_id, "report source message"),
          text(link.source_text_sha256, "report source digest"),
        );
      const snapshotValue =
        snapshot === null ? undefined : rowRecord(snapshot, "report source snapshot");
      if (
        integer(link.ordinal, "report source ordinal") !== index + 1 ||
        text(link.message_id, "report source message") !== identity.sourceMessageIds[index] ||
        text(link.citation_label, "citation label") !== `Source ${index + 1}` ||
        !equalBytes(
          decodeBytes(link.owner_principal_json, "report source owner"),
          identity.principalJson,
        ) ||
        !equalBytes(
          decodeBytes(link.account_id_json, "report source account"),
          identity.accountIdJson,
        ) ||
        integer(link.projection_version, "report source projection version") !== 1 ||
        !/^[0-9a-f]{64}$/u.test(text(link.source_text_sha256, "report source digest")) ||
        snapshotValue === undefined ||
        !equalBytes(
          decodeBytes(snapshotValue.owner_principal_json, "snapshot owner"),
          identity.principalJson,
        ) ||
        !equalBytes(
          decodeBytes(snapshotValue.account_id_json, "snapshot account"),
          identity.accountIdJson,
        ) ||
        text(snapshotValue.message_id, "snapshot message") !== identity.sourceMessageIds[index] ||
        integer(snapshotValue.projection_version, "snapshot projection version") !== 1 ||
        integer(snapshotValue.source_text_bytes, "snapshot text bytes") < 1
      )
        throw new ReportRepositoryError("corrupt", "report source order is invalid");
    }
    if (integer(report.source_count, "report source count") !== links.length)
      throw new ReportRepositoryError("corrupt", "report publication metadata is invalid");
    return reportResponse(report, links);
  }

  /** Persist exactly one principal rolling admission attempt. */
  admitRate(principalJson: Uint8Array, now: string): boolean {
    const instant = canonicalInstant(now);
    let started = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      started = true;
      const row = this.#database
        .query(
          "SELECT principal_json, attempts_json, last_observed_at FROM report_create_rate_windows WHERE principal_json = ?;",
        )
        .get(principalJson);
      const effectiveNowMs =
        row === null
          ? Date.parse(instant)
          : Math.max(
              Date.parse(instant),
              Date.parse(
                text(rowRecord(row, "rate window").last_observed_at, "last observed time"),
              ),
            );
      const effectiveNow = new Date(effectiveNowMs).toISOString();
      const attempts =
        row === null ? [] : decodeAttempts(rowRecord(row, "rate window").attempts_json);
      const retained = attempts.filter(
        (item) => Date.parse(item) > effectiveNowMs - REPORT_WINDOW_MS,
      );
      if (retained.length >= REPORT_MAX_ATTEMPTS) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      retained.push(effectiveNow);
      const attemptsJson = canonicalJsonBytes(retained);
      if (row === null) {
        this.#options.onWrite?.("report_create_rate_windows");
        this.#database
          .query(
            "INSERT INTO report_create_rate_windows (principal_json, attempts_json, last_observed_at) VALUES (?, ?, ?);",
          )
          .run(principalJson, attemptsJson, effectiveNow);
      } else {
        this.#options.onWrite?.("report_create_rate_windows");
        this.#database
          .query(
            "UPDATE report_create_rate_windows SET attempts_json = ?, last_observed_at = ? WHERE principal_json = ?;",
          )
          .run(attemptsJson, effectiveNow, principalJson);
      }
      const verify = this.#database
        .query(
          "SELECT attempts_json, last_observed_at FROM report_create_rate_windows WHERE principal_json = ?;",
        )
        .get(principalJson);
      const verified = verify === null ? undefined : rowRecord(verify, "rate window");
      if (
        verified === undefined ||
        decodeAttempts(verified.attempts_json).length !== retained.length ||
        canonicalInstant(text(verified.last_observed_at, "last observed time")) !== effectiveNow
      )
        throw new ReportRepositoryError("corrupt", "rate window read-back failed");
      this.#database.exec("COMMIT;");
      return true;
    } catch (error: unknown) {
      if (started) {
        try {
          this.#database.exec("ROLLBACK;");
        } catch {
          /* preserve primary failure */
        }
      }
      if (error instanceof ReportRepositoryError) throw error;
      throw new ReportRepositoryError("storage", "report rate admission failed", { cause: error });
    }
  }

  async resolveSourceEvidence(
    messageIdValue: MessageId,
  ): Promise<ReportSourceEvidence | undefined> {
    const resolvedMessageId = parseMessageIdentity(messageIdValue);
    const exists = this.#database
      .query("SELECT message_id FROM messages WHERE message_id = ?;")
      .get(resolvedMessageId);
    if (exists === null) return undefined;
    const identityOnly = this.#database
      .query("SELECT message_id FROM message_content_states WHERE message_id = ?;")
      .get(resolvedMessageId);
    if (identityOnly !== null) return undefined;
    const active = this.#database
      .query(
        "SELECT 1 FROM remote_placements WHERE message_id = ? AND account_id = ? AND tombstone_observed_at IS NULL LIMIT 1;",
      )
      .get(resolvedMessageId, this.#accountId);
    if (active === null) return undefined;
    let projection = this.#database
      .query(
        "SELECT normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id FROM message_text_projections WHERE message_id = ? AND projection_version = 1;",
      )
      .get(resolvedMessageId);
    if (projection === null && this.#options.materializeLegacyText !== undefined) {
      await this.#options.materializeLegacyText(resolvedMessageId);
      projection = this.#database
        .query(
          "SELECT normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id FROM message_text_projections WHERE message_id = ? AND projection_version = 1;",
        )
        .get(resolvedMessageId);
    }
    if (projection === null) return undefined;
    const row = rowRecord(projection, "message text projection");
    const parsed = sourceText(row.normalized_text_json);
    const raw = this.#database
      .query(
        "SELECT blob_id FROM message_blob_references WHERE message_id = ? AND kind = 'raw-eml' AND ordinal = 1;",
      )
      .get(resolvedMessageId);
    const rawValue = raw === null ? undefined : rowRecord(raw, "raw message reference");
    if (
      parsed.digest !== text(row.normalized_text_sha256, "normalized text digest") ||
      parsed.bytes !== integer(row.normalized_text_utf8_bytes, "normalized text bytes") ||
      text(row.parser_id, "normalized text parser") !== REPORT_PARSER_ID ||
      rawValue === undefined ||
      text(rawValue.blob_id, "raw message digest") !==
        text(row.raw_eml_sha256, "normalized text raw digest") ||
      parsed.text.length === 0
    )
      return undefined;
    return {
      messageId: resolvedMessageId,
      text: parsed.text,
      sourceTextJson: parsed.json,
      sourceTextSha256: parsed.digest,
      sourceTextBytes: parsed.bytes,
    };
  }

  accountCapacity(): Readonly<{ count: number; logicalCharge: number }> {
    const reports = scanLogicalRows(
      this.#database,
      "SELECT report_id, fingerprint_sha256, identity_material_json, account_id_json, owner_principal_json, create_scope, read_scope, authorization_method, authorization_request_id, authorization_at, request_body_sha256, created_at, title_json, metadata_json, source_count FROM reports WHERE account_id_json = ?;",
      this.#accountJson,
      "report",
    );
    const artifacts = scanLogicalRows(
      this.#database,
      "SELECT a.report_id, a.model_version, a.projection_version, a.renderer_version, a.model_json, a.model_sha256, a.markdown_sha256, a.html_sha256, a.csp_sha256, a.model_bytes, a.markdown_bytes, a.html_bytes FROM report_artifacts AS a JOIN reports AS r ON r.report_id = a.report_id WHERE r.account_id_json = ?;",
      this.#accountJson,
      "artifact",
    );
    const snapshots = scanLogicalRows(
      this.#database,
      "SELECT owner_principal_json, account_id_json, message_id, projection_version, source_text_json, source_text_sha256, source_text_bytes, created_at FROM report_source_snapshots WHERE account_id_json = ?;",
      this.#accountJson,
      "snapshot",
    );
    const sources = scanLogicalRows(
      this.#database,
      "SELECT report_id, ordinal, owner_principal_json, account_id_json, message_id, projection_version, citation_label, source_text_sha256 FROM report_sources WHERE account_id_json = ?;",
      this.#accountJson,
      "source",
    );
    const logicalCharge = [reports, artifacts, snapshots, sources].reduce((sum, rows) => {
      if (sum > REPORT_MAX_CHARGED_BYTES - rows.logicalCharge)
        throw new ReportRepositoryError("capacity", "report capacity is exhausted");
      return sum + rows.logicalCharge;
    }, 0);
    return { count: reports.count, logicalCharge };
  }

  publish(publication: ReportPublication): ReportCreateResponse {
    let started = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      started = true;
      const replay = this.findReplay(publication.identity);
      if (replay !== undefined) {
        this.#database.exec("COMMIT;");
        return replay;
      }
      const capacity = this.accountCapacity();
      const prospective = publication.sources.map((source, index) => ({
        report_id: publication.identity.reportId,
        ordinal: index + 1,
        owner_principal_json: publication.identity.principalJson,
        account_id_json: publication.identity.accountIdJson,
        message_id: source.messageId,
        projection_version: 1,
        citation_label: `Source ${index + 1}`,
        source_text_sha256: source.sourceTextSha256,
      }));
      const snapshots = publication.sources.filter((source) => {
        const existing = this.#database
          .query(
            "SELECT owner_principal_json, account_id_json, message_id, projection_version, source_text_json, source_text_sha256, source_text_bytes FROM report_source_snapshots WHERE owner_principal_json = ? AND account_id_json = ? AND message_id = ? AND projection_version = 1;",
          )
          .get(
            publication.identity.principalJson,
            publication.identity.accountIdJson,
            source.messageId,
          );
        if (existing === null) return true;
        const value = rowRecord(existing, "existing report source snapshot");
        const parsed = sourceText(value.source_text_json);
        if (
          !equalBytes(
            decodeBytes(value.owner_principal_json, "snapshot owner"),
            publication.identity.principalJson,
          ) ||
          !equalBytes(
            decodeBytes(value.account_id_json, "snapshot account"),
            publication.identity.accountIdJson,
          ) ||
          text(value.message_id, "snapshot message") !== source.messageId ||
          integer(value.projection_version, "snapshot projection version") !== 1 ||
          !equalBytes(parsed.json, source.sourceTextJson) ||
          parsed.digest !== source.sourceTextSha256 ||
          text(value.source_text_sha256, "snapshot digest") !== source.sourceTextSha256 ||
          integer(value.source_text_bytes, "snapshot text bytes") !== source.sourceTextBytes
        )
          throw new ReportRepositoryError("corrupt", "existing report source snapshot differs");
        return false;
      });
      const reportRow = {
        report_id: publication.identity.reportId,
        fingerprint_sha256: publication.identity.fingerprintSha256,
        identity_material_json: publication.identity.identityMaterialJson,
        account_id_json: publication.identity.accountIdJson,
        owner_principal_json: publication.identity.principalJson,
        create_scope: "reports:write",
        read_scope: "reports:read",
        authorization_method: "bearer",
        authorization_request_id: publication.identity.authorizationRequestId,
        authorization_at: publication.authorizationAt,
        request_body_sha256: publication.requestBodySha256,
        created_at: publication.createdAt,
        title_json: publication.identity.titleJson,
        metadata_json: publication.identity.metadataJson,
        source_count: publication.sources.length,
      };
      const artifactRow = {
        report_id: publication.identity.reportId,
        model_version: 1,
        projection_version: 1,
        renderer_version: 1,
        model_json: publication.modelJson,
        model_sha256: publication.modelSha256,
        markdown_sha256: publication.markdownSha256,
        html_sha256: publication.htmlSha256,
        csp_sha256: publication.cspSha256,
        model_bytes: publication.modelBytes,
        markdown_bytes: publication.markdownBytes,
        html_bytes: publication.htmlBytes,
      };
      const snapshotRows = snapshots.map((source) => ({
        owner_principal_json: publication.identity.principalJson,
        account_id_json: publication.identity.accountIdJson,
        message_id: source.messageId,
        projection_version: 1,
        source_text_json: source.sourceTextJson,
        source_text_sha256: source.sourceTextSha256,
        source_text_bytes: source.sourceTextBytes,
        created_at: publication.createdAt,
      }));
      let prospectiveCharge = 0;
      for (const row of [...snapshotRows, artifactRow, reportRow, ...prospective])
        prospectiveCharge = addCharge(prospectiveCharge, row);
      if (
        capacity.count >= REPORT_MAX_COUNT ||
        capacity.logicalCharge > REPORT_MAX_CHARGED_BYTES - prospectiveCharge
      )
        throw new ReportRepositoryError("capacity", "report capacity is exhausted");
      for (const link of prospective) {
        this.#options.onWrite?.("report_sources");
        this.#database
          .query(
            "INSERT INTO report_sources (report_id, ordinal, owner_principal_json, account_id_json, message_id, projection_version, citation_label, source_text_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
          )
          .run(
            link.report_id,
            link.ordinal,
            link.owner_principal_json,
            link.account_id_json,
            link.message_id,
            link.projection_version,
            link.citation_label,
            link.source_text_sha256,
          );
      }
      for (const row of snapshotRows) {
        this.#options.onWrite?.("report_source_snapshots");
        this.#database
          .query(
            "INSERT INTO report_source_snapshots (owner_principal_json, account_id_json, message_id, projection_version, source_text_json, source_text_sha256, source_text_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
          )
          .run(
            row.owner_principal_json,
            row.account_id_json,
            row.message_id,
            row.projection_version,
            row.source_text_json,
            row.source_text_sha256,
            row.source_text_bytes,
            row.created_at,
          );
      }
      this.#options.onWrite?.("report_artifacts");
      this.#database
        .query(
          "INSERT INTO report_artifacts (report_id, model_version, projection_version, renderer_version, model_json, model_sha256, markdown_sha256, html_sha256, csp_sha256, model_bytes, markdown_bytes, html_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
        )
        .run(
          artifactRow.report_id,
          artifactRow.model_version,
          artifactRow.projection_version,
          artifactRow.renderer_version,
          artifactRow.model_json,
          artifactRow.model_sha256,
          artifactRow.markdown_sha256,
          artifactRow.html_sha256,
          artifactRow.csp_sha256,
          artifactRow.model_bytes,
          artifactRow.markdown_bytes,
          artifactRow.html_bytes,
        );
      this.#options.onWrite?.("reports");
      this.#database
        .query(
          "INSERT INTO reports (report_id, fingerprint_sha256, identity_material_json, account_id_json, owner_principal_json, create_scope, read_scope, authorization_method, authorization_request_id, authorization_at, request_body_sha256, created_at, title_json, metadata_json, source_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
        )
        .run(
          reportRow.report_id,
          reportRow.fingerprint_sha256,
          reportRow.identity_material_json,
          reportRow.account_id_json,
          reportRow.owner_principal_json,
          reportRow.create_scope,
          reportRow.read_scope,
          reportRow.authorization_method,
          reportRow.authorization_request_id,
          reportRow.authorization_at,
          reportRow.request_body_sha256,
          reportRow.created_at,
          reportRow.title_json,
          reportRow.metadata_json,
          reportRow.source_count,
        );
      verifyPublicationReadback(this.#database, publication);
      const result = this.findReplay(publication.identity);
      if (result === undefined)
        throw new ReportRepositoryError("corrupt", "report publication read-back failed");
      this.#database.exec("COMMIT;");
      return result;
    } catch (error: unknown) {
      if (started) {
        try {
          this.#database.exec("ROLLBACK;");
        } catch {
          /* preserve primary failure */
        }
      }
      if (error instanceof ReportRepositoryError) throw error;
      throw new ReportRepositoryError("storage", "report publication failed", { cause: error });
    }
  }

  resolveReport(reportId: string, principalJson: Uint8Array): ReportStoredArtifact | undefined {
    const row = this.#database
      .query(
        "SELECT r.report_id, r.owner_principal_json, r.account_id_json, a.model_version, a.projection_version, a.renderer_version, a.model_json, a.model_sha256, a.markdown_sha256, a.html_sha256, a.csp_sha256, a.model_bytes, a.markdown_bytes, a.html_bytes FROM reports r JOIN report_artifacts a ON a.report_id = r.report_id WHERE r.report_id = ? AND r.owner_principal_json = ? AND r.account_id_json = ?;",
      )
      .get(reportId, principalJson, this.#accountJson);
    if (row === null) return undefined;
    const value = rowRecord(row, "report serving row");
    const modelJson = decodeBytes(value.model_json, "report model");
    const model = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(modelJson));
    return {
      reportId: text(value.report_id, "report ID"),
      owner: decodeJsonString(value.owner_principal_json, "report owner"),
      scope: "reports:read",
      accountId: parseAccountId(decodeJsonString(value.account_id_json, "report account")),
      model,
      modelJson,
      modelSha256: text(value.model_sha256, "model digest"),
      markdownSha256: text(value.markdown_sha256, "markdown digest"),
      htmlSha256: text(value.html_sha256, "HTML digest"),
      cspSha256: text(value.csp_sha256, "CSP digest"),
      modelBytes: integer(value.model_bytes, "model bytes"),
      markdownBytes: integer(value.markdown_bytes, "markdown bytes"),
      htmlBytes: integer(value.html_bytes, "HTML bytes"),
      modelVersion: integer(value.model_version, "model version"),
      projectionVersion: integer(value.projection_version, "projection version"),
      rendererVersion: integer(value.renderer_version, "renderer version"),
    };
  }

  resolveStoredSource(
    messageIdValue: string,
    principalJson: Uint8Array,
  ): ReportStoredSource | undefined {
    const message = parseMessageIdentity(messageIdValue);
    const row = this.#database
      .query(
        "SELECT s.message_id, s.owner_principal_json, s.account_id_json, s.projection_version, s.source_text_json, s.source_text_sha256, s.source_text_bytes FROM report_source_snapshots s WHERE s.message_id = ? AND s.owner_principal_json = ? AND s.account_id_json = ? AND s.projection_version = 1 ORDER BY s.created_at LIMIT 1;",
      )
      .get(message, principalJson, this.#accountJson);
    if (row === null) return undefined;
    const value = rowRecord(row, "source serving row");
    const parsed = sourceText(value.source_text_json);
    if (
      parsed.digest !== text(value.source_text_sha256, "source digest") ||
      parsed.bytes !== integer(value.source_text_bytes, "source bytes")
    )
      throw new ReportRepositoryError("corrupt", "source snapshot integrity failed");
    return {
      messageId: message,
      owner: decodeJsonString(value.owner_principal_json, "source owner"),
      scope: "mail:read.message",
      accountId: parseAccountId(decodeJsonString(value.account_id_json, "source account")),
      text: parsed.text,
      sourceTextJson: parsed.json,
      sourceTextSha256: parsed.digest,
      sourceTextBytes: parsed.bytes,
      projectionVersion: integer(value.projection_version, "projection version"),
    };
  }

  /** Serving adapter uses the same durable snapshot rows as report creation. */
  resolveSource(messageIdValue: string, principalJson: Uint8Array): ReportStoredSource | undefined {
    return this.resolveStoredSource(messageIdValue, principalJson);
  }
}

function decodeAttempts(value: unknown): string[] {
  const raw = decodeBytes(value, "rate attempts");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ReportRepositoryError("corrupt", "rate attempts are invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > REPORT_MAX_ATTEMPTS ||
    parsed.some((item) => typeof item !== "string")
  )
    throw new ReportRepositoryError("corrupt", "rate attempts are invalid");
  const attempts = parsed.map((item) => canonicalInstant(item));
  if (JSON.stringify(attempts) !== new TextDecoder("utf-8", { fatal: true }).decode(raw))
    throw new ReportRepositoryError("corrupt", "rate attempts are not canonical");
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1];
    const current = attempts[index];
    if (
      previous === undefined ||
      current === undefined ||
      Date.parse(current) < Date.parse(previous)
    )
      throw new ReportRepositoryError("corrupt", "rate attempts are not nondecreasing");
  }
  return attempts;
}
