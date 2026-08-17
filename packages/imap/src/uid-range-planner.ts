import { createRemoteUidValue, type CheckpointValue, type RemoteUidValue } from "@agent-mail/core";

/** One inclusive UID interval suitable for an IMAP fetch command. */
export type UidRange = Readonly<{
  readonly start: RemoteUidValue;
  readonly end: RemoteUidValue;
}>;

/** Inputs to the pure sparse UID planner. `null` is an observed empty mailbox. */
export type UidRangePlannerInput = Readonly<{
  readonly knownPlacementUids: readonly RemoteUidValue[];
  readonly checkpointUidNext: CheckpointValue<RemoteUidValue>;
  readonly observedUidCeiling: RemoteUidValue | null;
  /** Inclusive maximum number of UIDs represented by one returned range. */
  readonly maxRangeSpan: number;
  /** Include known UIDs only for an explicitly requested reconciliation pass. */
  readonly reconcileKnown?: boolean;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`UID range planner input is missing ${key}`);
    }
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("UID range planner input has unknown fields");
  }
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseCheckpointUidNext(value: unknown): CheckpointValue<RemoteUidValue> {
  if (!isRecord(value)) throw new TypeError("checkpointUidNext must be an object");
  if (value.kind === "unknown") {
    assertExactKeys(value, ["kind"]);
    return { kind: "unknown" };
  }
  if (value.kind === "known") {
    assertExactKeys(value, ["kind", "value"]);
    return { kind: "known", value: createRemoteUidValue(value.value) };
  }
  throw new TypeError("checkpointUidNext kind must be known or unknown");
}

/** Parse untrusted planner input at the IMAP adapter boundary. */
export function parseUidRangePlannerInput(value: unknown): UidRangePlannerInput {
  if (!isRecord(value)) throw new TypeError("UID range planner input must be an object");
  assertExactKeys(
    value,
    ["knownPlacementUids", "checkpointUidNext", "observedUidCeiling", "maxRangeSpan"],
    ["reconcileKnown"],
  );
  if (!Array.isArray(value.knownPlacementUids)) {
    throw new TypeError("knownPlacementUids must be an array");
  }
  const knownPlacementUids = value.knownPlacementUids.map((item) => createRemoteUidValue(item));
  const observedUidCeiling =
    value.observedUidCeiling === null ? null : createRemoteUidValue(value.observedUidCeiling);
  const reconcileKnown = Object.prototype.hasOwnProperty.call(value, "reconcileKnown")
    ? value.reconcileKnown
    : false;
  if (typeof reconcileKnown !== "boolean") {
    throw new TypeError("reconcileKnown must be a boolean");
  }
  return {
    knownPlacementUids,
    checkpointUidNext: parseCheckpointUidNext(value.checkpointUidNext),
    observedUidCeiling,
    maxRangeSpan: positiveSafeInteger(value.maxRangeSpan, "maxRangeSpan"),
    reconcileKnown,
  };
}

function appendChunks(
  ranges: UidRange[],
  lower: number,
  upper: number,
  maxRangeSpan: number,
): void {
  let rangeStart = lower;
  while (rangeStart <= upper) {
    // Compute the span before adding it to the UID. This remains safe when
    // both endpoints are Number.MAX_SAFE_INTEGER and the cap is large.
    const span = Math.min(upper - rangeStart, maxRangeSpan - 1);
    const rangeEnd = rangeStart + span;
    ranges.push({
      start: createRemoteUidValue(rangeStart),
      end: createRemoteUidValue(rangeEnd),
    });
    if (rangeEnd === upper) break;
    rangeStart = rangeEnd + 1;
  }
}

function uniqueSorted(values: readonly RemoteUidValue[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

/**
 * Compute ascending, bounded, non-overlapping ranges for unknown mailbox UIDs.
 *
 * The observed ceiling is the only upper bound used. A known UIDNEXT narrows
 * the lower bound to that next UID; an unknown UIDNEXT deliberately takes the
 * explicit safe-rescan path beginning at IMAP's positive UID 1. Known
 * placements split ranges unless reconciliation was explicitly requested.
 */
export function planUidFetchRanges(input: UidRangePlannerInput): readonly UidRange[] {
  const normalized = parseUidRangePlannerInput(input);
  const ceiling = normalized.observedUidCeiling;
  if (ceiling === null) return [];

  const lowerBound =
    normalized.checkpointUidNext.kind === "known" ? normalized.checkpointUidNext.value : 1;
  if (lowerBound > ceiling) return [];

  const ranges: UidRange[] = [];
  if (normalized.reconcileKnown === true) {
    appendChunks(ranges, lowerBound, ceiling, normalized.maxRangeSpan);
    return ranges;
  }

  let rangeStart = lowerBound;
  for (const knownUid of uniqueSorted(normalized.knownPlacementUids)) {
    if (knownUid < rangeStart) continue;
    if (knownUid > ceiling) break;
    if (rangeStart < knownUid) {
      appendChunks(ranges, rangeStart, knownUid - 1, normalized.maxRangeSpan);
    }
    if (knownUid === ceiling) return ranges;
    rangeStart = knownUid + 1;
  }
  appendChunks(ranges, rangeStart, ceiling, normalized.maxRangeSpan);
  return ranges;
}
