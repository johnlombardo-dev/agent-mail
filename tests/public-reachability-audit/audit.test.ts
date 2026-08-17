import { describe, expect, test } from "bun:test";
import { cliCommandRegistry } from "../../packages/cli/src/command-registry";
import { publicOperationRegistry } from "../../packages/daemon/src/http";
import {
  auditReachability,
  authorizedPlanCommitServiceEdge,
  forbiddenExecutorModule,
  type ReachabilityRoot,
} from "./audit";

const workspaceRoot = process.cwd();
const directRoute = "tests/public-reachability-audit/fixtures/direct-route.ts";
const hiddenRoute = "tests/public-reachability-audit/fixtures/hidden-reexport-route.ts";
const rawAdapter = "tests/public-reachability-audit/fixtures/raw-mutation-adapter.ts";
const authorizedRoute = "tests/public-reachability-audit/fixtures/authorized-plan-commit-route.ts";
const authorizedService = "tests/public-reachability-audit/fixtures/authorized-plan-commit-service.ts";

function root(id: string, file: string): ReachabilityRoot {
  return { id, file };
}

describe("public entrypoint to executor reachability audit", () => {
  test("starts from every accepted HTTP operation and CLI command entrypoint", async () => {
    const operationKeys = publicOperationRegistry.operations.map(({ key }) => key);
    const commandKeys = cliCommandRegistry.commands.map(({ operationKey }) => operationKey);
    expect(operationKeys).toHaveLength(23);
    expect(commandKeys).toEqual(operationKeys);

    const roots = [
      ...operationKeys.map((key) => root(`http-operation:${key}`, "packages/daemon/src/index.ts")),
      ...cliCommandRegistry.commands.map((command) =>
        root(`cli-command:${command.path.join(" ")}`, "packages/cli/src/index.ts"),
      ),
    ];
    const result = await auditReachability({ workspaceRoot, roots });

    expect(result.roots).toHaveLength(operationKeys.length + commandKeys.length);
    expect(result.violations).toEqual([]);
    expect(result.allowed).toEqual([]);
    expect(result.visited).not.toContain(forbiddenExecutorModule);
  });

  test("reports a direct raw-adapter route with its exact forbidden edge and path", async () => {
    const result = await auditReachability({
      workspaceRoot,
      roots: [root("fixture:direct-route", directRoute)],
      allowedEdges: [],
    });

    expect(result.violations).toEqual([
      {
        rootId: "fixture:direct-route",
        path: [directRoute, forbiddenExecutorModule],
        edge: {
          from: directRoute,
          to: forbiddenExecutorModule,
          specifier: "../../../packages/imap/src/remote-executor",
          kind: "import",
          names: ["executeWithRemoteMutationCapability"],
        },
        target: "capability-guard",
      },
    ]);
  });

  test("reports a raw-adapter import hidden behind a re-export", async () => {
    const result = await auditReachability({
      workspaceRoot,
      roots: [root("fixture:hidden-reexport-route", hiddenRoute)],
      allowedEdges: [],
    });

    expect(result.violations).toEqual([
      {
        rootId: "fixture:hidden-reexport-route",
        path: [hiddenRoute, rawAdapter, forbiddenExecutorModule],
        edge: {
          from: rawAdapter,
          to: forbiddenExecutorModule,
          specifier: "../../../packages/imap/src/remote-executor",
          kind: "export",
          names: ["executeWithRemoteMutationCapability"],
        },
        target: "capability-guard",
      },
    ]);
  });

  test("retains only the exact authorized plan-commit service edge", async () => {
    const fixtureAuthorizedEdge = {
      ...authorizedPlanCommitServiceEdge,
      from: authorizedService,
      kind: "export" as const,
    };
    const result = await auditReachability({
      workspaceRoot,
      roots: [root("fixture:authorized-plan-commit-route", authorizedRoute)],
      allowedEdges: [fixtureAuthorizedEdge],
    });

    expect(result.violations).toEqual([]);
    expect(result.allowed).toEqual([
      {
        rootId: "fixture:authorized-plan-commit-route",
        path: [authorizedRoute, authorizedService, forbiddenExecutorModule],
        edge: {
          from: authorizedService,
          to: forbiddenExecutorModule,
          specifier: "../../../packages/imap/src/remote-executor",
          kind: "export",
          names: ["executeWithRemoteMutationCapability"],
        },
      },
    ]);

    const broadened = await auditReachability({
      workspaceRoot,
      roots: [root("fixture:authorized-plan-commit-route", authorizedRoute)],
      allowedEdges: [{ ...fixtureAuthorizedEdge, names: ["RemoteMutationAdapter"] }],
    });
    expect(broadened.violations[0]).toMatchObject({
      rootId: "fixture:authorized-plan-commit-route",
      path: [authorizedRoute, authorizedService, forbiddenExecutorModule],
      edge: { from: authorizedService, to: forbiddenExecutorModule, kind: "export" },
      target: "capability-guard",
    });
  });
});
