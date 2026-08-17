import { describe, expect, it } from "bun:test";
import {
  cliCommandDefinitions,
  cliCommandRegistry,
  createCliCommandRegistry,
  publicCliOperations,
  type CliCommandDefinition,
} from "../src/command-registry";

describe("CLI command registry", () => {
  it("maps every public operation exactly once and preserves shared metadata", () => {
    expect(cliCommandRegistry.commands).toHaveLength(publicCliOperations.length);
    expect(cliCommandRegistry.commands.map(({ operationKey }) => operationKey)).toEqual(
      publicCliOperations.map(({ key }) => key),
    );
    for (const command of cliCommandRegistry.commands) {
      const operation = publicCliOperations.find(({ key }) => key === command.operationKey);
      expect(command.operation).toBe(operation);
      expect(command.scope).toBe(operation?.scope);
      expect(command.streaming).toBe(operation?.streaming);
    }
    expect(cliCommandRegistry.getByPath(["messages", "search"])?.operationKey).toBe("messages.search");
    expect(cliCommandRegistry.getByPath(["messages", "raw"])?.operation.streaming).toBe("bytes");
  });

  it("rejects missing, duplicate, scope-drifted, and streaming-drifted mappings", () => {
    const base = [...cliCommandDefinitions];
    expect(() => createCliCommandRegistry(base.slice(1))).toThrow(/missing public/);
    expect(() => createCliCommandRegistry([...base, base[0]!])).toThrow(/duplicate CLI operation key/);
    expect(() => createCliCommandRegistry([
      { ...base[0]!, scope: "mail:wrong" },
      ...base.slice(1),
    ])).toThrow(/scope drift/);
    const raw = base.find(({ operationKey }) => operationKey === "messages.raw")!;
    expect(() => createCliCommandRegistry([
      ...base.filter((command) => command !== raw),
      { ...raw, streaming: "none" },
    ])).toThrow(/streaming drift/);
  });

  it("rejects aliases that change scope and the adjacent messages delete alias", () => {
    const search = cliCommandDefinitions.find(({ operationKey }) => operationKey === "messages.search")!;
    const withScopeDrift: CliCommandDefinition = {
      ...search,
      aliases: [{ path: ["mail", "search"], scope: "mail:write" }],
    };
    expect(() => createCliCommandRegistry([
      withScopeDrift,
      ...cliCommandDefinitions.filter((command) => command !== search),
    ])).toThrow(/changes operation scope/);

    const withDeleteAlias: CliCommandDefinition = {
      ...search,
      aliases: [{ path: ["messages", "delete"] }],
    };
    expect(() => createCliCommandRegistry([
      withDeleteAlias,
      ...cliCommandDefinitions.filter((command) => command !== search),
    ])).toThrow(/messages delete/);
  });
});
