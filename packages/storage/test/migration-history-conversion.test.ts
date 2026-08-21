import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import {
  CANONICAL_DATABASE_REGISTRY_SHA256,
  classifyMigrationHistory,
  canonicalRegistryDigestAtVersion,
  convertMigrationHistory,
  installMigrationConversionInfrastructure,
  verifyCanonicalMigrationPrefixState,
  verifyCanonicalMigrationState,
} from "../src/migration-history-conversion";
import { openDatabase } from "../src/database";
import { runDoctorIntegrity } from "../src/doctor-integrity";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";

const legacyProof = {
  backupId: "backup:legacy-reordered",
  manifestSha256: "a".repeat(64),
  createdAt: "2026-08-20T00:00:00.000Z",
};

function reorderedLegacyMigrations() {
  const source = [...canonicalDatabaseMigrations.slice(0, 27)];
  const routingPreview = source[3];
  const actionSchema = source[4];
  if (routingPreview === undefined || actionSchema === undefined)
    throw new Error("legacy fixture migration sequence is incomplete");
  source[3] = actionSchema;
  source[4] = routingPreview;
  return source.map((migration, index) => ({ ...migration, version: index + 1 }));
}

describe("migration history conversion authority", () => {
  test("converts a real reordered legacy database, survives crash/reopen, and gates the canonical suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-migration-conversion-"));
    await chmod(root, 0o700);
    const data = join(root, "data");
    const blobs = join(root, "blobs");
    const journal = join(root, "journal");
    const config = join(root, "config");
    await Promise.all([data, blobs, journal, config].map((path) => mkdir(path, { mode: 0o700 })));
    const databasePath = join(data, "archive.sqlite");
    const legacy = new Database(databasePath, { strict: true });
    applyMigrations(legacy, reorderedLegacyMigrations());
    expect(classifyMigrationHistory(legacy).classification).toBe("supported-legacy");
    expect(() =>
      convertMigrationHistory(legacy, {
        backupProof: legacyProof,
        beforeCommit: () => {
          throw new Error("injected conversion crash");
        },
      }),
    ).toThrow("legacy migration conversion failed");
    expect(classifyMigrationHistory(legacy).classification).toBe("supported-legacy");
    expect(legacy.query("SELECT name FROM sqlite_schema WHERE name = 'schema_migration_conversions';").get()).toBeNull();
    expect(convertMigrationHistory(legacy, { backupProof: legacyProof }).classification).toBe(
      "supported-canonical-prefix",
    );
    expect(() => verifyCanonicalMigrationPrefixState(legacy, 27)).not.toThrow();
    legacy.close();
    await chmod(databasePath, 0o600);

    const opened = await openDatabase(databasePath, { legacyBackup: legacyProof });
    expect(opened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
    expect(() => verifyCanonicalMigrationState(opened.db)).not.toThrow();
    expect(() =>
      opened.db
        .query("UPDATE schema_migration_conversions SET target_registry_sha256 = ?;")
        .run("b".repeat(64)),
    ).toThrow("migration conversion provenance is immutable");
    expect(() => verifyCanonicalMigrationState(opened.db)).not.toThrow();
    await opened.close();

    const reopened = await openDatabase(databasePath);
    expect(reopened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
    await reopened.close();

    const doctor = await runDoctorIntegrity({
      privateRoot: root,
      databasePath,
      blobDirectory: blobs,
    });
    expect(doctor.status).toBe("healthy");
    expect(doctor.checks.find((check) => check.id === "migrations")?.status).toBe("pass");

    const metadataPath = join(config, "archive-metadata.json");
    await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
    const backupPath = join(root, "backup-one");
    await writeBackup({
      privateRoot: root,
      databasePath,
      blobDirectory: blobs,
      journalDirectory: journal,
      configurationMetadataPaths: [metadataPath],
      referencedBlobDigests: [],
      destination: backupPath,
    });
    const restored = await restoreBackup({ backupPath, destination: join(root, "restored") });
    const restoredDatabase = new Database(restored.databasePath, { readonly: true, strict: true });
    expect(restoredDatabase.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
    expect(() => verifyCanonicalMigrationState(restoredDatabase)).not.toThrow();
    restoredDatabase.close();
    await rm(root, { recursive: true, force: true });
  });

  test("keeps the signed target digest bound to the accepted target 27 prefix", () => {
    expect(canonicalRegistryDigestAtVersion(27)).toBe(
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
    );
    expect(CANONICAL_DATABASE_REGISTRY_SHA256).not.toBe(canonicalRegistryDigestAtVersion(27));
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    installMigrationConversionInfrastructure(database);
    expect(() => verifyCanonicalMigrationState(database)).not.toThrow();
    database.close();
  });
});
