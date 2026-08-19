import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { runMigrations, migrationContentHash } from "./migration-runner";
import {
  CANONICAL_DATABASE_SCHEMA_VERSION,
  canonicalDatabaseMigrations,
} from "./migration-registry";
import { applySearchReindexSchema } from "./search-reindex";

const SHA256 = /^[0-9a-f]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BACKUP_ID = /^backup:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const OVERLAY_IDS = Object.freeze([
  "O-REINDEX-ABSENT",
  "O-REINDEX-PARTIAL-EMPTY",
  "O-REINDEX-IDLE",
  "O-REINDEX-BUILDING-EMPTY-ABSENT",
  "O-REINDEX-BUILDING-EMPTY-PRESENT",
  "O-REINDEX-BUILDING",
  "O-REINDEX-ACTIVATING",
] as const);

const CONVERSION_TABLE_SQL =
  "CREATE TABLE schema_migration_conversions (conversion_id TEXT PRIMARY KEY NOT NULL CHECK (length(conversion_id) = 85 AND substr(conversion_id, 1, 21) = 'migration-conversion:' AND substr(conversion_id, 22) NOT GLOB '*[^0-9a-f]*'), source_user_version INTEGER NOT NULL CHECK (typeof(source_user_version) = 'integer' AND source_user_version >= 0), source_history_json TEXT NOT NULL CHECK (json_valid(source_history_json) AND json_type(source_history_json) = 'array'), source_history_sha256 TEXT NOT NULL CHECK (length(source_history_sha256) = 64 AND source_history_sha256 NOT GLOB '*[^0-9a-f]*'), source_overlay_id TEXT NOT NULL CHECK (source_overlay_id IN ('O-REINDEX-ABSENT', 'O-REINDEX-PARTIAL-EMPTY', 'O-REINDEX-IDLE', 'O-REINDEX-BUILDING-EMPTY-ABSENT', 'O-REINDEX-BUILDING-EMPTY-PRESENT', 'O-REINDEX-BUILDING', 'O-REINDEX-ACTIVATING')), source_overlay_json TEXT NOT NULL CHECK (json_valid(source_overlay_json) AND json_type(source_overlay_json) = 'array'), source_overlay_sha256 TEXT NOT NULL CHECK (length(source_overlay_sha256) = 64 AND source_overlay_sha256 NOT GLOB '*[^0-9a-f]*'), source_schema_json TEXT NOT NULL CHECK (json_valid(source_schema_json) AND json_type(source_schema_json) = 'array'), source_schema_sha256 TEXT NOT NULL CHECK (length(source_schema_sha256) = 64 AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'), target_registry_sha256 TEXT NOT NULL CHECK (length(target_registry_sha256) = 64 AND target_registry_sha256 NOT GLOB '*[^0-9a-f]*'), backup_id TEXT NOT NULL CHECK (length(backup_id) BETWEEN 8 AND 135 AND substr(backup_id, 1, 7) = 'backup:' AND substr(backup_id, 8, 1) GLOB '[A-Za-z0-9]' AND substr(backup_id, 8) NOT GLOB '*[^A-Za-z0-9._-]*'), backup_manifest_sha256 TEXT NOT NULL CHECK (length(backup_manifest_sha256) = 64 AND backup_manifest_sha256 NOT GLOB '*[^0-9a-f]*'), completed_at TEXT NOT NULL CHECK (length(completed_at) = 24 AND completed_at GLOB '????-??-??T??:??:??.???Z'), record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*')) STRICT";
const CONVERSION_INDEX_SQL =
  "CREATE UNIQUE INDEX schema_migration_conversions_source_identity ON schema_migration_conversions (source_history_sha256, source_overlay_sha256, source_schema_sha256, target_registry_sha256)";
const CONVERSION_INSERT_GATE_SQL =
  "CREATE TRIGGER schema_migration_conversions_insert_gate BEFORE INSERT ON schema_migration_conversions BEGIN SELECT RAISE(ABORT, 'migration conversion insert is not authorized'); END";
const CONVERSION_UPDATE_TRIGGER_SQL =
  "CREATE TRIGGER schema_migration_conversions_no_update BEFORE UPDATE ON schema_migration_conversions BEGIN SELECT RAISE(ABORT, 'migration conversion provenance is immutable'); END";
const CONVERSION_DELETE_TRIGGER_SQL =
  "CREATE TRIGGER schema_migration_conversions_no_delete BEFORE DELETE ON schema_migration_conversions BEGIN SELECT RAISE(ABORT, 'migration conversion provenance is immutable'); END";

const CONVERSION_COLUMNS = Object.freeze([
  "conversion_id",
  "source_user_version",
  "source_history_json",
  "source_history_sha256",
  "source_overlay_id",
  "source_overlay_json",
  "source_overlay_sha256",
  "source_schema_json",
  "source_schema_sha256",
  "target_registry_sha256",
  "backup_id",
  "backup_manifest_sha256",
  "completed_at",
  "record_sha256",
] as const);

export type MigrationHistoryClassificationKind =
  | "supported-empty"
  | "supported-canonical-prefix"
  | "supported-legacy"
  | "newer"
  | "corrupt"
  | "unknown"
  | "placeholder"
  | "schema-mismatch";

export type MigrationHistoryTuple = readonly [number, string, string];
export type SchemaTuple = readonly ["table" | "index" | "trigger" | "view", string, string, string];

export type MigrationOverlaySnapshot = Readonly<{
  readonly id: (typeof OVERLAY_IDS)[number];
  readonly lease:
    | readonly [number, string, string, "building" | "activating", number, number]
    | null;
  readonly progress: readonly (readonly [string, number, string])[];
  readonly objects: readonly SchemaTuple[];
  readonly sourceRows: readonly (readonly [
    number,
    string,
    string,
    string,
    string,
    string,
    string,
  ])[];
  readonly replacementDocsizeRowids: readonly number[];
}>;

export type MigrationHistoryClassification = Readonly<{
  readonly classification: MigrationHistoryClassificationKind;
  readonly userVersion: number;
  readonly history: readonly MigrationHistoryTuple[];
  readonly migrationIds: readonly string[];
  readonly overlay: MigrationOverlaySnapshot;
  readonly schema: readonly SchemaTuple[];
  readonly reason?: string;
}>;

export type ConversionBackupProof = Readonly<{
  readonly backupId: string;
  readonly manifestSha256: string;
  readonly createdAt: string;
}>;

