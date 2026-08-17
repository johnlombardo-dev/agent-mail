import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export type ModulePath = string;

export type ModuleEdgeKind = "import" | "export" | "dynamic-import";

export type ModuleEdge = Readonly<{
  readonly from: ModulePath;
  readonly to: ModulePath;
  readonly specifier: string;
  readonly kind: ModuleEdgeKind;
  /** Imported or re-exported names, with `*` for a star export. */
  readonly names: readonly string[];
}>;

export type ReachabilityRoot = Readonly<{
  readonly id: string;
  readonly file: ModulePath;
}>;

/** The exact edge that may enter the internal executor from the plan-commit service. */
export type AuthorizedPlanCommitEdge = Readonly<{
  readonly from: ModulePath;
  readonly to: ModulePath;
  readonly kind: ModuleEdgeKind;
  readonly names: readonly string[];
}>;

export type ForbiddenReachability = Readonly<{
  readonly rootId: string;
  readonly path: readonly ModulePath[];
  readonly edge: ModuleEdge;
  readonly target: "capability-constructor" | "capability-guard" | "raw-mutation-adapter";
}>;

export type AllowedReachability = Readonly<{
  readonly rootId: string;
  readonly path: readonly ModulePath[];
  readonly edge: ModuleEdge;
}>;

export type ReachabilityAudit = Readonly<{
  readonly roots: readonly ReachabilityRoot[];
  readonly visited: readonly ModulePath[];
  readonly violations: readonly ForbiddenReachability[];
  readonly allowed: readonly AllowedReachability[];
}>;

/**
 * This is deliberately an exact module/symbol boundary. A substring match on
 * a path or export name would make a lookalike helper an accidental bypass.
 */
export const forbiddenExecutorModule: ModulePath = "packages/imap/src/remote-executor.ts";

function forbiddenTarget(names: readonly string[]): ForbiddenReachability["target"] {
  if (names.includes("executeWithRemoteMutationCapability")) return "capability-guard";
  if (names.includes("createRemoteMutationCapability")) return "capability-constructor";
  return "raw-mutation-adapter";
}

/**
 * Reserved production edge for the future authorized plan-commit service.
 * The service must use this exact module and named export; callers cannot
 * broaden it by matching a path prefix or a similarly named function.
 */
export const authorizedPlanCommitServiceEdge: AuthorizedPlanCommitEdge = Object.freeze({
  from: "packages/daemon/src/plan-commit-service.ts",
  to: forbiddenExecutorModule,
  kind: "import",
  names: Object.freeze(["executeWithRemoteMutationCapability"]),
});

type ParsedImport = Readonly<{
  readonly specifier: string;
  readonly kind: ModuleEdgeKind;
  readonly names: readonly string[];
}>;

function unique<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const valueKey = key(value);
    if (seen.has(valueKey)) return false;
    seen.add(valueKey);
    return true;
  });
}

function importedNames(clause: string): readonly string[] {
  const trimmed = clause.trim();
  if (trimmed === "*") return ["*"];
  const names: string[] = [];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    for (const item of trimmed.slice(braceStart + 1, braceEnd).split(",")) {
      const normalized = item.trim().replace(/^type\s+/u, "");
      if (normalized === "") continue;
      const [name] = normalized.split(/\s+as\s+/u);
      if (name !== undefined && name !== "") names.push(name);
    }
  }
  const withoutBraces = trimmed.replace(/\{[\s\S]*\}/u, "").trim();
  if (withoutBraces !== "" && !withoutBraces.startsWith("type ")) {
    const [defaultName] = withoutBraces.split(",", 1);
    if (defaultName !== undefined && defaultName.trim() !== "") names.push("default");
  }
  if (names.length === 0) names.push("*");
  return unique(names, (name) => name);
}

function parseImports(source: string): readonly ParsedImport[] {
  const parsed: ParsedImport[] = [];
  const fromPattern = /\b(import|export)\s+(?:(type)\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(fromPattern)) {
    const kind: ModuleEdgeKind = match[1] === "export" ? "export" : "import";
    const clause = match[3] ?? "";
    const specifier = match[4];
    if (specifier === undefined) continue;
    parsed.push({ specifier, kind, names: importedNames(clause) });
  }

  const sideEffectPattern = /\bimport\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(sideEffectPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) parsed.push({ specifier, kind: "import", names: ["*"] });
  }

  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(dynamicPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) parsed.push({ specifier, kind: "dynamic-import", names: ["*"] });
  }
  return unique(parsed, (entry) => `${entry.kind}:${entry.specifier}:${entry.names.join(",")}`);
}

