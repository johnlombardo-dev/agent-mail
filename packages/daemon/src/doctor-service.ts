import {
  reportAdminDoctorRequestSchema,
  reportAdminDoctorResponseSchema,
  type ReportAdminDoctorResponse,
} from "@agent-mail/contracts";
import { z } from "zod";
import {
  runDoctorIntegrity,
  type DoctorCheck,
  type DoctorEvidence,
  type DoctorIntegrityOptions,
  type DoctorIntegrityResult,
} from "../../storage/src/doctor-integrity";
import type { ReportAdminService } from "./report-admin-handlers";

/** The fields carried by one public finding, encoded in the legacy issue detail string. */
export type DoctorFindingDetail = Readonly<{
  readonly severity: "info" | "warning" | "error";
  readonly subject: string | null;
  readonly evidence: Readonly<{
    readonly reference: string | null;
    readonly detail: string;
  }>;
}>;

const MAX_DETAIL = 2_048;
const MAX_SUBJECT = 128;
const MAX_REFERENCE = 256;
const MAX_EVIDENCE_DETAIL = 512;
type ReportAdminDoctorRequest = z.infer<typeof reportAdminDoctorRequestSchema>;

function bounded(value: string, maximum = MAX_DETAIL): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const replacement =
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
        ? "�"
        : character;
    if (safe.length + replacement.length > maximum) break;
    safe += replacement;
  }
  return safe;
}

function dropLastCodePoint(value: string): string {
  const points = Array.from(value);
  points.pop();
  return points.join("");
}

function relativePath(privateRoot: string, path: string | undefined): string | null {
  if (path === undefined) return null;
  if (path === privateRoot) return "private-root";
  if (path.startsWith(`${privateRoot}/`)) {
    const relative = path.slice(privateRoot.length + 1);
    return relative.length === 0 ? "private-root" : `private-root/${bounded(relative, 512)}`;
  }
  // A doctor finding must never make an arbitrary absolute path public.
  if (path.startsWith("/")) return "private-path";
  return bounded(path, 512);
}

function safeText(privateRoot: string, value: string): string {
  const rootPrefix = `${privateRoot}/`;
  const redacted = value
    .replaceAll(privateRoot, "private-root")
    .replaceAll(rootPrefix, "private-root/")
    .replaceAll(/(?:^|\s)(\/[^\s,)]+)(?=$|[\s,)])/gu, " private-path");
  return bounded(redacted);
}

function findingSeverity(status: DoctorCheck["status"]): DoctorFindingDetail["severity"] {
  switch (status) {
    case "pass":
      return "info";
    case "blocked":
      return "warning";
    case "fail":
      return "error";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function findingDetail(privateRoot: string, check: DoctorCheck, evidence: DoctorEvidence): string {
  let subject =
    evidence.identity === undefined
      ? null
      : bounded(safeText(privateRoot, evidence.identity), MAX_SUBJECT);
  let reference = relativePath(privateRoot, evidence.path);
  if (reference !== null) reference = bounded(reference, MAX_REFERENCE);
  let evidenceDetail = bounded(safeText(privateRoot, evidence.detail), MAX_EVIDENCE_DETAIL);

  const serialize = (): string =>
    JSON.stringify({
      severity: findingSeverity(check.status),
      subject,
      evidence: { reference, detail: evidenceDetail },
    });
  let serialized = serialize();
  // Compact fields before serialization is complete. This keeps the outer
  // string schema bounded without ever slicing a JSON document in half.
  const fields: Array<{
    readonly minimum: number;
    get(): string | null;
    set(value: string): void;
  }> = [
    {
      minimum: subject === null ? 0 : 1,
      get: () => subject,
      set: (value) => {
        subject = value;
      },
    },
    {
      minimum: reference === null ? 0 : 1,
      get: () => reference,
      set: (value) => {
        reference = value;
      },
    },
    {
      minimum: 1,
      get: () => evidenceDetail,
      set: (value) => {
        evidenceDetail = value;
      },
    },
  ];
  for (const field of fields) {
    while (serialized.length > MAX_DETAIL) {
      const value = field.get();
      if (value === null || Array.from(value).length <= field.minimum) break;
      field.set(dropLastCodePoint(value));
      serialized = serialize();
    }
    if (serialized.length <= MAX_DETAIL) break;
  }
  if (serialized.length > MAX_DETAIL) {
    // The fixed schema keys and severity always fit, so this is only a
    // defensive last resort for future additions to DoctorFindingDetail.
    subject = subject === null ? null : "";
    reference = reference === null ? null : "";
    evidenceDetail = "";
    serialized = serialize();
  }
  return serialized;
}

function issueFor(
  privateRoot: string,
  check: DoctorCheck,
  evidence: DoctorEvidence | undefined,
  index: number,
): ReportAdminDoctorResponse["issues"][number] {
  const fallback: DoctorEvidence = {
    detail: check.summary,
    identity: undefined,
    path: undefined,
  };
  return {
    code: `doctor:${check.id}:${index + 1}`,
    detail: findingDetail(privateRoot, check, evidence ?? fallback),
  };
}

/** Convert the storage result into the exact public doctor response contract. */
export function doctorResponseFromIntegrity(
  privateRoot: string,
  result: DoctorIntegrityResult,
): ReportAdminDoctorResponse {
  const checks = result.checks.map((check) => ({
    id: check.id,
    status: check.status === "blocked" ? ("warn" as const) : check.status,
    summary: bounded(safeText(privateRoot, check.summary)),
  }));
  const issues = result.checks.flatMap((check) =>
    check.status === "pass"
      ? []
      : check.evidence.length === 0
        ? [issueFor(privateRoot, check, undefined, 0)]
        : check.evidence.map((evidence, index) => issueFor(privateRoot, check, evidence, index)),
  );
  return reportAdminDoctorResponseSchema.parse({
    status: result.status,
    checks,
    issues,
  });
}

export type DoctorServiceOptions = Readonly<{
  readonly integrity: DoctorIntegrityOptions;
}>;

/** Read-only doctor service used by the report/admin adapter. */
export function createDoctorService(
  options: DoctorServiceOptions,
): ReportAdminService<ReportAdminDoctorRequest, ReportAdminDoctorResponse> {
  return async () => {
    const result = await runDoctorIntegrity(options.integrity);
    return doctorResponseFromIntegrity(options.integrity.privateRoot, result);
  };
}