export type ConversionOptions = Readonly<{
  readonly backup?: () => ConversionBackupProof | Promise<ConversionBackupProof>;
  readonly backupProof?: ConversionBackupProof;
  readonly now?: () => Date;
  readonly beforeCommit?: () => void;
}>;

export class MigrationHistoryConversionError extends Error {
  readonly code:
    | "unsupported-history"
    | "newer-schema"
    | "schema-mismatch"
    | "provenance-invalid"
    | "conversion-failed";

  constructor(
    code: MigrationHistoryConversionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationHistoryConversionError";
    this.code = code;
  }
}

type RecordValue = Readonly<Record<string, unknown>>;
type DatabaseLike = Pick<Database, "exec" | "query">;
type ReindexLease = Readonly<{
  readonly lease_id: number;
  readonly operation_name: string;
  readonly replacement_name: string;
  readonly phase: "building" | "activating";
  readonly last_rowid: number;
  readonly processed_rows: number;
}>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isReindexLease(value: unknown): value is ReindexLease {
  if (!isRecord(value)) return false;
  return (
    isSafeInteger(value.lease_id) &&
    typeof value.operation_name === "string" &&
    OPERATION.test(value.operation_name) &&
    typeof value.replacement_name === "string" &&
    value.replacement_name === replacementName(value.operation_name) &&
    (value.phase === "building" || value.phase === "activating") &&
    isSafeInteger(value.last_rowid) &&
    isSafeInteger(value.processed_rows)
  );
}

function isDatabase(value: unknown): value is DatabaseLike {
  return isRecord(value) && typeof value.exec === "function" && typeof value.query === "function";
}

function getDatabase(value: unknown): DatabaseLike {
  if (isDatabase(value)) return value;
  if (isRecord(value) && isDatabase(value.db)) return value.db;
  throw new MigrationHistoryConversionError(
    "unsupported-history",
    "database connection is invalid",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function registryDigest(): string {
  return sha256(
    JSON.stringify(
      canonicalDatabaseMigrations.map((migration) => [
        migration.version,
        migration.name,
        migrationContentHash(migration),
        migration.requiresForeignKeysOff === true,
      ]),
    ),
  );
}

export const CANONICAL_DATABASE_REGISTRY_SHA256 = registryDigest();

function hasObject(database: DatabaseLike, name: string): boolean {
  return database.query("SELECT 1 AS present FROM sqlite_schema WHERE name = ?").get(name) !== null;
}

function schemaRows(database: DatabaseLike): SchemaTuple[] {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql",
    )
    .all()
    .map((row: unknown) => {
      if (
        !isRecord(row) ||
        !isSchemaType(row.type) ||
        typeof row.name !== "string" ||
        typeof row.tbl_name !== "string" ||
        typeof row.sql !== "string"
      ) {
        throw new MigrationHistoryConversionError("schema-mismatch", "schema tuple is invalid");
      }
      return [row.type, row.name, row.tbl_name, row.sql] as SchemaTuple;
    });
}

function decodeSchemaTuples(value: unknown, label: string): SchemaTuple[] {
  if (!Array.isArray(value))
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} is not an array`);
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 4 ||
      !isSchemaType(entry[0]) ||
      typeof entry[1] !== "string" ||
      entry[1].length === 0 ||
      typeof entry[2] !== "string" ||
      entry[2].length === 0 ||
      typeof entry[3] !== "string" ||
      entry[3].length === 0 ||
      names.has(entry[1])
    ) {
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} contains an invalid or duplicate schema tuple`,
      );
    }
    names.add(entry[1]);
    return [entry[0], entry[1], entry[2], entry[3]] as SchemaTuple;
  });
}

function isSchemaType(value: unknown): value is SchemaTuple[0] {
  return value === "table" || value === "index" || value === "trigger" || value === "view";
}

function migrationRows(database: DatabaseLike): MigrationHistoryTuple[] {
  const rows: readonly unknown[] = database
    .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
    .all();
  return rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      !isSafeInteger(row.version) ||
      typeof row.name !== "string" ||
      typeof row.content_hash !== "string"
    ) {
      throw new MigrationHistoryConversionError(
        "unsupported-history",
        "migration history is invalid",
      );
    }
    return [row.version, row.name, row.content_hash];
  });
}

function userVersion(database: DatabaseLike): number {
  const row: unknown = database.query("PRAGMA user_version").get();
  if (!isRecord(row) || !isSafeInteger(row.user_version) || row.user_version < 0) {
    throw new MigrationHistoryConversionError(
      "unsupported-history",
      "database user_version is invalid",
    );
  }
  return row.user_version;
}

function canonicalHistory(): MigrationHistoryTuple[] {
  return canonicalDatabaseMigrations.map((migration) => [
    migration.version,
    migration.name,
    migrationContentHash(migration),
  ]);
}

function identityMap(): Map<string, string> {
  return new Map(
    canonicalDatabaseMigrations.map((migration) => [
      `${migration.name}\0${migrationContentHash(migration)}`,
      migration.name,
    ]),
  );
}

function decodeHistory(history: readonly MigrationHistoryTuple[], version: number): string[] {
  if (history.length !== version)
    throw new MigrationHistoryConversionError(
      "unsupported-history",
      "migration history and user_version differ",
    );
  let previous = 0;
  const seen = new Set<string>();
  const ids: string[] = [];
  const identities = identityMap();
  for (const row of history) {
    if (
      !Number.isSafeInteger(row[0]) ||
      row[0] !== previous + 1 ||
      !row[1] ||
      !SHA256.test(row[2])
    ) {
      throw new MigrationHistoryConversionError(
        "unsupported-history",
        "migration history is not contiguous",
      );
    }
    const id = identities.get(`${row[1]}\0${row[2]}`);
    if (id === undefined || seen.has(id)) {
      throw new MigrationHistoryConversionError(
        "unsupported-history",
        "migration history identity is unknown or duplicated",
      );
    }
    seen.add(id);
    ids.push(id);
    previous = row[0];
  }
  return ids;
}

function decodeHistoryTuples(value: unknown, label: string): MigrationHistoryTuple[] {
  if (!Array.isArray(value))
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} is not an array`);
  return value.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !isSafeInteger(entry[0]) ||
      entry[0] <= 0 ||
      typeof entry[1] !== "string" ||
      entry[1].length === 0 ||
      typeof entry[2] !== "string" ||
      !SHA256.test(entry[2])
    )
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} contains an invalid tuple`,
      );
    return [entry[0], entry[1], entry[2]];
  });
}

