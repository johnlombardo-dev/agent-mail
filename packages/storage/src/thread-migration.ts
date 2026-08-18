/** Stable storage import for the thread graph migration extension. */
export {
  THREAD_GRAPH_MIGRATION_VERSION,
  threadGraphMigration,
  threadGraphMigrations,
  threadMigration,
  threadMigrations,
} from "./migrations/0008-thread-graph";

import type { Migration } from "./migration-runner";
import { threadGraphMigration } from "./migrations/0008-thread-graph";

/** Append the thread extension at the next contiguous slot in an app registry. */
export function composeThreadGraphMigrations(base: readonly Migration[]): readonly Migration[] {
  return Object.freeze([...base, { ...threadGraphMigration, version: base.length + 1 }]);
}
