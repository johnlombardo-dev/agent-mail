/**
 * Compatibility entry point for the checkpoint extension. Keep the actual
 * repository and migration together so their row contract cannot drift.
 */
export {
  MAILBOX_CHECKPOINT_MIGRATION_VERSION,
  mailboxCheckpointMigration,
  mailboxCheckpointExtensionMigrations,
  mailboxCheckpointMigrations,
} from "../checkpoint-repository";