function canonicalPrefix(ids: readonly string[]): boolean {
  return ids.every((id, index) => canonicalDatabaseMigrations[index]?.name === id);
}

function expectedSchema(ids: readonly string[]): SchemaTuple[] {
  const definitions = ids.map((id, index) => {
    const definition = canonicalDatabaseMigrations.find((migration) => migration.name === id);
    if (definition === undefined)
      throw new MigrationHistoryConversionError(
        "unsupported-history",
        "migration identity is unknown",
      );
    return { ...definition, version: index + 1 };
  });
  const reference = new Database(":memory:", { strict: true });
  try {
    reference.exec("PRAGMA foreign_keys = ON");
    runMigrations(reference, definitions);
    return schemaRows(reference).filter(
      (row) =>
        row[1] !== "schema_migrations" &&
        row[1] !== "search_reindex_lease" &&
        row[1] !== "search_reindex_progress",
    );
  } finally {
    reference.close();
  }
}

function compareTuples(left: readonly unknown[], right: readonly unknown[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = String(left[index]);
    const b = String(right[index]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replacementName(operationName: string): string {
  return `message_fts_replacement_${sha256(operationName).slice(0, 16)}`;
}

function replacementObjects(database: DatabaseLike, name: string): SchemaTuple[] {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ? OR name LIKE ? ORDER BY type, name, tbl_name, sql",
    )
    .all(name, `${name}_%`)
    .map((row: unknown) => {
      if (
        !isRecord(row) ||
        !isSchemaType(row.type) ||
        typeof row.name !== "string" ||
        typeof row.tbl_name !== "string" ||
        typeof row.sql !== "string"
      ) {
        throw new MigrationHistoryConversionError("schema-mismatch", "reindex object is invalid");
      }
      return [row.type, row.name, row.tbl_name, row.sql] as SchemaTuple;
    });
}

function expectedReplacementObjects(name: string): SchemaTuple[] {
  if (!/^message_fts_replacement_[0-9a-f]{16}$/u.test(name))
    throw new MigrationHistoryConversionError("schema-mismatch", "replacement name is invalid");
  const reference = new Database(":memory:", { strict: true });
  try {
    reference.exec(
      `CREATE VIRTUAL TABLE "${name}" USING fts5(subject, participants, body_plain, body_html, attachment_names, content='indexed_messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
    );
    return replacementObjects(reference, name);
  } finally {
    reference.close();
  }
}

function expectedReindexControlObjects(): SchemaTuple[] {
  const reference = new Database(":memory:", { strict: true });
  try {
    applySearchReindexSchema(reference);
    return schemaRows(reference).filter(
      (row) => row[1] === "search_reindex_lease" || row[1] === "search_reindex_progress",
    );
  } finally {
    reference.close();
  }
}

function strictOverlay(value: unknown, label: string): MigrationOverlaySnapshot {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== "agent-mail/search-reindex-overlay/v1"
  )
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} envelope is invalid`);
  const id = value[1];
  if (!OVERLAY_IDS.includes(id as (typeof OVERLAY_IDS)[number]))
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} identity is invalid`);

  const leaseValue = value[2];
  let lease: MigrationOverlaySnapshot["lease"];
  if (leaseValue === null) {
    lease = null;
  } else if (
    Array.isArray(leaseValue) &&
    leaseValue.length === 6 &&
    isSafeInteger(leaseValue[0]) &&
    leaseValue[0] === 1 &&
    typeof leaseValue[1] === "string" &&
    OPERATION.test(leaseValue[1]) &&
    typeof leaseValue[2] === "string" &&
    leaseValue[2] === replacementName(leaseValue[1]) &&
    (leaseValue[3] === "building" || leaseValue[3] === "activating") &&
    isSafeInteger(leaseValue[4]) &&
    leaseValue[4] >= 0 &&
    isSafeInteger(leaseValue[5]) &&
    leaseValue[5] >= 0
  ) {
    lease = [
      leaseValue[0],
      leaseValue[1],
      leaseValue[2],
      leaseValue[3],
      leaseValue[4],
      leaseValue[5],
    ];
  } else {
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} lease is invalid`);
  }

  if (!Array.isArray(value[3]))
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} progress is invalid`);
  const progress: Array<readonly [string, number, string]> = [];
  const progressIds = new Set<number>();
  for (const entry of value[3]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      typeof entry[2] !== "string" ||
      !SHA256.test(entry[2]) ||
      !isSafeInteger(entry[1]) ||
      entry[1] <= 0 ||
      progressIds.has(entry[1])
    ) {
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} progress row is invalid`,
      );
    }
    progressIds.add(entry[1]);
    progress.push([entry[0], entry[1], entry[2]]);
  }

  const objects = decodeSchemaTuples(value[4], `${label} objects`);
  const sourceRowsValue = value[5];
  if (!Array.isArray(sourceRowsValue))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} source rows are invalid`,
    );
  const sourceRows: MigrationOverlaySnapshot["sourceRows"][number][] = [];
  const sourceIds = new Set<number>();
  let previousSourceId = 0;
  for (const entry of sourceRowsValue) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 7 ||
      !isSafeInteger(entry[0]) ||
      entry[0] <= 0 ||
      entry[0] <= previousSourceId ||
      sourceIds.has(entry[0]) ||
      entry.slice(1).some((item) => typeof item !== "string")
    ) {
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} source row is invalid`,
      );
    }
    previousSourceId = entry[0];
    sourceIds.add(entry[0]);
    sourceRows.push([entry[0], entry[1], entry[2], entry[3], entry[4], entry[5], entry[6]]);
  }

  if (!Array.isArray(value[6]))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} docsize IDs are invalid`,
    );
  const replacementDocsizeRowids: number[] = [];
  let previousDocsizeId = 0;
  for (const entry of value[6]) {
    if (!isSafeInteger(entry) || entry <= 0 || entry <= previousDocsizeId) {
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} docsize ID is invalid`,
      );
    }
    previousDocsizeId = entry;
    replacementDocsizeRowids.push(entry);
  }

  const snapshot: MigrationOverlaySnapshot = {
    id: id as (typeof OVERLAY_IDS)[number],
    lease,
    progress,
    objects,
    sourceRows,
    replacementDocsizeRowids,
  };
  const controls = expectedReindexControlObjects();
  const replacementNames = objects.filter((row) => row[1].startsWith("message_fts_replacement_"));
  const replacementNameValue = lease?.[2];
  if (
    lease === null &&
    (progress.length !== 0 || sourceRows.length !== 0 || replacementDocsizeRowids.length !== 0)
  )
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} has state without a lease`,
    );
  if (lease !== null) {
    if (progress.some((row) => row[0] !== replacementNameValue))
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} progress lease relation is invalid`,
      );
    if (
      snapshot.id === "O-REINDEX-BUILDING-EMPTY-ABSENT" ||
      snapshot.id === "O-REINDEX-BUILDING-EMPTY-PRESENT"
    ) {
      if (
        lease[3] !== "building" ||
        lease[4] !== 0 ||
        lease[5] !== 0 ||
        progress.length !== 0 ||
        sourceRows.length !== 0 ||
        replacementDocsizeRowids.length !== 0
      )
        throw new MigrationHistoryConversionError(
          "provenance-invalid",
          `${label} empty building state is invalid`,
        );
    } else if (snapshot.id === "O-REINDEX-BUILDING" || snapshot.id === "O-REINDEX-ACTIVATING") {
      if (
        replacementNames.length === 0 ||
        progress.length === 0 ||
        lease[5] !== progress.length ||
        lease[4] !== progress.at(-1)?.[1]
      )
        throw new MigrationHistoryConversionError(
          "provenance-invalid",
          `${label} active progress state is invalid`,
        );
      const progressSet = new Set(progress.map((row) => row[1]));
      const docsizeSet = new Set(replacementDocsizeRowids);
      if (
        progressSet.size !== docsizeSet.size ||
        [...progressSet].some((id) => !docsizeSet.has(id))
      )
        throw new MigrationHistoryConversionError(
          "provenance-invalid",
          `${label} progress/docsize ID sets differ`,
        );
      const sourceById = new Map(sourceRows.map((row) => [row[0], row]));
      for (const [, sourceId, digest] of progress) {
        const source = sourceById.get(sourceId);
        if (source === undefined || sha256(JSON.stringify(source)) !== digest)
          throw new MigrationHistoryConversionError(
            "provenance-invalid",
            `${label} progress source row is invalid`,
          );
      }
      if (snapshot.id === "O-REINDEX-ACTIVATING" && lease[5] !== sourceRows.length)
        throw new MigrationHistoryConversionError(
          "provenance-invalid",
          `${label} activating state is incomplete`,
        );
    }
  }
  if (
    snapshot.id === "O-REINDEX-ABSENT" &&
    (lease !== null ||
      progress.length !== 0 ||
      objects.length !== 0 ||
      sourceRows.length !== 0 ||
      replacementDocsizeRowids.length !== 0)
  )
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} absent state is not empty`,
    );
  if (snapshot.id === "O-REINDEX-PARTIAL-EMPTY" && !equalJson(objects, controls.slice(0, 1)))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} partial state is invalid`,
    );
  if (snapshot.id === "O-REINDEX-IDLE" && !equalJson(objects, controls))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} idle state is invalid`,
    );
  if (snapshot.id === "O-REINDEX-BUILDING-EMPTY-ABSENT" && !equalJson(objects, controls))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} empty absent state is invalid`,
    );
  if (replacementNames.length > 0) {
    if (
      replacementNameValue === undefined ||
      replacementNames[0][1] !== replacementNameValue ||
      !equalJson(
        objects,
        [...controls, ...expectedReplacementObjects(replacementNameValue)].sort(compareTuples),
      )
    )
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        `${label} replacement object family is invalid`,
      );
  } else if (lease !== null && snapshot.id === "O-REINDEX-BUILDING-EMPTY-PRESENT") {
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} empty present state is missing objects`,
    );
  }
  return snapshot;
}

function finalizeOverlay(snapshot: MigrationOverlaySnapshot): MigrationOverlaySnapshot {
  return strictOverlay(
    [
      "agent-mail/search-reindex-overlay/v1",
      snapshot.id,
      snapshot.lease,
      snapshot.progress,
      snapshot.objects,
      snapshot.sourceRows,
      snapshot.replacementDocsizeRowids,
    ],
    "database reindex overlay",
  );
}

function reindexSourceRows(
  database: DatabaseLike,
): readonly (readonly [number, string, string, string, string, string, string])[] {
  return database
    .query(
      "SELECT rowid, message_id, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages ORDER BY rowid",
    )
    .all()
    .map((row: unknown) => {
      if (
        !isRecord(row) ||
        !isSafeInteger(row.rowid) ||
        row.rowid <= 0 ||
        typeof row.message_id !== "string" ||
        typeof row.subject !== "string" ||
        typeof row.participants !== "string" ||
        typeof row.body_plain !== "string" ||
        typeof row.body_html !== "string" ||
        typeof row.attachment_names !== "string"
      ) {
        throw new MigrationHistoryConversionError(
          "schema-mismatch",
          "indexed message source row is invalid",
        );
      }
      return [
        row.rowid,
        row.message_id,
        row.subject,
        row.participants,
        row.body_plain,
        row.body_html,
        row.attachment_names,
      ] as const;
    });
}

function overlay(database: DatabaseLike): MigrationOverlaySnapshot {
  const leasePresent = hasObject(database, "search_reindex_lease");
  const progressPresent = hasObject(database, "search_reindex_progress");
  const controls = schemaRows(database).filter(
    (row) => row[1] === "search_reindex_lease" || row[1] === "search_reindex_progress",
  );
  if (!leasePresent && !progressPresent) {
    const objects = schemaRows(database).filter((row) =>
      row[1].startsWith("message_fts_replacement_"),
    );
    if (objects.length !== 0)
      throw new MigrationHistoryConversionError(
        "schema-mismatch",
        "orphan reindex replacement objects",
      );
    return finalizeOverlay({
      id: "O-REINDEX-ABSENT",
      lease: null,
      progress: [],
      objects: [],
      sourceRows: [],
      replacementDocsizeRowids: [],
    });
  }
  const expectedControls = (() => {
    const reference = new Database(":memory:", { strict: true });
    try {
      applySearchReindexSchema(reference);
      return schemaRows(reference).filter(
        (row) => row[1] === "search_reindex_lease" || row[1] === "search_reindex_progress",
      );
    } finally {
      reference.close();
    }
  })();
  if (controls.length === 1) {
    if (!equalJson(controls, expectedControls.slice(0, 1)))
      throw new MigrationHistoryConversionError(
        "schema-mismatch",
        "partial reindex schema is invalid",
      );
    const count = database.query("SELECT count(*) AS count FROM search_reindex_lease").get();
    if (!isRecord(count) || count.count !== 0)
      throw new MigrationHistoryConversionError(
        "schema-mismatch",
        "partial reindex schema has state",
      );
    return finalizeOverlay({
      id: "O-REINDEX-PARTIAL-EMPTY",
      lease: null,
      progress: [],
      objects: controls,
      sourceRows: [],
      replacementDocsizeRowids: [],
    });
  }
  if (!equalJson(controls, expectedControls))
    throw new MigrationHistoryConversionError(
      "schema-mismatch",
      "reindex control schema is invalid",
    );
  const leases: readonly unknown[] = database
    .query(
      "SELECT lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows FROM search_reindex_lease ORDER BY lease_id",
    )
    .all();
  const progress: readonly unknown[] = database
    .query(
      "SELECT replacement_name, source_rowid, source_digest FROM search_reindex_progress ORDER BY replacement_name, source_rowid",
    )
    .all();
  if (leases.length === 0) {
    if (
      progress.length !== 0 ||
      schemaRows(database).some((row) => row[1].startsWith("message_fts_replacement_"))
    )
      throw new MigrationHistoryConversionError(
        "schema-mismatch",
        "idle reindex overlay has orphan state",
      );
    return finalizeOverlay({
      id: "O-REINDEX-IDLE",
      lease: null,
      progress: [],
      objects: controls,
      sourceRows: [],
      replacementDocsizeRowids: [],
    });
  }
  const lease = leases[0];
  if (leases.length !== 1 || !isReindexLease(lease) || lease.lease_id !== 1) {
    throw new MigrationHistoryConversionError("schema-mismatch", "reindex lease is invalid");
  }
  const name = lease.replacement_name;
  const replacements = schemaRows(database).filter((row) =>
    row[1].startsWith("message_fts_replacement_"),
  );
  const family = replacements.length === 0 ? [] : expectedReplacementObjects(name);
  if (!equalJson(replacements, family))
    throw new MigrationHistoryConversionError(
      "schema-mismatch",
      "reindex replacement object family is invalid",
    );
  const decodedProgress = progress.map((row: unknown) => {
    if (
      !isRecord(row) ||
      row.replacement_name !== name ||
      !isSafeInteger(row.source_rowid) ||
      row.source_rowid <= 0 ||
      typeof row.source_digest !== "string" ||
      !SHA256.test(row.source_digest)
    )
      throw new MigrationHistoryConversionError("schema-mismatch", "reindex progress is invalid");
    const replacement = row.replacement_name;
    const sourceRowid = row.source_rowid;
    const sourceDigest = row.source_digest;
    return [replacement, sourceRowid, sourceDigest] as const;
  });
  const empty =
    lease.last_rowid === 0 && lease.processed_rows === 0 && decodedProgress.length === 0;
  if (empty)
    return finalizeOverlay({
      id:
        family.length === 0
          ? "O-REINDEX-BUILDING-EMPTY-ABSENT"
          : "O-REINDEX-BUILDING-EMPTY-PRESENT",
      lease: [
        lease.lease_id,
        lease.operation_name,
        lease.replacement_name,
        lease.phase,
        lease.last_rowid,
        lease.processed_rows,
      ],
      progress: decodedProgress,
      objects: [...controls, ...replacements].sort(compareTuples),
      sourceRows: [],
      replacementDocsizeRowids: [],
    });
  const sourceRows = reindexSourceRows(database);
  const sourceDigests = new Map(sourceRows.map((row) => [row[0], sha256(JSON.stringify(row))]));
  for (const progressRow of decodedProgress) {
    if (sourceDigests.get(progressRow[1]) !== progressRow[2]) {
      throw new MigrationHistoryConversionError(
        "schema-mismatch",
        "reindex source digest does not match progress",
      );
    }
  }
  const replacementDocsizeRowids = database
    .query(`SELECT id FROM "${name}_docsize" ORDER BY id`)
    .all()
    .map((row: unknown) => {
      if (!isRecord(row) || !isSafeInteger(row.id))
        throw new MigrationHistoryConversionError("schema-mismatch", "reindex docsize is invalid");
      return row.id;
    });
  const indexedCountRow: unknown = database
    .query("SELECT count(*) AS count FROM indexed_messages")
    .get();
  const indexedCount =
    isRecord(indexedCountRow) && isSafeInteger(indexedCountRow.count)
      ? indexedCountRow.count
      : undefined;
  if (
    lease.processed_rows !== decodedProgress.length ||
    lease.last_rowid !== decodedProgress.at(-1)?.[1] ||
    replacementDocsizeRowids.length !== decodedProgress.length ||
    (lease.phase === "activating" && lease.processed_rows !== indexedCount)
  )
    throw new MigrationHistoryConversionError("schema-mismatch", "reindex counters are invalid");
  const id = lease.phase === "activating" ? "O-REINDEX-ACTIVATING" : "O-REINDEX-BUILDING";
  return finalizeOverlay({
    id,
    lease: [
      lease.lease_id,
      lease.operation_name,
      lease.replacement_name,
      lease.phase,
      lease.last_rowid,
      lease.processed_rows,
    ],
    progress: decodedProgress,
    objects: [...controls, ...replacements].sort(compareTuples),
    sourceRows,
    replacementDocsizeRowids,
  });
}

function baseSchema(database: DatabaseLike): SchemaTuple[] {
  const excluded = new Set<string>([
    "schema_migrations",
    "schema_migration_conversions",
    "schema_migration_conversions_source_identity",
    "schema_migration_conversions_insert_gate",
    "schema_migration_conversions_no_update",
    "schema_migration_conversions_no_delete",
    "search_reindex_lease",
    "search_reindex_progress",
  ]);
  const over = overlay(database);
  for (const row of over.objects) excluded.add(row[1]);
  return schemaRows(database).filter((row) => !excluded.has(row[1]));
}

function historyClassification(database: DatabaseLike): MigrationHistoryClassification {
  const version = userVersion(database);
  if (version > CANONICAL_DATABASE_SCHEMA_VERSION)
    return {
      classification: "newer",
      userVersion: version,
      history: [],
      migrationIds: [],
      overlay: emptyOverlay(),
      schema: [],
    };
  if (!hasObject(database, "schema_migrations")) {
    if (version === 0 && schemaRows(database).length === 0)
      return {
        classification: "supported-empty",
        userVersion: 0,
        history: [],
        migrationIds: [],
        overlay: emptyOverlay(),
        schema: [],
      };
    return {
      classification: "unknown",
      userVersion: version,
      history: [],
      migrationIds: [],
      overlay: emptyOverlay(),
      schema: [],
      reason: "migration ledger is absent",
    };
  }
  if (conversionInfrastructurePresent(database)) {
    try {
      verifyConversionInfrastructure(database);
    } catch (error: unknown) {
      return {
        classification: "schema-mismatch",
        userVersion: version,
        history: [],
        migrationIds: [],
        overlay: emptyOverlay(),
        schema: [],
        reason: error instanceof Error ? error.message : "conversion infrastructure is invalid",
      };
    }
  }
  const history = migrationRows(database);
  const placeholderName = "test-" + "action-chain-placeholder";
  if (history.some((row) => row[1] === placeholderName))
    return {
      classification: "placeholder",
      userVersion: version,
      history,
      migrationIds: [],
      overlay: emptyOverlay(),
      schema: [],
      reason: "placeholder history is unsupported",
    };
  let ids: string[];
  try {
    ids = decodeHistory(history, version);
  } catch (error: unknown) {
    return {
      classification: "unknown",
      userVersion: version,
      history,
      migrationIds: [],
      overlay: emptyOverlay(),
      schema: [],
      reason: error instanceof Error ? error.message : "history is unsupported",
    };
  }
  let over: MigrationOverlaySnapshot;
  try {
    over = overlay(database);
    const expected = expectedSchema(ids);
    const actual = baseSchema(database);
    const integrity: unknown = database.query("PRAGMA integrity_check").get();
    if (
      !equalJson(actual, expected) ||
      !isRecord(integrity) ||
      integrity.integrity_check !== "ok" ||
      database.query("PRAGMA foreign_key_check").all().length !== 0
    )
      return {
        classification: "schema-mismatch",
        userVersion: version,
        history,
        migrationIds: ids,
        overlay: over,
        schema: actual,
        reason: "schema does not match the exact sequence projection",
      };
  } catch (error: unknown) {
    return {
      classification: "schema-mismatch",
      userVersion: version,
      history,
      migrationIds: ids,
      overlay: emptyOverlay(),
      schema: [],
      reason: error instanceof Error ? error.message : "schema is unsupported",
    };
  }
  const canonical = canonicalPrefix(ids) && version <= CANONICAL_DATABASE_SCHEMA_VERSION;
  return {
    classification: canonical ? "supported-canonical-prefix" : "supported-legacy",
    userVersion: version,
    history,
    migrationIds: ids,
    overlay: over,
    schema: baseSchema(database),
  };
}

function emptyOverlay(): MigrationOverlaySnapshot {
  return {
    id: "O-REINDEX-ABSENT",
    lease: null,
    progress: [],
    objects: [],
    sourceRows: [],
    replacementDocsizeRowids: [],
  };
}

export function classifyMigrationHistory(input: unknown): MigrationHistoryClassification {
  return historyClassification(getDatabase(input));
}

function conversionInfrastructurePresent(database: DatabaseLike): boolean {
  return (
    database
      .query(
        "SELECT 1 AS present FROM sqlite_schema WHERE name LIKE 'schema_migration_conversions%' LIMIT 1",
      )
      .get() !== null
  );
}

function conversionDdlRows(database: DatabaseLike): readonly unknown[] {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name LIKE 'schema_migration_conversions%' ORDER BY type, name",
    )
    .all();
}

export function installMigrationConversionInfrastructure(input: unknown): void {
  const database = getDatabase(input);
  if (hasObject(database, "schema_migration_conversions")) {
    verifyConversionInfrastructure(database);
    return;
  }
  const savepoint = "migration_conversion_infrastructure";
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    database.exec(CONVERSION_TABLE_SQL);
    database.exec(CONVERSION_INDEX_SQL);
    database.exec(CONVERSION_INSERT_GATE_SQL);
    database.exec(CONVERSION_UPDATE_TRIGGER_SQL);
    database.exec(CONVERSION_DELETE_TRIGGER_SQL);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error: unknown) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError: unknown) {
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        "conversion provenance infrastructure rollback failed",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
}

function verifyConversionInfrastructure(database: DatabaseLike): void {
  const rows = conversionDdlRows(database);
  if (
    rows.length !== 5 ||
    !hasObject(database, "schema_migration_conversions_source_identity") ||
    !hasObject(database, "schema_migration_conversions_insert_gate") ||
    !hasObject(database, "schema_migration_conversions_no_update") ||
    !hasObject(database, "schema_migration_conversions_no_delete")
  )
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance infrastructure is incomplete",
    );
  const expected = new Map<string, string>([
    ["table\0schema_migration_conversions", CONVERSION_TABLE_SQL],
    ["index\0schema_migration_conversions_source_identity", CONVERSION_INDEX_SQL],
    ["trigger\0schema_migration_conversions_insert_gate", CONVERSION_INSERT_GATE_SQL],
    ["trigger\0schema_migration_conversions_no_update", CONVERSION_UPDATE_TRIGGER_SQL],
    ["trigger\0schema_migration_conversions_no_delete", CONVERSION_DELETE_TRIGGER_SQL],
  ]);
  if (rows.length !== expected.size)
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance infrastructure contains unexpected objects",
    );
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string" ||
      expected.get(`${row.type}\0${row.name}`) !== row.sql
    )
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        "conversion provenance DDL does not match the frozen bytes",
      );
  }
}

function conversionRecord(
  values: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string | number>> {
  const conversionId = `migration-conversion:${sha256(JSON.stringify(["agent-mail/migration-conversion/v1", values.source_user_version, values.source_history_sha256, values.source_overlay_id, values.source_overlay_sha256, values.source_schema_sha256, values.target_registry_sha256, values.backup_id, values.backup_manifest_sha256, values.completed_at]))}`;
  const recordSha = sha256(
    JSON.stringify([
      "agent-mail/migration-conversion-record/v1",
      conversionId,
      values.source_user_version,
      values.source_history_json,
      values.source_history_sha256,
      values.source_overlay_id,
      values.source_overlay_json,
      values.source_overlay_sha256,
      values.source_schema_json,
      values.source_schema_sha256,
      values.target_registry_sha256,
      values.backup_id,
      values.backup_manifest_sha256,
      values.completed_at,
    ]),
  );
  return { ...values, conversion_id: conversionId, record_sha256: recordSha };
}

function encodeOverlay(snapshot: MigrationOverlaySnapshot): string {
  return JSON.stringify([
    "agent-mail/search-reindex-overlay/v1",
    snapshot.id,
    snapshot.lease,
    snapshot.progress,
    snapshot.objects,
    snapshot.sourceRows,
    snapshot.replacementDocsizeRowids,
  ]);
}

function insertConversion(
  database: DatabaseLike,
  values: Readonly<Record<string, string | number>>,
): void {
  database.exec("DROP TRIGGER schema_migration_conversions_insert_gate");
  try {
    const result = database
      .query(
        `INSERT INTO schema_migration_conversions (${CONVERSION_COLUMNS.join(",")}) VALUES (${CONVERSION_COLUMNS.map(() => "?").join(",")})`,
      )
      .run(...CONVERSION_COLUMNS.map((column) => values[column]));
    if (!isRecord(result) || result.changes !== 1)
      throw new Error("conversion provenance insert did not write exactly one row");
  } finally {
    database.exec(CONVERSION_INSERT_GATE_SQL);
  }
}

function canonicalHistorySql(database: DatabaseLike): void {
  database.exec("DELETE FROM schema_migrations");
  for (const migration of canonicalDatabaseMigrations) {
    database
      .query("INSERT INTO schema_migrations (version, name, content_hash) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, migrationContentHash(migration));
  }
  database.exec(`PRAGMA user_version = ${CANONICAL_DATABASE_SCHEMA_VERSION}`);
}

function parseCanonicalJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} is not text`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error: unknown) {
    throw new MigrationHistoryConversionError("provenance-invalid", `${label} is not valid JSON`, {
      cause: error,
    });
  }
  if (JSON.stringify(decoded) !== value)
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      `${label} is not canonical JSON`,
    );
  return decoded;
}