const packageDirectories: Readonly<Record<string, string>> = Object.freeze({
  "@agent-mail/core": "packages/core",
  "@agent-mail/contracts": "packages/contracts",
  "@agent-mail/storage": "packages/storage",
  "@agent-mail/imap": "packages/imap",
  "agent-maild": "packages/daemon",
  "agent-mail": "packages/cli",
});

function packageSpecifier(
  specifier: string,
): Readonly<{ name: string; suffix: string }> | undefined {
  const name = Object.keys(packageDirectories)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`));
  if (name === undefined) return undefined;
  return { name, suffix: specifier.slice(name.length).replace(/^\//u, "") };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveSourcePath(
  workspaceRoot: string,
  from: ModulePath,
  specifier: string,
): Promise<ModulePath | undefined> {
  const fromAbsolute = resolve(workspaceRoot, from);
  const packageMatch = packageSpecifier(specifier);
  const base =
    packageMatch === undefined
      ? specifier.startsWith(".")
        ? resolve(dirname(fromAbsolute), specifier)
        : undefined
      : resolve(
          workspaceRoot,
          packageDirectories[packageMatch.name]!,
          packageMatch.suffix === ""
            ? "src"
            : packageMatch.suffix.startsWith("src/")
              ? packageMatch.suffix
              : join("src", packageMatch.suffix),
        );
  // External and built-in dependencies are outside this workspace graph. Only
  // exact workspace package names and relative source imports are traversed.
  if (base === undefined) return undefined;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return relative(workspaceRoot, candidate);
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

async function moduleEdges(
  workspaceRoot: string,
  from: ModulePath,
): Promise<readonly ModuleEdge[]> {
  const source = await readFile(resolve(workspaceRoot, from), "utf8");
  const parsed = (
    await Promise.all(
      parseImports(source).map(async (entry) => {
        const to = await resolveSourcePath(workspaceRoot, from, entry.specifier);
        return to === undefined
          ? undefined
          : ({
              from,
              to,
              specifier: entry.specifier,
              kind: entry.kind,
              names: entry.names,
            } satisfies ModuleEdge);
      }),
    )
  ).filter((edge): edge is ModuleEdge => edge !== undefined);
  return unique(parsed, (edge) => `${edge.kind}:${edge.to}:${edge.names.join(",")}`);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isAuthorizedEdge(edge: ModuleEdge, allowed: readonly AuthorizedPlanCommitEdge[]): boolean {
  return allowed.some(
    (candidate) =>
      candidate.from === edge.from &&
      candidate.to === edge.to &&
      candidate.kind === edge.kind &&
      sameNames(candidate.names, edge.names),
  );
}

export async function auditReachability(
  input: Readonly<{
    readonly workspaceRoot: string;
    readonly roots: readonly ReachabilityRoot[];
    readonly allowedEdges?: readonly AuthorizedPlanCommitEdge[];
  }>,
): Promise<ReachabilityAudit> {
  const allowedEdges = input.allowedEdges ?? [authorizedPlanCommitServiceEdge];
  const edgeCache = new Map<ModulePath, readonly ModuleEdge[]>();
  const visited = new Set<ModulePath>();
  const violations: ForbiddenReachability[] = [];
  const allowed: AllowedReachability[] = [];

  async function edgesFor(from: ModulePath): Promise<readonly ModuleEdge[]> {
    const cached = edgeCache.get(from);
    if (cached !== undefined) return cached;
    const edges = await moduleEdges(input.workspaceRoot, from);
    edgeCache.set(from, edges);
    return edges;
  }

  async function visit(
    root: ReachabilityRoot,
    current: ModulePath,
    path: readonly ModulePath[],
  ): Promise<void> {
    visited.add(current);
    for (const edge of await edgesFor(current)) {
      const nextPath = [...path, edge.to];
      if (isAuthorizedEdge(edge, allowedEdges)) {
        allowed.push({ rootId: root.id, path: nextPath, edge });
        continue;
      }
      if (edge.to === forbiddenExecutorModule) {
        violations.push({
          rootId: root.id,
          path: nextPath,
          edge,
          target: forbiddenTarget(edge.names),
        });
        continue;
      }
      if (path.includes(edge.to)) continue;
      await visit(root, edge.to, nextPath);
    }
  }

  for (const root of input.roots) await visit(root, root.file, [root.file]);
  return Object.freeze({
    roots: input.roots,
    visited: Object.freeze([...visited].sort()),
    violations: Object.freeze(violations),
    allowed: Object.freeze(allowed),
  });
}
