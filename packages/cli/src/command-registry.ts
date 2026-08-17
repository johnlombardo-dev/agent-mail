import {
  actionPlanOperationDefinitions,
  reportAdminOperationDefinitions,
  retrievalOperationDefinitions,
  routingOperationDefinitions,
  syncOperationDefinitions,
  type OperationDefinition,
  type OperationStreaming,
} from "@agent-mail/contracts";

/** A command alias only names another path; it never owns another operation. */
export type CliCommandAlias = Readonly<{
  readonly path: readonly [string, ...string[]];
  readonly operationKey?: string;
  readonly scope?: string;
  readonly streaming?: OperationStreaming;
}>;

/** Data consumed by a future parser, with schemas retained by the operation object. */
export type CliCommandDefinition = Readonly<{
  readonly path: readonly [string, ...string[]];
  readonly operationKey: string;
  readonly scope: string;
  readonly streaming: OperationStreaming;
  readonly operation: OperationDefinition;
  readonly aliases?: readonly CliCommandAlias[];
}>;

export type CliCommandNode = Readonly<{
  readonly name: string;
  readonly path: readonly string[];
  readonly command?: CliCommandDefinition;
  readonly children: readonly CliCommandNode[];
}>;

export type CliCommandRegistry = Readonly<{
  readonly commands: readonly CliCommandDefinition[];
  readonly tree: CliCommandNode;
  readonly getByOperationKey: (operationKey: string) => CliCommandDefinition | undefined;
  readonly getByPath: (path: readonly string[]) => CliCommandDefinition | undefined;
}>;

/** Every operation in these lists is a user-facing operation; executor capabilities are absent. */
export const publicCliOperations = Object.freeze([
  ...retrievalOperationDefinitions,
  ...routingOperationDefinitions,
  ...actionPlanOperationDefinitions,
  ...reportAdminOperationDefinitions,
  ...syncOperationDefinitions,
] as const);

function commandPath(operation: OperationDefinition): [string, ...string[]] {
  const parts = operation.cliName.split("-");
  if (parts.length === 0 || parts.some((part) => part.length === 0))
    throw new TypeError(`operation ${operation.key} has no CLI command path`);
  return parts as [string, ...string[]];
}

/** Canonical commands are mechanically derived, so a new public operation cannot be omitted. */
export const cliCommandDefinitions = Object.freeze(
  publicCliOperations.map((operation) => ({
    path: commandPath(operation),
    operationKey: operation.key,
    scope: operation.scope,
    streaming: operation.streaming,
    operation,
  })) satisfies readonly CliCommandDefinition[],
);

function pathKey(path: readonly string[]): string {
  return path.join(" ");
}

