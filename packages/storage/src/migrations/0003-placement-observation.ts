import type { Migration } from "../migration-runner";

/** Schema extension for one server-observed remote placement. */
export const PLACEMENT_OBSERVATION_MIGRATION_VERSION = 3;

export const placementObservationMigration = {
  version: PLACEMENT_OBSERVATION_MIGRATION_VERSION,
  name: "remote-placement-observation",
  sql: `
ALTER TABLE remote_placements
  ADD COLUMN internal_date TEXT
    CHECK (
      internal_date IS NULL OR (
        length(internal_date) = 24 AND
        substr(internal_date, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', internal_date) = internal_date
      )
    );

ALTER TABLE remote_placements
  ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      length(flags_json) BETWEEN 2 AND 262144 AND
      json_valid(flags_json) AND
      json_type(flags_json) = 'array'
    );

ALTER TABLE remote_placements
  ADD COLUMN modseq_known INTEGER NOT NULL DEFAULT 0
    CHECK (modseq_known IN (0, 1));

ALTER TABLE remote_placements
  ADD COLUMN modseq INTEGER
    CHECK (
      (modseq_known = 0 AND modseq IS NULL) OR
      (
        modseq_known = 1 AND
        typeof(modseq) = 'integer' AND
        modseq >= 0 AND
        modseq <= 9007199254740991
      )
    );

ALTER TABLE remote_placements
  ADD COLUMN observation_order INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(observation_order) = 'integer' AND
      observation_order >= 0 AND
      observation_order <= 9007199254740991
    );

ALTER TABLE remote_placements
  ADD COLUMN observation_observed_at TEXT
    CHECK (
      observation_observed_at IS NULL OR (
        length(observation_observed_at) = 24 AND
        substr(observation_observed_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', observation_observed_at) = observation_observed_at
      )
    );

ALTER TABLE remote_placements
  ADD COLUMN observation_checkpoint TEXT
    CHECK (
      observation_checkpoint IS NULL OR (
        length(observation_checkpoint) BETWEEN 1 AND 200 AND
        observation_checkpoint = trim(observation_checkpoint) AND
        instr(observation_checkpoint, char(0)) = 0 AND
        observation_checkpoint NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
        observation_checkpoint NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
      )
    );

CREATE INDEX remote_placements_active_observation
  ON remote_placements (account_id, mailbox_id, uid_validity, uid, tombstone_observed_at);

CREATE TRIGGER remote_placements_observation_pair
BEFORE INSERT ON remote_placements
WHEN (
  (NEW.observation_order = 0 AND
    (NEW.observation_observed_at IS NOT NULL OR NEW.observation_checkpoint IS NOT NULL)) OR
  (NEW.observation_order > 0 AND
    (NEW.observation_observed_at IS NULL OR NEW.observation_checkpoint IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'placement observation provenance is incomplete');
END;

CREATE TRIGGER remote_placements_observation_pair_update
BEFORE UPDATE ON remote_placements
WHEN (
  (NEW.observation_order = 0 AND
    (NEW.observation_observed_at IS NOT NULL OR NEW.observation_checkpoint IS NOT NULL)) OR
  (NEW.observation_order > 0 AND
    (NEW.observation_observed_at IS NULL OR NEW.observation_checkpoint IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'placement observation provenance is incomplete');
END;

CREATE TRIGGER remote_placements_internal_date_immutable
BEFORE UPDATE OF internal_date ON remote_placements
WHEN OLD.internal_date IS NOT NULL AND NEW.internal_date IS NOT OLD.internal_date
BEGIN
  SELECT RAISE(ABORT, 'placement INTERNALDATE is immutable');
END;
`,
} satisfies Migration;

/** The extension alone is retained for an application registry. */
export const placementObservationExtensionSequence = [placementObservationMigration] as const;
