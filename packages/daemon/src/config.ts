import { isAbsolute, join, normalize, parse, relative } from "node:path";
import { z } from "zod";
import { PORT_ROLES, portRoleConfigSchema } from "../../../ports.ts";
import type { PortRoleConfig } from "../../../ports.ts";

const ERROR_MESSAGES = {
  invalidInput: "startup configuration is invalid",
  unknownKey: "startup configuration contains an unknown key",
  unsafePath: "private paths must be absolute, canonical, and remain under privateRoot",
  secretPermissions: "secret file permissions must be private",
  portAssignment: "startup ports do not match the approved role map",
} as const;

/** The received-byte ceiling used by every JSON HTTP ingress by default. */
export const DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

export type StartupConfigErrorCode = keyof typeof ERROR_MESSAGES;

export class StartupConfigError extends Error {
  readonly code: StartupConfigErrorCode;

  constructor(code: StartupConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "StartupConfigError";
    this.code = code;
  }
}

const pathValueSchema = z
  .string()
  .min(1)
  .refine(isCanonicalAbsolutePath, ERROR_MESSAGES.unsafePath);

const pathOverridesSchema = z.strictObject({
  data: pathValueSchema.optional(),
  blob: pathValueSchema.optional(),
  journal: pathValueSchema.optional(),
  backup: pathValueSchema.optional(),
  runtime: pathValueSchema.optional(),
});

const secretFileSchema = z.strictObject({
  path: pathValueSchema.optional(),
  mode: z.number().int().min(0).max(0o777).optional(),
});

const httpConfigSchema = z.strictObject({
  maxRequestBodyBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .optional(),
});

const startupConfigInputSchema = z.strictObject({
  privateRoot: pathValueSchema,
  paths: pathOverridesSchema.optional(),
  secretFile: secretFileSchema.optional(),
  http: httpConfigSchema.optional(),
  ports: portRoleConfigSchema,
});

export type PrivatePaths = Readonly<{
  readonly data: string;
  readonly blob: string;
  readonly journal: string;
  readonly backup: string;
  readonly runtime: string;
}>;

export type SecretFileConfig = Readonly<{
  readonly path: string;
  readonly mode: number;
}>;

export type StartupConfig = Readonly<{
  readonly privateRoot: string;
  readonly paths: PrivatePaths;
  readonly secretFile: SecretFileConfig;
  readonly http: Readonly<{ readonly maxRequestBodyBytes: number }>;
  readonly ports: PortRoleConfig;
}>;

export type StartupConfigParseResult =
  | Readonly<{ readonly success: true; readonly data: StartupConfig }>
  | Readonly<{
      readonly success: false;
      readonly error: Readonly<{ readonly code: StartupConfigErrorCode; readonly message: string }>;
    }>;

const DEFAULT_SECRET_FILE_MODE = 0o600;

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== parse(value).root &&
    !hasTraversalSegment(value)
  );
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..");
}

function deriveChildPath(root: string, child: string): string {
  return join(root, child);
}

/** Derive all private filesystem locations without touching the filesystem. */
export function derivePrivatePaths(privateRoot: string): PrivatePaths {
  if (!isCanonicalAbsolutePath(privateRoot)) throw new StartupConfigError("unsafePath");
  return Object.freeze({
    data: deriveChildPath(privateRoot, "data"),
    blob: deriveChildPath(privateRoot, "blobs"),
    journal: deriveChildPath(privateRoot, "journal"),
    backup: deriveChildPath(privateRoot, "backups"),
    runtime: deriveChildPath(privateRoot, "runtime"),
  });
}

function pathIsDerivedChild(root: string, target: string): boolean {
  if (!isCanonicalAbsolutePath(target)) return false;
  const remainder = relative(root, target);
  return (
    remainder !== "" &&
    remainder !== ".." &&
    !remainder.startsWith(`..${"/"}`) &&
    !isAbsolute(remainder)
  );
}