function verifyConversionRow(database: DatabaseLike, row: unknown): void {
  if (!isRecord(row))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance row is invalid",
    );
  const stringColumns = [
    "conversion_id",
    "source_history_json",
    "source_history_sha256",
    "source_overlay_id",
    "source_overlay_json",
    "source_overlay_sha256",
    "source_schema_json",
    "source_schema_sha256",
    "target_registry_sha256",
    "backup_id",
    "backup_manifest_sha256",
    "completed_at",
    "record_sha256",
  ] as const;
  if (
    !isSafeInteger(row.source_user_version) ||
    stringColumns.some((column) => typeof row[column] !== "string")
  ) {
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance row has invalid columns",
    );
  }
  const sourceHistoryJson = row.source_history_json as string;
  const sourceOverlayJson = row.source_overlay_json as string;
  const sourceSchemaJson = row.source_schema_json as string;
  const backupId = row.backup_id as string;
  const backupManifestSha256 = row.backup_manifest_sha256 as string;
  const completedAt = row.completed_at as string;
  const history = parseCanonicalJson(sourceHistoryJson, "source_history_json");
  const overlayValue = parseCanonicalJson(sourceOverlayJson, "source_overlay_json");
  const schemaValue = parseCanonicalJson(sourceSchemaJson, "source_schema_json");
  const historyRows = decodeHistoryTuples(history, "source history JSON");
  const decodedOverlay = strictOverlay(overlayValue, "source overlay JSON");
  const schemaRowsValue = decodeSchemaTuples(schemaValue, "source schema JSON");
  const sourceHistorySha = sha256(sourceHistoryJson);
  const sourceOverlaySha = sha256(sourceOverlayJson);
  const sourceSchemaSha = sha256(sourceSchemaJson);
  if (
    row.source_history_sha256 !== sourceHistorySha ||
    row.source_overlay_sha256 !== sourceOverlaySha ||
    row.source_schema_sha256 !== sourceSchemaSha ||
    row.target_registry_sha256 !== CANONICAL_DATABASE_REGISTRY_SHA256 ||
    !BACKUP_ID.test(backupId) ||
    !SHA256.test(backupManifestSha256) ||
    !INSTANT.test(completedAt) ||
    new Date(completedAt).toISOString() !== completedAt
  ) {
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance row domain or digest is invalid",
    );
  }
  const sourceIdentity = [
    "agent-mail/migration-conversion/v1",
    row.source_user_version,
    row.source_history_sha256,
    row.source_overlay_id,
    row.source_overlay_sha256,
    row.source_schema_sha256,
    row.target_registry_sha256,
    backupId,
    backupManifestSha256,
    completedAt,
  ];
  const expectedConversionId = `migration-conversion:${sha256(JSON.stringify(sourceIdentity))}`;
  if (row.conversion_id !== expectedConversionId)
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance identity is invalid",
    );
  const recordIdentity = [
    "agent-mail/migration-conversion-record/v1",
    row.conversion_id,
    row.source_user_version,
    sourceHistoryJson,
    row.source_history_sha256,
    row.source_overlay_id,
    sourceOverlayJson,
    row.source_overlay_sha256,
    sourceSchemaJson,
    row.source_schema_sha256,
    row.target_registry_sha256,
    backupId,
    backupManifestSha256,
    completedAt,
  ];
  if (row.record_sha256 !== sha256(JSON.stringify(recordIdentity)))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance record digest is invalid",
    );
  if (historyRows.length !== row.source_user_version)
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance history cardinality is invalid",
    );
  const ids = decodeHistory(historyRows, row.source_user_version);
  if (!equalJson(schemaRowsValue, expectedSchema(ids)))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance source schema projection is invalid",
    );
  if (
    decodedOverlay.id !== row.source_overlay_id ||
    !OVERLAY_IDS.includes(row.source_overlay_id as (typeof OVERLAY_IDS)[number])
  )
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance overlay identity is invalid",
    );
}

