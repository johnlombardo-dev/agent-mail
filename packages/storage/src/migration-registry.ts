import type { Migration } from "./migration-runner";
import { mailboxCheckpointMigration } from "./checkpoint-repository";
import { localLabelMigration } from "./local-label-migration";
import { routingDecisionMigration } from "./routing-decision-migration";
import { routingDecisionOriginMigration } from "./routing-decision-origin-migration";
import { routingPreviewMigration } from "./routing-preview-migration";
import { routingPreviewConsumptionMigration } from "./routing-preview-consumption-migration";
import { SEARCH_REINDEX_SCHEMA_SQL } from "./search-reindex";
import { actionSchemaMigration } from "./migrations/0001-action-schema";
import { messageCatalogMigration } from "./migrations/0001-message-catalog";
import { operationalJournalMigration } from "./migrations/0001-operational-journal";
import { operationalJournalCompactionMigration } from "./migrations/0001-operational-journal-compaction";
import { actionPlanProposalMigration } from "./migrations/0002-action-plan-proposal";
import { identityOnlyContentMigration } from "./migrations/0002-identity-only-content";
import { structuredContentMigration } from "./migrations/0002-structured-content";
import { externalContentSearchMigration } from "./migrations/0003-external-content-search";
import { messageBlobReferencesMigration } from "./migrations/0003-message-blob-references";
import { placementObservationMigration } from "./migrations/0003-placement-observation";
import { actionPlanClaimMigration } from "./migrations/0003-action-plan-claim";
import { actionAttemptStartMigration } from "./migrations/0004-action-attempt-start";
import { searchCandidatePlacementIndexMigration } from "./migrations/0004-search-candidate-placement-index";
import { actionAttemptDispatchMigration } from "./migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "./migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "./migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "./migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "./migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "./migrations/0011-seal-key-administration";
import { initialBackfillCompletionMigration } from "./migrations/initial-backfill-completion";

const canonical = (version: number, migration: Migration): Migration =>
  Object.freeze({ ...migration, version });

const canonicalSql = (version: number, name: string, sql: string): Migration =>
  Object.freeze({ version, name, sql, requiresForeignKeysOff: false });

/** The sole immutable application migration authority. */
export const canonicalDatabaseMigrations: readonly Migration[] = Object.freeze([
  canonical(1, messageCatalogMigration),
  canonical(2, operationalJournalMigration),
  canonical(3, structuredContentMigration),
  canonical(4, routingPreviewMigration),
  canonical(5, actionSchemaMigration),
  canonical(6, mailboxCheckpointMigration),
  canonical(7, localLabelMigration),
  canonical(8, externalContentSearchMigration),
  canonical(9, actionPlanProposalMigration),
  canonical(10, operationalJournalCompactionMigration),
  canonical(11, routingDecisionMigration),
  canonical(12, identityOnlyContentMigration),
  canonical(13, routingPreviewConsumptionMigration),
  canonical(14, actionPlanClaimMigration),
  canonical(15, actionAttemptStartMigration),
  canonical(16, placementObservationMigration),
  canonical(17, messageBlobReferencesMigration),
  canonical(18, initialBackfillCompletionMigration),
  canonical(19, searchCandidatePlacementIndexMigration),
  canonicalSql(20, "search-reindex-schema", SEARCH_REINDEX_SCHEMA_SQL),
  canonical(21, routingDecisionOriginMigration),
  canonical(22, actionAttemptDispatchMigration),
  canonical(23, actionResultReconciliationMigration),
  canonical(24, threadGraphMigration),
  canonical(25, actionApprovalAuthorityMigration),
  canonical(26, actionPlanRestoreQuarantineMigration),
  canonical(27, sealKeyAdministrationMigration),
]);

export const CANONICAL_DATABASE_SCHEMA_VERSION = canonicalDatabaseMigrations.length;
export const NEXT_DATABASE_MIGRATION_VERSION = CANONICAL_DATABASE_SCHEMA_VERSION + 1;
export const NEXT_REPORT_MIGRATION_VERSION = NEXT_DATABASE_MIGRATION_VERSION;

export type CanonicalDatabaseMigration = (typeof canonicalDatabaseMigrations)[number];
