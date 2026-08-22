import { dlopen, FFIType, ptr, read } from "bun:ffi";

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_BYTES = 136;
const PBI_PID_OFFSET = 12;
const PBI_START_SECONDS_OFFSET = 120;
const PBI_START_MICROSECONDS_OFFSET = 128;
const ESRCH = 3;

const darwinProcessApi =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        __error: { args: [], returns: FFIType.ptr },
      })
    : undefined;

export type DarwinProcessIdentity =
  | Readonly<{
      readonly kind: "present";
      readonly source: "darwin-proc-pid-tbsdinfo";
      readonly pid: number;
      readonly startTimeUnit: "microseconds-since-unix-epoch";
      readonly startTimeSeconds: number;
      readonly startTimeMicroseconds: number;
      readonly exactStartIdentity: string;
    }>
  | Readonly<{
      readonly kind: "absent";
      readonly source: "darwin-proc-pid-tbsdinfo";
      readonly pid: number;
    }>;

type RecordValue = Readonly<Record<string, unknown>>;

function recordValue(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Darwin process identity must be an object");
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function microseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= 1_000_000)
    throw new TypeError("process start microseconds must be an integer below one second");
  return value;
}

function exactKeys(record: RecordValue, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  )
    throw new TypeError("Darwin process identity fields are invalid");
}

export function parseDarwinProcessIdentity(value: unknown): DarwinProcessIdentity {
  const record = recordValue(value);
  if (record.source !== "darwin-proc-pid-tbsdinfo")
    throw new TypeError("Darwin process identity source is unavailable");
  const pid = positiveInteger(record.pid, "process identity PID");
  if (record.kind === "absent") {
    exactKeys(record, ["kind", "source", "pid"]);
    return Object.freeze({ kind: "absent", source: "darwin-proc-pid-tbsdinfo", pid });
  }
  if (record.kind !== "present") throw new TypeError("Darwin process identity kind is invalid");
  exactKeys(record, [
    "kind",
    "source",
    "pid",
    "startTimeUnit",
    "startTimeSeconds",
    "startTimeMicroseconds",
  ]);
  if (record.startTimeUnit !== "microseconds-since-unix-epoch")
    throw new TypeError("Darwin process start unit is unavailable");
  const startTimeSeconds = positiveInteger(record.startTimeSeconds, "process start seconds");
  const startTimeMicroseconds = microseconds(record.startTimeMicroseconds);
  return Object.freeze({
    kind: "present",
    source: "darwin-proc-pid-tbsdinfo",
    pid,
    startTimeUnit: "microseconds-since-unix-epoch",
    startTimeSeconds,
    startTimeMicroseconds,
    exactStartIdentity: `${startTimeSeconds}:${String(startTimeMicroseconds).padStart(6, "0")}`,
  });
}

export function readDarwinProcessIdentity(pidInput: number): DarwinProcessIdentity {
  const pid = positiveInteger(pidInput, "process identity PID");
  if (darwinProcessApi === undefined)
    throw new Error("exact Darwin process identity is unavailable on this platform");
  const bytes = Buffer.alloc(PROC_BSDINFO_BYTES);
  const result = darwinProcessApi.symbols.proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    ptr(bytes),
    bytes.byteLength,
  );
  if (result === 0) {
    const errorPointer = darwinProcessApi.symbols.__error();
    if (errorPointer === null) throw new Error("Darwin process identity errno is unavailable");
    const errorNumber = read.i32(errorPointer, 0);
    if (errorNumber === ESRCH)
      return parseDarwinProcessIdentity({
        kind: "absent",
        source: "darwin-proc-pid-tbsdinfo",
        pid,
      });
    throw new Error(`Darwin process identity is unavailable (errno ${errorNumber})`);
  }
  if (result !== PROC_BSDINFO_BYTES)
    throw new Error(`Darwin process identity returned ${result} of ${PROC_BSDINFO_BYTES} bytes`);
  const reportedPid = bytes.readUInt32LE(PBI_PID_OFFSET);
  if (reportedPid !== pid) throw new Error("Darwin process identity returned a different PID");
  const startSeconds = bytes.readBigUInt64LE(PBI_START_SECONDS_OFFSET);
  const startMicroseconds = bytes.readBigUInt64LE(PBI_START_MICROSECONDS_OFFSET);
  if (
    startSeconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    startMicroseconds > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Darwin process identity exceeds the exact numeric range");
  return parseDarwinProcessIdentity({
    kind: "present",
    source: "darwin-proc-pid-tbsdinfo",
    pid: reportedPid,
    startTimeUnit: "microseconds-since-unix-epoch",
    startTimeSeconds: Number(startSeconds),
    startTimeMicroseconds: Number(startMicroseconds),
  });
}