function assertPath(path: readonly string[], label: string): void {
  if (path.length === 0 || path.some((part) => part.length === 0))
    throw new TypeError(`${label} must contain non-empty path segments`);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate CLI ${label}: ${value}`);
    seen.add(value);
  }
}

function validateAlias(alias: CliCommandAlias, command: CliCommandDefinition): void {
  assertPath(alias.path, "CLI alias path");
  const aliasPath = pathKey(alias.path);
  // This public surface has no delete operation; never let a read-only key acquire that alias.
  if (aliasPath === "messages delete")
    throw new TypeError("messages delete cannot alias a read-only operation");
  if (alias.operationKey !== undefined && alias.operationKey !== command.operationKey)
    throw new TypeError(`CLI alias ${aliasPath} changes operation key`);
  if (alias.scope !== undefined && alias.scope !== command.scope)
    throw new TypeError(`CLI alias ${aliasPath} changes operation scope`);
  if (alias.streaming !== undefined && alias.streaming !== command.streaming)
    throw new TypeError(`CLI alias ${aliasPath} changes streaming classification`);
}

function validateCommand(
  command: CliCommandDefinition,
  expectedByKey: ReadonlyMap<string, OperationDefinition>,
): void {
  assertPath(command.path, "CLI command path");
  const expected = expectedByKey.get(command.operationKey);
  if (expected === undefined)
    throw new TypeError(`unknown public CLI operation: ${command.operationKey}`);
  if (command.operation !== expected)
    throw new TypeError(`CLI operation ${command.operationKey} is not the shared definition`);
  if (pathKey(command.path) !== pathKey(commandPath(expected)))
    throw new TypeError(`CLI operation ${command.operationKey} has canonical path drift`);
  if (command.scope !== expected.scope)
    throw new TypeError(`CLI operation ${command.operationKey} has scope drift`);
  if (command.streaming !== expected.streaming)
    throw new TypeError(`CLI operation ${command.operationKey} has streaming drift`);
  for (const alias of command.aliases ?? []) validateAlias(alias, command);
}

function buildTree(commands: readonly CliCommandDefinition[]): CliCommandNode {
  type MutableNode = {
    name: string;
    path: string[];
    command?: CliCommandDefinition;
    children: MutableNode[];
  };
  const root: MutableNode = { name: "", path: [], children: [] };
  for (const command of commands) {
    let current = root;
    command.path.forEach((segment, index) => {
      let child = current.children.find((candidate) => candidate.name === segment);
      if (child === undefined) {
        child = { name: segment, path: [...current.path, segment], children: [] };
        current.children.push(child);
      }
      current = child;
      if (index === command.path.length - 1) {
        if (current.command !== undefined)
          throw new Error(`duplicate CLI path: ${pathKey(command.path)}`);
        current.command = command;
      }
    });
  }
  const freeze = (node: MutableNode): CliCommandNode =>
    Object.freeze({
      name: node.name,
      path: Object.freeze([...node.path]),
      ...(node.command === undefined ? {} : { command: node.command }),
      children: Object.freeze(node.children.map(freeze)),
    });
  return freeze(root);
}

/** Validate and materialize a command tree against the shared public operation set. */
export function createCliCommandRegistry(
  definitions: readonly CliCommandDefinition[] = cliCommandDefinitions,
  expectedOperations: readonly OperationDefinition[] = publicCliOperations,
): CliCommandRegistry {
  const expectedByKey = new Map(expectedOperations.map((operation) => [operation.key, operation]));
  assertUnique(
    expectedOperations.map(({ key }) => key),
    "expected operation key",
  );
  definitions.forEach((command) => validateCommand(command, expectedByKey));
  assertUnique(
    definitions.map(({ operationKey }) => operationKey),
    "operation key",
  );
  assertUnique(
    definitions.map(({ path }) => pathKey(path)),
    "path",
  );
  const expectedKeys = new Set(expectedOperations.map(({ key }) => key));
  const actualKeys = new Set(definitions.map(({ operationKey }) => operationKey));
  for (const key of expectedKeys)
    if (!actualKeys.has(key)) throw new Error(`missing public CLI operation: ${key}`);
  const aliasPaths = definitions.flatMap(({ aliases = [] }) =>
    aliases.map(({ path }) => pathKey(path)),
  );
  assertUnique(aliasPaths, "alias path");
  const canonicalPaths = new Set(definitions.map(({ path }) => pathKey(path)));
  for (const aliasPath of aliasPaths)
    if (canonicalPaths.has(aliasPath))
      throw new Error(`CLI alias shadows canonical path: ${aliasPath}`);
  const commands = Object.freeze(definitions.map((command) => Object.freeze({ ...command })));
  const tree = buildTree(commands);
  const getByOperationKey = (operationKey: string): CliCommandDefinition | undefined =>
    commands.find((command) => command.operationKey === operationKey);
  const getByPath = (path: readonly string[]): CliCommandDefinition | undefined => {
    const target = pathKey(path);
    return (
      commands.find((command) => pathKey(command.path) === target) ??
      commands.find((command) => command.aliases?.some((alias) => pathKey(alias.path) === target))
    );
  };
  return Object.freeze({ commands, tree, getByOperationKey, getByPath });
}

export const cliCommandRegistry = createCliCommandRegistry();