function expectedPath(paths: PrivatePaths, key: keyof PrivatePaths): string {
  return paths[key];
}

function validatePathOverrides(
  root: string,
  paths: PrivatePaths,
  overrides: z.infer<typeof pathOverridesSchema> | undefined,
): void {
  if (overrides === undefined) return;
  const pathKeys = ["data", "blob", "journal", "backup", "runtime"] satisfies ReadonlyArray<
    keyof PrivatePaths
  >;
  for (const key of pathKeys) {
    const override = overrides[key];
    if (override === undefined) continue;
    if (!pathIsDerivedChild(root, override) || override !== expectedPath(paths, key)) {
      throw new StartupConfigError("unsafePath");
    }
  }
}

function validateSecretFile(
  root: string,
  secretFile: z.infer<typeof secretFileSchema> | undefined,
): SecretFileConfig {
  const path = secretFile?.path ?? join(root, "secrets", "api-token");
  const mode = secretFile?.mode ?? DEFAULT_SECRET_FILE_MODE;
  if (!isCanonicalAbsolutePath(path) || !pathIsDerivedChild(root, path)) {
    throw new StartupConfigError("unsafePath");
  }
  const secretRoot = join(root, "secrets");
  if (!path.startsWith(`${secretRoot}/`)) throw new StartupConfigError("unsafePath");
  if ((mode & 0o077) !== 0) throw new StartupConfigError("secretPermissions");
  return Object.freeze({ path, mode });
}

function validatePortAssignment(ports: PortRoleConfig): void {
  const roles = portRoleConfigSchema.keyof().options;
  for (const role of roles) {
    if (ports[role] !== PORT_ROLES[role]) throw new StartupConfigError("portAssignment");
  }
}

function parseValidatedConfig(input: unknown): StartupConfig {
  let parsed: z.infer<typeof startupConfigInputSchema>;
  try {
    parsed = startupConfigInputSchema.parse(input);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      const hasUnknownKey = error.issues.some((issue) => issue.code === "unrecognized_keys");
      if (hasUnknownKey) throw new StartupConfigError("unknownKey");
      const hasUnsafePath = error.issues.some(
        (issue) => issue.message === ERROR_MESSAGES.unsafePath,
      );
      throw new StartupConfigError(hasUnsafePath ? "unsafePath" : "invalidInput");
    }
    throw new StartupConfigError("invalidInput");
  }

  const paths = derivePrivatePaths(parsed.privateRoot);
  validatePathOverrides(parsed.privateRoot, paths, parsed.paths);
  const secretFile = validateSecretFile(parsed.privateRoot, parsed.secretFile);
  validatePortAssignment(parsed.ports);
  return Object.freeze({
    privateRoot: parsed.privateRoot,
    paths,
    secretFile,
    http: Object.freeze({
      maxRequestBodyBytes:
        parsed.http?.maxRequestBodyBytes ?? DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES,
    }),
    ports: Object.freeze({ ...parsed.ports }),
  });
}

/** Parse untrusted startup input and expose only a stable, safe error surface. */
export function parseStartupConfig(input: unknown): StartupConfig {
  return parseValidatedConfig(input);
}

export function safeParseStartupConfig(input: unknown): StartupConfigParseResult {
  try {
    return { success: true, data: parseValidatedConfig(input) };
  } catch (error: unknown) {
    if (error instanceof StartupConfigError) {
      return { success: false, error: Object.freeze({ code: error.code, message: error.message }) };
    }
    return {
      success: false,
      error: Object.freeze({ code: "invalidInput", message: ERROR_MESSAGES.invalidInput }),
    };
  }
}

/** The strict boundary schema; callers that need a safe error should use parseStartupConfig. */
export const startupConfigSchema = z.unknown().transform(parseValidatedConfig);

export const startupConfigErrorMessages = Object.freeze({ ...ERROR_MESSAGES });