export function convertMigrationHistory(
  input: unknown,
  options: ConversionOptions = {},
): MigrationHistoryClassification {
  const database = getDatabase(input);
  const before = historyClassification(database);
  if (before.classification === "newer")
    throw new MigrationHistoryConversionError(
      "newer-schema",
      "database schema is newer than this registry",
    );
  if (before.classification !== "supported-legacy")
    throw new MigrationHistoryConversionError(
      "unsupported-history",
      before.reason ?? "database history is not an exact supported legacy composition",
    );
  if (options.backupProof === undefined && options.backup === undefined)
    throw new MigrationHistoryConversionError(
      "conversion-failed",
      "legacy conversion requires a verified backup proof",
    );
  const suppliedProof = options.backupProof ?? options.backup?.();
  if (suppliedProof instanceof Promise)
    throw new MigrationHistoryConversionError(
      "conversion-failed",
      "legacy conversion backup capability must be resolved before conversion",
    );
  const proof = suppliedProof;
  if (proof === undefined)
    throw new MigrationHistoryConversionError(
      "conversion-failed",
      "legacy conversion backup proof is unavailable",
    );
  if (
    !BACKUP_ID.test(proof.backupId) ||
    !SHA256.test(proof.manifestSha256) ||
    !INSTANT.test(proof.createdAt) ||
    new Date(proof.createdAt).toISOString() !== proof.createdAt
  )
    throw new MigrationHistoryConversionError(
      "conversion-failed",
      "legacy conversion backup proof is invalid",
    );
  const historyJson = JSON.stringify(before.history);
  const overlayJson = encodeOverlay(before.overlay);
  const schemaJson = JSON.stringify(before.schema);
  const values = conversionRecord({
    source_user_version: before.userVersion,
    source_history_json: historyJson,
    source_history_sha256: sha256(historyJson),
    source_overlay_id: before.overlay.id,
    source_overlay_json: overlayJson,
    source_overlay_sha256: sha256(overlayJson),
    source_schema_json: schemaJson,
    source_schema_sha256: sha256(schemaJson),
    target_registry_sha256: CANONICAL_DATABASE_REGISTRY_SHA256,
    backup_id: proof.backupId,
    backup_manifest_sha256: proof.manifestSha256,
    completed_at: proof.createdAt,
  });
  let transactionStarted = false;
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const locked = historyClassification(database);
    if (
      locked.classification !== before.classification ||
      locked.userVersion !== before.userVersion ||
      !equalJson(locked.history, before.history) ||
      !equalJson(locked.overlay, before.overlay) ||
      !equalJson(locked.schema, before.schema)
    ) {
      throw new MigrationHistoryConversionError(
        "conversion-failed",
        "legacy database changed between preflight and locked conversion",
      );
    }
    installMigrationConversionInfrastructure(database);
    for (const migration of canonicalDatabaseMigrations) {
      if (before.migrationIds.includes(migration.name)) continue;
      if (
        migration.name === "search-reindex-schema" &&
        before.overlay.id !== "O-REINDEX-ABSENT" &&
        before.overlay.id !== "O-REINDEX-PARTIAL-EMPTY"
      )
        continue;
      database.exec(migration.sql);
    }
    insertConversion(database, values);
    canonicalHistorySql(database);
    if (database.query("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("conversion produced foreign-key violations");
    options.beforeCommit?.();
    database.exec("COMMIT");
    transactionStarted = false;
    database.exec("PRAGMA foreign_keys = ON");
    const after = verifyCanonicalMigrationState(database);
    const provenance = database
      .query("SELECT * FROM schema_migration_conversions ORDER BY conversion_id")
      .all();
    if (provenance.length !== 1)
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        "legacy conversion did not produce exactly one provenance row",
      );
    verifyConversionRow(database, provenance[0]);
    return after;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        throw new MigrationHistoryConversionError(
          "conversion-failed",
          "legacy conversion rollback failed",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    try {
      database.exec("PRAGMA foreign_keys = ON");
    } catch {
      // Preserve the conversion failure as the stable diagnostic.
    }
    if (error instanceof MigrationHistoryConversionError) throw error;
    throw new MigrationHistoryConversionError(
      "conversion-failed",
      "legacy migration conversion failed",
      { cause: error },
    );
  }
}

export function verifyCanonicalMigrationState(input: unknown): MigrationHistoryClassification {
  const database = getDatabase(input);
  const state = historyClassification(database);
  if (
    state.classification !== "supported-canonical-prefix" ||
    state.userVersion !== CANONICAL_DATABASE_SCHEMA_VERSION ||
    !equalJson(state.history, canonicalHistory())
  )
    throw new MigrationHistoryConversionError(
      "unsupported-history",
      "database is not at the exact canonical schema version",
    );
  verifyConversionInfrastructure(database);
  const row = database.query("SELECT count(*) AS count FROM schema_migration_conversions").get();
  if (!isRecord(row) || !isSafeInteger(row.count))
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "conversion provenance row count is invalid",
    );
  if (row.count > 1)
    throw new MigrationHistoryConversionError(
      "provenance-invalid",
      "canonical database has multiple conversion provenance rows",
    );
  if (row.count === 1) {
    const provenance = database
      .query("SELECT * FROM schema_migration_conversions ORDER BY conversion_id")
      .all();
    if (provenance.length !== 1)
      throw new MigrationHistoryConversionError(
        "provenance-invalid",
        "canonical conversion provenance row is missing",
      );
    verifyConversionRow(database, provenance[0]);
  }
  const integrity: unknown = database.query("PRAGMA integrity_check").get();
  if (
    !isRecord(integrity) ||
    integrity.integrity_check !== "ok" ||
    database.query("PRAGMA foreign_key_check").all().length !== 0
  )
    throw new MigrationHistoryConversionError(
      "schema-mismatch",
      "canonical database integrity check failed",
    );
  return state;
}

/**
 * Apply canonical admission to Agent Mail databases while leaving unrelated
 * SQLite fixtures (which have no archive markers) available to generic
 * backup/restore tests and tooling.
 */
export function verifyCanonicalAdmissionIfPresent(input: unknown): void {
  const database = getDatabase(input);
  const archiveMarkers = [
    "schema_migrations",
    "messages",
    "schema_migration_conversions",
    "search_reindex_lease",
    "search_reindex_progress",
  ];
  if (!archiveMarkers.some((name) => hasObject(database, name))) return;
  verifyCanonicalMigrationState(database);
}

export const migrationConversionDdl = Object.freeze({
  tableSql: CONVERSION_TABLE_SQL,
  indexSql: CONVERSION_INDEX_SQL,
  insertGateTriggerSql: CONVERSION_INSERT_GATE_SQL,
  updateTriggerSql: CONVERSION_UPDATE_TRIGGER_SQL,
  deleteTriggerSql: CONVERSION_DELETE_TRIGGER_SQL,
});
