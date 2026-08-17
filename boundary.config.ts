import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

type PackageName =
  | "@agent-mail/core"
  | "@agent-mail/contracts"
  | "@agent-mail/storage"
  | "@agent-mail/imap"
  | "agent-maild"
  | "agent-mail";
type JsonObject = Record<string, unknown>;
const packageNames: readonly PackageName[] = [
  "@agent-mail/core",
  "@agent-mail/contracts",
  "@agent-mail/storage",
  "@agent-mail/imap",
  "agent-maild",
  "agent-mail",
];
const allowedDependencies: Readonly<Record<PackageName, readonly PackageName[]>> = {
  "@agent-mail/core": [],
  "@agent-mail/contracts": [],
  "@agent-mail/storage": ["@agent-mail/core"],
  "@agent-mail/imap": ["@agent-mail/core"],
  "agent-maild": [
    "@agent-mail/contracts",
    "@agent-mail/core",
    "@agent-mail/imap",
    "@agent-mail/storage",
  ],
  "agent-mail": ["@agent-mail/contracts"],
};
const workspaceRoot = process.env.BOUNDARY_ROOT ?? process.cwd();
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPackageName(value: string): value is PackageName {
  return packageNames.some((name) => name === value);
}
function workspacePackageNameFromSpecifier(value: string): PackageName | undefined {
  const packageSpecifier = /^(?:((?:@agent-mail\/)?[^/]+))(?:\/.*)?$/.exec(value)?.[1];
  return packageSpecifier !== undefined && isPackageName(packageSpecifier)
    ? packageSpecifier
    : undefined;
}
async function readJson(path: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonObject(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}
function packageName(value: unknown, path: string): PackageName {
  if (typeof value !== "string" || !isPackageName(value))
    throw new Error(`${path} has an unknown workspace package name`);
  return value;
}
function dependencyNames(value: unknown): readonly string[] {
  return isJsonObject(value) ? Object.keys(value) : [];
}
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}
function importedWorkspacePackages(source: string): readonly PackageName[] {
  const imports = source.matchAll(
    /(?:from\s*["']|import\s*["']|import\s*\(\s*["'])((?:@agent-mail\/[^"']+|agent-maild(?:\/[^"']*)?|agent-mail(?:\/[^"']*)?))["']/g,
  );
  return [...imports].flatMap((match) => {
    const packageName =
      match[1] === undefined ? undefined : workspacePackageNameFromSpecifier(match[1]);
    return packageName === undefined ? [] : [packageName];
  });
}
const violations: string[] = [];
const graph = new Map<PackageName, readonly PackageName[]>();
for (const expectedName of packageNames) {
  const directoryName = expectedName.startsWith("@agent-mail/")
    ? expectedName.replace("@agent-mail/", "")
    : expectedName === "agent-maild"
      ? "daemon"
      : "cli";
  const directory = join(workspaceRoot, "packages", directoryName);
  const manifestPath = join(directory, "package.json");
  const manifest = await readJson(manifestPath);
  const actualName = packageName(manifest.name, manifestPath);
  if (actualName !== expectedName) violations.push(`${directory}: manifest name is ${actualName}`);
  const declared = [
    ...dependencyNames(manifest.dependencies),
    ...dependencyNames(manifest.devDependencies),
  ];
  const workspaceDependencies = declared.filter(isPackageName);
  graph.set(expectedName, workspaceDependencies);
  for (const dependency of workspaceDependencies)
    if (!allowedDependencies[expectedName].includes(dependency))
      violations.push(`${expectedName} declares forbidden dependency ${dependency}`);
  for (const file of await sourceFiles(join(directory, "src")))
    for (const imported of importedWorkspacePackages(await readFile(file, "utf8")))
      if (!allowedDependencies[expectedName].includes(imported))
        violations.push(`${relative(workspaceRoot, file)} imports forbidden package ${imported}`);
}
function visit(
  name: PackageName,
  visiting: ReadonlySet<PackageName>,
  visited: ReadonlySet<PackageName>,
): void {
  if (visiting.has(name)) {
    violations.push(`dependency cycle includes ${name}`);
    return;
  }
  if (visited.has(name)) return;
  const nextVisiting = new Set(visiting).add(name);
  const nextVisited = new Set(visited).add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, nextVisiting, nextVisited);
}
for (const name of packageNames) visit(name, new Set(), new Set());
if (violations.length > 0) {
  for (const violation of violations) console.error(`boundary: ${violation}`);
  process.exit(1);
}
console.log(`boundary: ${packageNames.length} packages, inward dependency graph is valid`);
