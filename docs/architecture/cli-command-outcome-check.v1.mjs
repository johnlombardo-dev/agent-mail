import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommandDefinitions } from "../../packages/cli/src/command-registry.ts";
import { httpErrorRegistry } from "../../packages/contracts/src/http-error-authority.ts";

const EXPECTED_ORACLE_SHA256 = "428c4043a5cfa031d237bf9638911b8a2ec71d7c919c11dacfde31b70f3bcfa8";
const ACCEPTED_HEAD = "778e01b16cbdbe8917975c85818eaff967dc0a7f";
const architectureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDirectory, "../..");
const oraclePath = join(architectureDirectory, "cli-command-outcome-oracle.v1.json");
const viewPaths = [
  join(architectureDirectory, "cli-command-outcome-design.v1.md"),
  join(architectureDirectory, "cli-command-outcome-decisions.v1.md"),
  join(architectureDirectory, "cli-command-outcome-coverage.v1.md"),
];
const EXPECTED_VIEW_SHA256 = [
  "201f0cb2e748b580610178c703fdc9a120e8ed76d984307d9c3f446d8238df9f",
  "cfda46242844efbf5f3f56803aeb2682bc428c9952eb4f6ef7ac56dcb85e43f0",
  "12793068f43a163e3eaed644d16bb65ab909c0073d4d7fece1378704600db6ea",
];

function fail(message) {
  throw new Error("CLI command outcome check failed: " + message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function exactValue(actual, expected, label) {
  if (stable(actual) !== stable(expected)) {
    fail(label + " differs: " + stable(actual));
  }
}

function unique(items, key, label) {
  const values = items.map(key);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(label + " has an invalid key");
  }
  if (new Set(values).size !== values.length) fail(label + " has a duplicate key");
  return new Set(values);
}

function exactSet(actual, expected, label) {
  const compare = (leftValue, rightValue) => stable(leftValue).localeCompare(stable(rightValue));
  const left = [...actual].sort(compare);
  const right = [...expected].sort(compare);
  if (stable(left) !== stable(right)) fail(label + " differs: " + stable(left));
}

function exactRows(actual, expected, label) {
  const left = actual.map(stable).sort();
  const right = expected.map(stable).sort();
  if (stable(left) !== stable(right)) fail(label + " differs: " + stable(actual));
}

function requireReferences(values, authority, label) {
  if (!Array.isArray(values) || values.length === 0) fail(label + " is empty");
  for (const value of values) {
    if (!authority.has(value)) fail(label + " references unknown " + value);
  }
}

function readCommitted(path, commit) {
  try {
    return execFileSync("git", ["show", commit + ":" + path], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail("cannot read committed authority " + commit + ":" + path);
  }
}

function resolveJsonPointer(root, fragment, label) {
  if (fragment === "" || fragment === "#") return root;
  if (!fragment.startsWith("#/")) fail(label + " has unsupported JSON pointer " + fragment);
  let current = root;
  for (const encoded of fragment.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(key in current)) {
      fail(label + " has unresolved JSON pointer " + fragment);
    }
    current = current[key];
  }
  return current;
}

function resolveSchemaReference(reference, registry, currentRoot, label) {
  if (reference.startsWith("#")) {
    return { schema: resolveJsonPointer(currentRoot, reference, label), root: currentRoot };
  }
  const hashIndex = reference.indexOf("#");
  const id = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex);
  const root = registry.get(id);
  if (root === undefined) fail(label + " references unknown schema " + id);
  return { schema: resolveJsonPointer(root, fragment, label), root };
}

function matchesJsonType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function jsonSchemaErrors(value, schema, registry, currentRoot = schema, path = "$") {
  if (schema === true) return [];
  if (schema === false) return [path + " is forbidden"];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [path + " has an invalid schema"];
  }
  if (typeof schema.$ref === "string") {
    const resolved = resolveSchemaReference(schema.$ref, registry, currentRoot, path);
    return jsonSchemaErrors(value, resolved.schema, registry, resolved.root, path);
  }

  const errors = [];
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (candidate) => jsonSchemaErrors(value, candidate, registry, currentRoot, path).length === 0,
    ).length;
    if (matches !== 1) errors.push(path + " matched " + matches + " oneOf branches");
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(
      (candidate) => jsonSchemaErrors(value, candidate, registry, currentRoot, path).length === 0,
    );
    if (!matches) errors.push(path + " matched no anyOf branch");
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      errors.push(...jsonSchemaErrors(value, candidate, registry, currentRoot, path));
    }
  }
  if (
    schema.not !== undefined &&
    jsonSchemaErrors(value, schema.not, registry, currentRoot, path).length === 0
  ) {
    errors.push(path + " matched forbidden schema");
  }
  if (schema.const !== undefined && stable(value) !== stable(schema.const)) {
    errors.push(path + " differs from const");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => stable(item) === stable(value))) {
    errors.push(path + " is outside enum");
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => matchesJsonType(value, type))) {
      errors.push(path + " has the wrong type");
      return errors;
    }
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      errors.push(path + " is shorter than minLength");
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      errors.push(path + " is longer than maxLength");
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(path + " does not match pattern");
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(path + " is below minimum");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(path + " is above maximum");
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(path + " has fewer than minItems");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(path + " has more than maxItems");
    }
    if (schema.uniqueItems === true && new Set(value.map(stable)).size !== value.length) {
      errors.push(path + " has duplicate items");
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        errors.push(
          ...jsonSchemaErrors(item, schema.items, registry, currentRoot, path + "[" + index + "]"),
        );
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(path + " has fewer than minProperties");
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push(path + " has more than maxProperties");
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(path + " omits " + required);
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        errors.push(
          ...jsonSchemaErrors(
            key,
            schema.propertyNames,
            registry,
            currentRoot,
            path + " property " + JSON.stringify(key),
          ),
        );
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(
          ...jsonSchemaErrors(item, properties[key], registry, currentRoot, path + "." + key),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(path + " has additional property " + key);
      } else if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties === "object"
      ) {
        errors.push(
          ...jsonSchemaErrors(
            item,
            schema.additionalProperties,
            registry,
            currentRoot,
            path + "." + key,
          ),
        );
      }
    }
  }
  return errors;
}

function schemaAccepts(value, schema, registry) {
  return jsonSchemaErrors(value, schema, registry).length === 0;
}

function requireSchemaAccepts(value, schema, registry, label) {
  const errors = jsonSchemaErrors(value, schema, registry);
  if (errors.length > 0) fail(label + " rejected: " + errors[0]);
}

function requireSchemaRejects(value, schema, registry, label) {
  if (schemaAccepts(value, schema, registry)) fail(label + " was accepted");
}

function readPath(input, path) {
  let current = input;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function hasPath(input, path) {
  return readPath(input, path) !== undefined;
}

function targetIdentity(target, fields) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    fail("target coverage received a non-object target");
  }
  const values = fields.map((field) => {
    if (!Object.hasOwn(target, field)) fail("target coverage target omits " + field);
    return target[field];
  });
  return JSON.stringify(values);
}

function classifyTargetCoverage(targets, results, resultTargetPath, targetAuthority) {
  if (!Array.isArray(targets) || !Array.isArray(results)) {
    fail("target coverage requires target and result arrays");
  }
  const fields = targetAuthority.fields;
  const targetIds = targets.map((target) => targetIdentity(target, fields));
  const resultIds = results.map((result) => {
    const target = readPath(result, resultTargetPath);
    if (target === undefined) fail("target coverage result omits target path");
    return targetIdentity(target, fields);
  });
  const targetCounts = new Map();
  const resultCounts = new Map();
  for (const id of targetIds) targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);
  for (const id of resultIds) resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
  const problems = [];
  if ([...targetCounts].some(([id]) => (resultCounts.get(id) ?? 0) === 0)) {
    problems.push("missing");
  }
  if (
    [...targetCounts.values()].some((count) => count > 1) ||
    [...resultCounts.values()].some((count) => count > 1)
  ) {
    problems.push("duplicate");
  }
  if ([...resultCounts].some(([id]) => !targetCounts.has(id))) problems.push("unexpected");
  if (problems.length === 0) return "exact";
  if (problems.length === 1) return problems[0];
  return "multiple-invalid";
}

function evaluateProjection(input, projection, targetAuthority) {
  const value = readPath(input, projection.path ?? []);
  switch (projection.op) {
    case "path":
      return value;
    case "literal":
      return projection.value;
    case "has-path":
      return hasPath(input, projection.path);
    case "union-discriminant":
      if (value === projection.sentinel) return projection.sentinel;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
      return value[projection.field];
    case "array-empty":
      if (!Array.isArray(value)) return undefined;
      return value.length === 0;
    case "array-any-eq":
      if (!Array.isArray(value)) return undefined;
      return value.some(
        (item) => stable(readPath(item, projection.itemPath)) === stable(projection.value),
      );
    case "array-any-not-eq":
      if (!Array.isArray(value)) return undefined;
      return value.some(
        (item) => stable(readPath(item, projection.itemPath)) !== stable(projection.value),
      );
    case "array-mixed-eq": {
      if (!Array.isArray(value)) return undefined;
      const equal = value.some(
        (item) => stable(readPath(item, projection.itemPath)) === stable(projection.value),
      );
      const different = value.some(
        (item) => stable(readPath(item, projection.itemPath)) !== stable(projection.value),
      );
      return equal && different;
    }
    case "array-all-eq-nonempty":
      if (!Array.isArray(value)) return undefined;
      return (
        value.length > 0 &&
        value.every(
          (item) => stable(readPath(item, projection.itemPath)) === stable(projection.value),
        )
      );
    case "target-coverage":
      return classifyTargetCoverage(
        readPath(input, projection.targetsPath),
        readPath(input, projection.resultsPath),
        projection.resultTargetPath,
        targetAuthority,
      );
    default:
      fail("unsupported projection operator " + projection.op);
  }
}

function projectDomainFacts(input, selector, dsl) {
  const facts = {
    registeredErrorSemanticKind: readPath(input, dsl.registeredErrorProjection.path),
  };
  for (const [fact, projection] of Object.entries(selector.factProjection)) {
    facts[fact] = evaluateProjection(input, projection, dsl.targetIdentity);
  }
  return facts;
}

function evaluateExpression(expression, facts) {
  switch (expression.op) {
    case "const":
      return expression.value;
    case "eq":
      return stable(facts[expression.fact]) === stable(expression.value);
    case "in":
      return expression.values.some((value) => stable(facts[expression.fact]) === stable(value));
    case "all":
      return expression.clauses.every((clause) => evaluateExpression(clause, facts));
    case "any":
      return expression.clauses.some((clause) => evaluateExpression(clause, facts));
    case "not-null":
      return facts[expression.fact] !== null;
    default:
      fail("unsupported expression operator " + expression.op);
  }
}

function collectExpressionFacts(expression, facts = new Set()) {
  if (typeof expression.fact === "string") facts.add(expression.fact);
  for (const clause of expression.clauses ?? []) collectExpressionFacts(clause, facts);
  return facts;
}

function validateExpressionValues(expression, factSchemas, registry, label) {
  if (typeof expression.fact === "string") {
    const factSchema = factSchemas[expression.fact];
    if (factSchema === undefined) fail(label + " references unknown fact " + expression.fact);
    const candidates =
      expression.op === "eq" ? [expression.value] : expression.op === "in" ? expression.values : [];
    for (const candidate of candidates) {
      requireSchemaAccepts(
        candidate,
        factSchema,
        registry,
        label + " comparison for " + expression.fact,
      );
    }
  }
  for (const [index, clause] of (expression.clauses ?? []).entries()) {
    validateExpressionValues(clause, factSchemas, registry, label + ".clauses[" + index + "]");
  }
}

function selectDomainOutcome(facts, selector, rulesById, dsl) {
  for (const ruleId of selector.ruleOrder) {
    const rule = rulesById.get(ruleId);
    if (rule === undefined) fail(selector.id + " references unknown rule " + ruleId);
    if (!evaluateExpression(rule.when, facts)) continue;
    const semanticKind =
      rule.outcome.kind === "constant" ? rule.outcome.semanticKind : facts[rule.outcome.fact];
    if (typeof semanticKind !== "string") fail(rule.id + " selected a non-string outcome");
    return { ruleId, semanticKind, localCode: null };
  }
  return {
    ruleId: null,
    semanticKind: dsl.noMatch.semanticKind,
    localCode: dsl.noMatch.localCode,
  };
}

function buildSchemaRegistry(oracle) {
  const schemas = [
    ...Object.values(oracle.structuredSchemas),
    ...oracle.localDetailSchemas.map((row) => row.schema),
    oracle.domainRuleDsl.expressionSchema,
    oracle.domainRuleDsl.outcomeSchema,
    oracle.domainRuleDsl.projectionSchema,
    oracle.domainRuleDsl.ruleSchema,
    oracle.domainRuleDsl.selectorSchema,
  ];
  const registry = new Map();
  for (const schema of schemas) {
    if (typeof schema?.$id !== "string" || schema.$id.length === 0) continue;
    if (registry.has(schema.$id)) fail("duplicate schema ID " + schema.$id);
    registry.set(schema.$id, schema);
  }
  return registry;
}

const expectedExits = [
  ["success", "EX_OK", 0, "standard"],
  ["usage", "EX_USAGE", 64, "sysexits"],
  ["invalid_input", "EX_DATAERR", 65, "sysexits"],
  ["not_found", "EX_NOINPUT", 66, "sysexits"],
  ["unavailable", "EX_UNAVAILABLE", 69, "sysexits"],
  ["internal", "EX_SOFTWARE", 70, "sysexits"],
  ["io", "EX_IOERR", 74, "sysexits"],
  ["temporary", "EX_TEMPFAIL", 75, "sysexits"],
  ["protocol", "EX_PROTOCOL", 76, "sysexits"],
  ["authorization", "EX_NOPERM", 77, "sysexits"],
  ["configuration", "EX_CONFIG", 78, "sysexits"],
  ["conflict", "AM_EX_CONFLICT", 79, "agent-mail"],
  ["stale", "AM_EX_STALE", 80, "agent-mail"],
  ["expired", "AM_EX_EXPIRED", 81, "agent-mail"],
  ["replay", "AM_EX_REPLAY", 82, "agent-mail"],
  ["tampered", "AM_EX_TAMPERED", 83, "agent-mail"],
  ["cancelled", "AM_EX_CANCELLED", 84, "agent-mail"],
  ["attention", "AM_EX_ATTENTION", 85, "agent-mail"],
  ["partial", "AM_EX_PARTIAL", 86, "agent-mail"],
  ["uncertain", "AM_EX_UNCERTAIN", 87, "agent-mail"],
  ["partial_output", "AM_EX_PARTIAL_OUTPUT", 88, "agent-mail"],
].map(([semanticKind, symbol, code, className]) => ({
  semanticKind,
  symbol,
  code,
  class: className,
}));

const expectedLocalErrors = [
  [
    "cli.usage",
    "command invocation is invalid",
    "usage",
    "LOCAL-DETAIL-CLI-USAGE",
    { commandPath: null, reasonCode: "unknown-command" },
  ],
  [
    "cli.invalid-input",
    "command input does not satisfy the shared request contract",
    "invalid_input",
    "LOCAL-DETAIL-CLI-INVALID-INPUT",
    { operationKey: "messages.search", reasonCode: "request-schema" },
  ],
  [
    "cli.configuration",
    "Agent Mail configuration is missing or invalid",
    "configuration",
    "LOCAL-DETAIL-CLI-CONFIGURATION",
    { settingCode: "daemon.base-url", reasonCode: "missing" },
  ],
  [
    "cli.connect-timeout",
    "connection did not complete before its deadline",
    "temporary",
    "LOCAL-DETAIL-CLI-CONNECT-TIMEOUT",
    { operationKey: "messages.search", phase: "connect" },
  ],
  [
    "cli.control-timeout",
    "control response did not arrive before its deadline",
    "temporary",
    "LOCAL-DETAIL-CLI-CONTROL-TIMEOUT",
    { operationKey: "sync.pause", phase: "control" },
  ],
  [
    "cli.stream-idle-timeout",
    "stream made no progress before its idle deadline",
    "temporary",
    "LOCAL-DETAIL-CLI-STREAM-IDLE-TIMEOUT",
    { operationKey: "messages.raw", phase: "stream-idle" },
  ],
  [
    "cli.protocol",
    "the CLI and service contract do not agree",
    "protocol",
    "LOCAL-DETAIL-CLI-PROTOCOL",
    { operationKey: null, phase: "result-validation" },
  ],
  [
    "cli.cancelled",
    "command execution was cancelled",
    "cancelled",
    "LOCAL-DETAIL-CLI-CANCELLED",
    { operationKey: null, source: "caller" },
  ],
  [
    "cli.transport",
    "the Agent Mail service is unavailable",
    "unavailable",
    "LOCAL-DETAIL-CLI-TRANSPORT",
    { operationKey: "messages.search", phase: "request" },
  ],
  [
    "cli.internal",
    "the CLI could not complete the command",
    "internal",
    "LOCAL-DETAIL-CLI-INTERNAL",
    { operationKey: null, phase: "result-classifier" },
  ],
  [
    "cli.output-io",
    "the requested output could not be written",
    "io",
    "LOCAL-DETAIL-CLI-OUTPUT-IO",
    { destination: "stdout", phase: "primary-frame" },
  ],
  [
    "cli.partial-output",
    "output ended after an incomplete prefix was written",
    "partial_output",
    "LOCAL-DETAIL-CLI-PARTIAL-OUTPUT",
    {
      operationKey: "exports.selected",
      causeCode: "cli.stream-idle-timeout",
      failedBoundary: "client",
      stdoutBytesAccepted: 1024,
      stderrBytesAccepted: 0,
    },
  ],
  [
    "cli.raw-tty-refused",
    "raw output is refused on a TTY without explicit opt-in",
    "usage",
    "LOCAL-DETAIL-CLI-RAW-TTY-REFUSED",
    { operationKey: "messages.raw", destination: "tty" },
  ],
].map(([code, message, semanticKind, detailSchemaId, validDetails]) => ({
  code,
  message,
  semanticKind,
  detailSchemaId,
  validDetails,
}));

const expectedSharedMappings = [
  ["invalid_request", 400, "invalid_input"],
  ["missing_credentials", 401, "authorization"],
  ["invalid_credentials", 401, "authorization"],
  ["expired_credentials", 401, "authorization"],
  ["insufficient_scope", 403, "authorization"],
  ["request_too_large", 413, "invalid_input"],
  ["not_found", 404, "not_found"],
  ["internal_error", 500, "internal"],
  ["action.approval_forbidden", 403, "authorization"],
  ["action.approval_presence_required", 403, "authorization"],
  ["action.operator_presence_unsupported", 503, "unavailable"],
  ["action.operator_challenge_capacity", 429, "temporary"],
  ["action.operator_challenge_not_found", 404, "not_found"],
  ["action.operator_challenge_expired", 409, "expired"],
  ["action.operator_challenge_consumed", 409, "replay"],
  ["action.operator_assertion_invalid", 403, "tampered"],
  ["action.approval_not_found", 409, "not_found"],
  ["action.approval_mismatch", 409, "tampered"],
  ["action.approval_expired", 409, "expired"],
  ["action.approval_cancelled", 409, "cancelled"],
  ["action.approval_invalidated", 409, "stale"],
  ["action.approval_consumed", 409, "replay"],
  ["action.plan_version_stale", 409, "stale"],
  ["action.plan_not_pending", 409, "conflict"],
  ["action.plan_expired", 409, "expired"],
  ["action.legacy_authority", 409, "authorization"],
].map(([code, status, semanticKind]) => ({ code, status, semanticKind }));

const expectedClientMappings = [
  ["connect_timeout", "cli.connect-timeout", "temporary", false],
  ["control_timeout", "cli.control-timeout", "temporary", false],
  ["stream_idle_timeout", "cli.stream-idle-timeout", "temporary", false],
  ["client_contract_error", "cli.protocol", "protocol", false],
  ["http_error", null, "registered-error-mapping", true],
  ["aborted", "cli.cancelled", "cancelled", false],
  ["transport_error", "cli.transport", "unavailable", false],
].map(([kind, localCode, semanticKind, requiresServerError]) => ({
  kind,
  localCode,
  semanticKind,
  requiresServerError,
}));

const expectedOperationMappings = [
  {
    code: "routing.preview_replayed",
    status: 409,
    selector: "constant",
    semanticKind: "replay",
  },
  {
    code: "routing.preview_expired",
    status: 409,
    selector: "constant",
    semanticKind: "expired",
  },
  {
    code: "routing.preview_tampered",
    status: 409,
    selector: "constant",
    semanticKind: "tampered",
  },
  { code: "invalid_query", status: 400, selector: "constant", semanticKind: "invalid_input" },
  { code: "invalid_cursor", status: 400, selector: "constant", semanticKind: "invalid_input" },
  { code: "not_found", status: 404, selector: "constant", semanticKind: "not_found" },
  {
    code: "sync.control-rejected",
    status: 500,
    selector: "details.reason",
    cases: {
      "stale-version": "stale",
      "incompatible-state": "conflict",
      busy: "conflict",
      "shutdown-terminal": "conflict",
    },
  },
  {
    code: "sync.control-failed",
    status: 500,
    selector: "details.reason",
    cases: { "terminal-failure": "internal", "auth-blocked": "authorization" },
  },
  { code: "sync.control-cancelled", status: 500, selector: "constant", semanticKind: "cancelled" },
  { code: "sync.control-timeout", status: 500, selector: "constant", semanticKind: "temporary" },
  {
    code: "sync.control-idempotency-conflict",
    status: 500,
    selector: "constant",
    semanticKind: "conflict",
  },
  { code: "sync.control-capacity", status: 500, selector: "constant", semanticKind: "temporary" },
];

const expectedPolicies = new Map([
  ["messages.search", "registered-error-or-success"],
  ["messages.get", "registered-error-or-success"],
  ["threads.get", "registered-error-or-success"],
  ["messages.raw", "raw"],
  ["attachments.get", "raw"],
  ["routing.preview", "success"],
  ["routing.commit", "routing-commit"],
  ["messages.label", "label"],
  ["action-plans.create", "success"],
  ["action-plans.inspect", "action-plan"],
  ["action-plans.approve", "success"],
  ["action-plans.cancel-approval", "success"],
  ["action-plans.commit", "action-plan"],
  ["reports.create", "success"],
  ["exports.selected", "raw"],
  ["admin.backup", "success"],
  ["admin.restore", "success"],
  ["admin.doctor", "doctor"],
  ["admin.reindex", "success"],
  ["sync.status", "sync-status"],
  ["sync.start", "registered-error-or-success"],
  ["sync.pause", "registered-error-or-success"],
  ["sync.resume", "registered-error-or-success"],
  ["sync.stop", "registered-error-or-success"],
]);

const expectedSelectorOperations = new Map([
  ["SELECTOR-ACTION-INSPECT", ["action-plans.inspect"]],
  ["SELECTOR-ACTION-COMMIT", ["action-plans.commit"]],
  ["SELECTOR-DOCTOR", ["admin.doctor"]],
  ["SELECTOR-SYNC-STATUS", ["sync.status"]],
  ["SELECTOR-ROUTING-COMMIT", ["routing.commit"]],
  ["SELECTOR-LABEL", ["messages.label"]],
  [
    "SELECTOR-DEFAULT",
    [
      "messages.search",
      "messages.get",
      "threads.get",
      "routing.preview",
      "action-plans.create",
      "action-plans.approve",
      "action-plans.cancel-approval",
      "reports.create",
      "admin.backup",
      "admin.restore",
      "admin.reindex",
      "sync.start",
      "sync.pause",
      "sync.resume",
      "sync.stop",
    ],
  ],
]);

const expectedSelectorRules = new Map([
  [
    "SELECTOR-ACTION-INSPECT",
    [
      "DOMAIN-REGISTERED-ERROR",
      "DOMAIN-ACTION-UNCERTAIN",
      "DOMAIN-ACTION-PARTIAL",
      "DOMAIN-ACTION-STALE",
      "DOMAIN-ACTION-EXPIRED",
      "DOMAIN-ACTION-CANCELLED",
      "DOMAIN-ACTION-INSPECT-PENDING",
      "DOMAIN-ACTION-INSPECT-COMPLETED",
      "DOMAIN-ACTION-ATTENTION",
    ],
  ],
  [
    "SELECTOR-ACTION-COMMIT",
    [
      "DOMAIN-REGISTERED-ERROR",
      "DOMAIN-ACTION-UNCERTAIN",
      "DOMAIN-ACTION-PARTIAL",
      "DOMAIN-ACTION-STALE",
      "DOMAIN-ACTION-EXPIRED",
      "DOMAIN-ACTION-COMMIT-COMPLETED",
      "DOMAIN-ACTION-ATTENTION",
    ],
  ],
  [
    "SELECTOR-DOCTOR",
    ["DOMAIN-REGISTERED-ERROR", "DOMAIN-DOCTOR-HEALTHY", "DOMAIN-DOCTOR-ATTENTION"],
  ],
  [
    "SELECTOR-SYNC-STATUS",
    ["DOMAIN-REGISTERED-ERROR", "DOMAIN-SYNC-AUTH-BLOCKED", "DOMAIN-SYNC-STATUS"],
  ],
  [
    "SELECTOR-ROUTING-COMMIT",
    ["DOMAIN-REGISTERED-ERROR", "DOMAIN-ROUTING-COMMITTED", "DOMAIN-ROUTING-DRY-RUN"],
  ],
  [
    "SELECTOR-LABEL",
    [
      "DOMAIN-REGISTERED-ERROR",
      "DOMAIN-LABEL-COMMITTED",
      "DOMAIN-LABEL-DRY-RUN",
      "DOMAIN-LABEL-UNCOMMITTED",
    ],
  ],
  ["SELECTOR-DEFAULT", ["DOMAIN-REGISTERED-ERROR", "DOMAIN-DEFAULT-SUCCESS"]],
]);

const expectedOperationRows = cliCommandDefinitions.map((command) => ({
  operationKey: command.operationKey,
  commandPath: command.path.join(" "),
  streaming: command.streaming,
  valuePolicy: expectedPolicies.get(command.operationKey),
}));
if (expectedOperationRows.some((row) => row.valuePolicy === undefined)) {
  fail("current command registry has an operation without a frozen value policy");
}

const sourceSharedRows = httpErrorRegistry.errors.map(({ code, status }) => ({ code, status }));
const sourceOperationApplicability = cliCommandDefinitions.flatMap(({ operationKey, operation }) =>
  operation.errors.map(({ code, status }) => ({ operationKey, code, status })),
);
const sourceOperationCodes = [
  ...new Map(
    sourceOperationApplicability.map(({ code, status }) => [code, { code, status }]),
  ).values(),
];

function parseClientKinds(source) {
  const match = source.match(/export type CliClientErrorKind =([\s\S]*?);/u);
  if (match === null) fail("accepted CliClientErrorKind union is unreadable");
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

function validateCore(oracle, acceptedClientKinds) {
  exactSet(
    new Set(Object.keys(oracle)),
    new Set([
      "adjacentCounterexamples",
      "cliClientErrorMatrix",
      "commandResultAlgebra",
      "coverage",
      "decisions",
      "domainFixtureBases",
      "domainFixtures",
      "domainOutcomeRules",
      "domainProjectionFixtures",
      "domainRuleDsl",
      "domainSelectors",
      "examples",
      "executionProtocol",
      "exitCodeRegistry",
      "extensionMechanism",
      "format",
      "frozenInputs",
      "implementationObligations",
      "issueEvidence",
      "limits",
      "localDetailSchemas",
      "localErrorRegistry",
      "modeCompatibility",
      "modeResolution",
      "modelVersion",
      "operationErrorApplicability",
      "operationErrorMappings",
      "operationMatrix",
      "oracle",
      "outputDispositionMatrix",
      "outputPolicy",
      "planningShieldApplicability",
      "primaryStandards",
      "properties",
      "publicStatusMatrix",
      "requirements",
      "reservedProcessStatuses",
      "runtimeFailureMatrix",
      "safetyPolicy",
      "schemaVersion",
      "sharedErrorMatrix",
      "signalMatrix",
      "status",
      "structuredSchemas",
      "terminology",
      "typescriptTypes",
    ]),
    "oracle top-level keys",
  );
  if (
    oracle.format !== "agent-mail.cli-command-outcome-oracle/v1" ||
    oracle.schemaVersion !== 1 ||
    oracle.modelVersion !== "1.0.0" ||
    oracle.status !== "frozen-design"
  ) {
    fail("unsupported oracle format, version, or status");
  }
  if (oracle.oracle?.normative !== true || oracle.oracle?.acceptedHead !== ACCEPTED_HEAD) {
    fail("oracle authority or accepted HEAD drifted");
  }
  exactSet(
    unique(oracle.frozenInputs, (row) => row.id, "frozen inputs"),
    new Set([
      "PLAN",
      "EVIDENCE",
      "CONTEXT",
      "CLI-CLIENT",
      "CLI-OUTPUT-CONTEXT",
      "CLI-COMMAND-REGISTRY",
      "ERROR-ENVELOPE",
      "HTTP-ERROR-AUTHORITY",
      "ACTION-AUTHORITY",
      "OPERATION-REGISTRY",
      "ACTION-OPERATIONS",
      "REPORT-ADMIN-OPERATIONS",
      "RETRIEVAL-OPERATIONS",
      "ROUTING-OPERATIONS",
      "SYNC-OPERATIONS",
      "THREAD-ORACLE",
      "PARITY-HARNESS",
    ]),
    "frozen input inventory",
  );
  unique(oracle.frozenInputs, (row) => row.path, "frozen input paths");

  const requirementIds = unique(oracle.requirements, (row) => row.id, "requirements");
  const decisionIds = unique(oracle.decisions, (row) => row.id, "decisions");
  const exampleIds = unique(oracle.examples, (row) => row.id, "examples");
  const propertyIds = unique(oracle.properties, (row) => row.id, "properties");
  const obligationIds = unique(
    oracle.implementationObligations,
    (row) => row.id,
    "implementation obligations",
  );
  const counterexampleIds = unique(
    oracle.adjacentCounterexamples,
    (row) => row.id,
    "adjacent counterexamples",
  );
  const expectedCounts = {
    requirements: 11,
    decisions: 19,
    examples: 19,
    properties: 10,
    obligations: 27,
    counterexamples: 12,
  };
  exactValue(
    {
      requirements: requirementIds.size,
      decisions: decisionIds.size,
      examples: exampleIds.size,
      properties: propertyIds.size,
      obligations: obligationIds.size,
      counterexamples: counterexampleIds.size,
    },
    expectedCounts,
    "constructive inventory counts",
  );

  exactSet(new Set(Object.keys(oracle.coverage)), requirementIds, "requirement coverage");
  for (const [requirementId, coverage] of Object.entries(oracle.coverage)) {
    requireReferences(coverage.decisions, decisionIds, requirementId + ".decisions");
    requireReferences(coverage.examples, exampleIds, requirementId + ".examples");
    requireReferences(coverage.properties, propertyIds, requirementId + ".properties");
    requireReferences(coverage.obligations, obligationIds, requirementId + ".obligations");
  }
  for (const [label, authority, references] of [
    [
      "decision",
      decisionIds,
      new Set(Object.values(oracle.coverage).flatMap((row) => row.decisions)),
    ],
    ["example", exampleIds, new Set(Object.values(oracle.coverage).flatMap((row) => row.examples))],
    [
      "property",
      propertyIds,
      new Set(Object.values(oracle.coverage).flatMap((row) => row.properties)),
    ],
    [
      "implementation obligation",
      obligationIds,
      new Set(Object.values(oracle.coverage).flatMap((row) => row.obligations)),
    ],
  ]) {
    for (const id of authority)
      if (!references.has(id)) fail(JSON.stringify(label) + " " + id + " has no coverage");
  }

  exactRows(
    oracle.exitCodeRegistry.map(({ semanticKind, symbol, code, class: className }) => ({
      semanticKind,
      symbol,
      code,
      class: className,
    })),
    expectedExits,
    "exit registry",
  );
  unique(oracle.exitCodeRegistry, (row) => row.semanticKind, "exit semantic kinds");
  const exitNumbers = oracle.exitCodeRegistry.map((row) => row.code);
  if (new Set(exitNumbers).size !== exitNumbers.length) fail("exit registry has duplicate numbers");
  if (exitNumbers.some((code) => !Number.isInteger(code) || code < 0 || code > 88)) {
    fail("normal exit is outside 0..88");
  }
  const semanticKinds = new Set(oracle.exitCodeRegistry.map((row) => row.semanticKind));
  const schemaRegistry = buildSchemaRegistry(oracle);

  exactRows(oracle.localErrorRegistry, expectedLocalErrors, "local error registry");
  const localCodes = unique(oracle.localErrorRegistry, (row) => row.code, "local errors");
  const localDetailIds = unique(oracle.localDetailSchemas, (row) => row.id, "local detail schemas");
  exactSet(
    new Set(oracle.localDetailSchemas.map((row) => row.code)),
    localCodes,
    "local detail schema codes",
  );
  exactSet(
    new Set(oracle.localErrorRegistry.map((row) => row.detailSchemaId)),
    localDetailIds,
    "local detail schema references",
  );
  if (oracle.localDetailSchemas.length !== 13) fail("local detail schema count differs");

  const localDetailById = new Map(oracle.localDetailSchemas.map((row) => [row.id, row]));
  for (const row of oracle.localErrorRegistry) {
    if (!semanticKinds.has(row.semanticKind)) fail("local error has unregistered semantic kind");
    const detailAuthority = localDetailById.get(row.detailSchemaId);
    if (detailAuthority === undefined || detailAuthority.code !== row.code) {
      fail(row.code + " has the wrong detail schema pairing");
    }
    const schema = detailAuthority.schema;
    if (
      schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
      schema.$id !== "agent-mail://cli-local-detail/" + row.code + "/v1" ||
      schema.type !== "object" ||
      schema.additionalProperties !== false
    ) {
      fail(row.code + " detail schema is not a strict draft-2020-12 object");
    }
    exactSet(
      new Set(schema.required),
      new Set(Object.keys(schema.properties)),
      row.code + " fields",
    );
    requireSchemaAccepts(row.validDetails, schema, schemaRegistry, row.code + " valid details");
  }

  exactValue(
    oracle.structuredSchemas.errorEnvelopeV1.oneOf,
    [
      { $ref: "agent-mail://cli-local-error-envelope/v1" },
      { $ref: "agent-mail://registered-server-error-envelope/v1" },
    ],
    "ErrorEnvelopeV1 branches",
  );
  const localEnvelopeSchema = oracle.structuredSchemas.localErrorEnvelopeV1;
  if (localEnvelopeSchema.oneOf.length !== 13) fail("local envelope branch count differs");
  const localEnvelopeBranches = new Map();
  for (const branch of localEnvelopeSchema.oneOf) {
    const code = branch.properties?.code?.const;
    if (typeof code !== "string" || localEnvelopeBranches.has(code)) {
      fail("local envelope branch code is absent or duplicated");
    }
    exactSet(
      new Set(Object.keys(branch)),
      new Set(["type", "additionalProperties", "required", "properties"]),
      code + " envelope branch keys",
    );
    exactSet(
      new Set(branch.required),
      new Set(["code", "message", "correlationId", "details"]),
      code + " envelope required fields",
    );
    exactSet(
      new Set(Object.keys(branch.properties)),
      new Set(["code", "message", "correlationId", "details"]),
      code + " envelope properties",
    );
    if (branch.type !== "object" || branch.additionalProperties !== false) {
      fail(code + " envelope branch is not strict");
    }
    localEnvelopeBranches.set(code, branch);
  }
  exactSet(new Set(localEnvelopeBranches.keys()), localCodes, "local envelope branch codes");

  let localEnvelopeProbes = 0;
  for (const [index, row] of oracle.localErrorRegistry.entries()) {
    const branch = localEnvelopeBranches.get(row.code);
    const detailSchema = localDetailById.get(row.detailSchemaId).schema;
    if (
      branch.properties.message.const !== row.message ||
      branch.properties.details.$ref !== detailSchema.$id ||
      branch.properties.correlationId.$ref !== "agent-mail://safe-correlation-id/v1"
    ) {
      fail(row.code + " code/message/detail branch pairing differs");
    }
    const envelope = {
      code: row.code,
      message: row.message,
      correlationId: "corr-local-" + index,
      details: structuredClone(row.validDetails),
    };
    requireSchemaAccepts(
      envelope,
      localEnvelopeSchema,
      schemaRegistry,
      row.code + " local envelope",
    );
    localEnvelopeProbes += 1;
    requireSchemaAccepts(
      envelope,
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " generic envelope",
    );
    localEnvelopeProbes += 1;

    const wrongMessage = structuredClone(envelope);
    wrongMessage.message = "wrong fixed message";
    requireSchemaRejects(
      wrongMessage,
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " wrong message",
    );
    localEnvelopeProbes += 1;

    const wrongCode = structuredClone(envelope);
    wrongCode.code = oracle.localErrorRegistry[(index + 1) % oracle.localErrorRegistry.length].code;
    requireSchemaRejects(
      wrongCode,
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " wrong code pairing",
    );
    localEnvelopeProbes += 1;

    requireSchemaRejects(
      { ...envelope, stack: "forbidden" },
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " extra envelope key",
    );
    localEnvelopeProbes += 1;
    requireSchemaRejects(
      { ...envelope, details: { ...envelope.details, token: "forbidden" } },
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " dangerous detail key",
    );
    localEnvelopeProbes += 1;
    requireSchemaRejects(
      { ...envelope, details: { ...envelope.details, recursive: { recursive: {} } } },
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " recursive detail",
    );
    localEnvelopeProbes += 1;

    const missingDetails = structuredClone(envelope.details);
    delete missingDetails[detailSchema.required[0]];
    requireSchemaRejects(
      { ...envelope, details: missingDetails },
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " missing required detail",
    );
    localEnvelopeProbes += 1;

    const boundedField = Object.entries(detailSchema.properties).find(
      ([, property]) => property.maxLength !== undefined,
    );
    if (boundedField === undefined) fail(row.code + " has no bounded detail string field");
    const overlongDetails = structuredClone(envelope.details);
    overlongDetails[boundedField[0]] = "x".repeat(boundedField[1].maxLength + 1);
    requireSchemaRejects(
      { ...envelope, details: overlongDetails },
      oracle.structuredSchemas.errorEnvelopeV1,
      schemaRegistry,
      row.code + " overlong detail",
    );
    localEnvelopeProbes += 1;
  }

  const correlationProbe = {
    code: oracle.localErrorRegistry[0].code,
    message: oracle.localErrorRegistry[0].message,
    correlationId: "",
    details: oracle.localErrorRegistry[0].validDetails,
  };
  requireSchemaRejects(
    correlationProbe,
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "empty local correlation",
  );
  localEnvelopeProbes += 1;
  correlationProbe.correlationId = "x".repeat(201);
  requireSchemaRejects(
    correlationProbe,
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "overlong local correlation",
  );
  localEnvelopeProbes += 1;
  correlationProbe.correlationId = "line\nbreak";
  requireSchemaRejects(
    correlationProbe,
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "control local correlation",
  );
  localEnvelopeProbes += 1;

  const partialRow = oracle.localErrorRegistry.find((row) => row.code === "cli.partial-output");
  const invalidPartial = {
    code: partialRow.code,
    message: partialRow.message,
    correlationId: "corr-partial",
    details: { ...partialRow.validDetails, stdoutBytesAccepted: -1 },
  };
  requireSchemaRejects(
    invalidPartial,
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "negative partial output count",
  );
  localEnvelopeProbes += 1;

  const registeredServerCodes = new Set([
    ...expectedSharedMappings.map((row) => row.code),
    ...expectedOperationMappings.map((row) => row.code),
  ]);
  exactSet(
    new Set(oracle.structuredSchemas.registeredServerErrorEnvelopeV1.properties.code.enum),
    registeredServerCodes,
    "registered server envelope codes",
  );
  const serverEnvelope = {
    code: "not_found",
    message: "requested identity is absent",
    correlationId: "corr-server",
    details: { reason: "absent", retryable: false, evidence: ["validated", 1, null] },
  };
  requireSchemaAccepts(
    serverEnvelope,
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "registered server envelope",
  );
  localEnvelopeProbes += 1;
  requireSchemaRejects(
    { ...serverEnvelope, details: { nested: { token: "forbidden" } } },
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "nested dangerous server detail key",
  );
  localEnvelopeProbes += 1;
  requireSchemaRejects(
    { ...serverEnvelope, stack: "forbidden" },
    oracle.structuredSchemas.errorEnvelopeV1,
    schemaRegistry,
    "extra server envelope key",
  );
  localEnvelopeProbes += 1;

  exactRows(oracle.sharedErrorMatrix, expectedSharedMappings, "shared error mappings");
  unique(oracle.sharedErrorMatrix, (row) => row.code, "shared error mappings");
  exactRows(
    oracle.sharedErrorMatrix.map(({ code, status }) => ({ code, status })),
    sourceSharedRows,
    "shared error source reconstruction",
  );

  exactRows(oracle.cliClientErrorMatrix, expectedClientMappings, "client error mappings");
  unique(oracle.cliClientErrorMatrix, (row) => row.kind, "client error mappings");
  exactSet(
    new Set(oracle.cliClientErrorMatrix.map((row) => row.kind)),
    new Set(acceptedClientKinds),
    "accepted client error kinds",
  );

  exactRows(oracle.operationErrorMappings, expectedOperationMappings, "operation error mappings");
  unique(oracle.operationErrorMappings, (row) => row.code, "operation error mappings");
  exactRows(
    oracle.operationErrorMappings.map(({ code, status }) => ({ code, status })),
    sourceOperationCodes,
    "operation error code reconstruction",
  );
  exactRows(
    oracle.operationErrorApplicability,
    sourceOperationApplicability,
    "operation error applicability reconstruction",
  );
  unique(
    oracle.operationErrorApplicability,
    (row) => row.operationKey + "\u0000" + row.code,
    "operation error applicability",
  );

  exactRows(oracle.operationMatrix, expectedOperationRows, "operation matrix reconstruction");
  unique(oracle.operationMatrix, (row) => row.operationKey, "operation matrix");
  exactValue(
    oracle.modeCompatibility,
    [
      {
        resultKind: "value",
        operationStreaming: "none",
        allowedModes: ["json", "human"],
        mismatch: "cli.usage with reasonCode 'mode-not-supported' before client execution",
      },
      {
        resultKind: "raw",
        operationStreaming: "bytes",
        allowedModes: ["raw"],
        mismatch: "cli.usage with reasonCode 'mode-not-supported' before client execution",
      },
    ],
    "mode compatibility",
  );
  exactValue(
    oracle.modeResolution.defaultByOperationStreaming,
    { none: "human", bytes: "raw" },
    "default mode resolution",
  );
  if (
    !oracle.modeResolution.preCommandFailure.includes("human") ||
    !oracle.modeResolution.conflict.includes("output-context-conflict") ||
    !oracle.modeResolution.clientRule.includes("before configuration")
  ) {
    fail("mode resolution order is incomplete");
  }

  exactSet(
    new Set(oracle.publicStatusMatrix.map((row) => String(row.status))),
    new Set(["400", "401", "403", "404", "409", "413", "415", "429", "500", "503"]),
    "public status matrix",
  );
  exactValue(
    oracle.signalMatrix.map(({ event, signalNumber, processStatus, semanticKind }) => ({
      event,
      signalNumber,
      processStatus,
      semanticKind,
    })),
    [
      { event: "SIGINT", signalNumber: 2, processStatus: 130, semanticKind: "cancelled" },
      { event: "EPIPE", signalNumber: 13, processStatus: 141, semanticKind: "partial_output" },
      { event: "SIGTERM", signalNumber: 15, processStatus: 143, semanticKind: "cancelled" },
    ],
    "signal matrix",
  );
  const receiptSchema = oracle.structuredSchemas.executionReceiptV1;
  exactSet(
    new Set(receiptSchema.properties.semanticKind.enum),
    semanticKinds,
    "execution receipt semantic kinds",
  );
  exactSet(
    new Set(receiptSchema.properties.exitCode.enum.map(String)),
    new Set([...exitNumbers, 130, 141, 143].map(String)),
    "execution receipt status values",
  );
  if (
    receiptSchema.additionalProperties !== false ||
    receiptSchema.properties.stdoutBytesAccepted.maximum !== Number.MAX_SAFE_INTEGER ||
    receiptSchema.properties.stderrBytesAccepted.maximum !== Number.MAX_SAFE_INTEGER ||
    oracle.structuredSchemas.diagnosticV1.properties.correlationId.minLength !== 1
  ) {
    fail("structured receipt/diagnostic bounds drifted");
  }
  const expectedReceiptPairs = [
    ...oracle.exitCodeRegistry.map(({ semanticKind, code }) => ({ semanticKind, exitCode: code })),
    { semanticKind: "cancelled", exitCode: 130 },
    { semanticKind: "partial_output", exitCode: 141 },
    { semanticKind: "cancelled", exitCode: 143 },
  ];
  const receiptPairs = receiptSchema.oneOf.map((branch) => {
    exactSet(
      new Set(Object.keys(branch)),
      new Set(["properties", "required"]),
      "receipt pair branch keys",
    );
    exactSet(
      new Set(branch.required),
      new Set(["semanticKind", "exitCode"]),
      "receipt pair required fields",
    );
    exactSet(
      new Set(Object.keys(branch.properties)),
      new Set(["semanticKind", "exitCode"]),
      "receipt pair properties",
    );
    return {
      semanticKind: branch.properties.semanticKind.const,
      exitCode: branch.properties.exitCode.const,
    };
  });
  exactRows(receiptPairs, expectedReceiptPairs, "execution receipt exact pairs");
  unique(
    receiptPairs,
    (row) => row.semanticKind + "\u0000" + row.exitCode,
    "execution receipt pairs",
  );
  let receiptProbes = 0;
  for (const pair of expectedReceiptPairs) {
    requireSchemaAccepts(
      {
        version: 1,
        ...pair,
        stdoutBytesAccepted: 0,
        stderrBytesAccepted: 0,
        cleanupAwaited: true,
      },
      receiptSchema,
      schemaRegistry,
      "execution receipt " + pair.semanticKind + "/" + pair.exitCode,
    );
    receiptProbes += 1;
  }
  for (const mismatch of [
    { semanticKind: "success", exitCode: 88 },
    { semanticKind: "partial_output", exitCode: 0 },
    { semanticKind: "cancelled", exitCode: 141 },
    { semanticKind: "usage", exitCode: 130 },
  ]) {
    requireSchemaRejects(
      {
        version: 1,
        ...mismatch,
        stdoutBytesAccepted: 0,
        stderrBytesAccepted: 0,
        cleanupAwaited: true,
      },
      receiptSchema,
      schemaRegistry,
      "execution receipt mismatch " + mismatch.semanticKind + "/" + mismatch.exitCode,
    );
    receiptProbes += 1;
  }
  requireSchemaRejects(
    {
      version: 1,
      semanticKind: "success",
      exitCode: 0,
      stdoutBytesAccepted: -1,
      stderrBytesAccepted: 0,
      cleanupAwaited: true,
    },
    receiptSchema,
    schemaRegistry,
    "execution receipt negative byte count",
  );
  receiptProbes += 1;
  requireSchemaRejects(
    {
      version: 1,
      semanticKind: "success",
      exitCode: 0,
      stdoutBytesAccepted: 0,
      stderrBytesAccepted: 0,
      cleanupAwaited: true,
      extra: true,
    },
    receiptSchema,
    schemaRegistry,
    "execution receipt extra key",
  );
  receiptProbes += 1;
  exactValue(
    oracle.reservedProcessStatuses.neverEmit.map((row) => row.code),
    [124, 125, 126, 127],
    "reserved process statuses",
  );

  exactSet(
    new Set(oracle.commandResultAlgebra.variants.map((row) => row.kind)),
    new Set(["value", "raw", "failure"]),
    "command result variants",
  );
  for (const variant of oracle.commandResultAlgebra.variants) {
    for (const field of ["exitCode", "stdout", "stderr", "process", "stack", "cause"]) {
      if (!variant.forbiddenFields.includes(field)) {
        fail("result variant " + variant.kind + " permits " + field);
      }
    }
    for (const semanticKind of variant.allowedSemanticKinds) {
      if (!semanticKinds.has(semanticKind)) {
        fail("result variant " + variant.kind + " has unregistered " + semanticKind);
      }
    }
  }

  const domainIds = unique(oracle.domainOutcomeRules, (row) => row.id, "domain outcome rules");
  exactSet(
    domainIds,
    new Set([
      "DOMAIN-REGISTERED-ERROR",
      "DOMAIN-ACTION-UNCERTAIN",
      "DOMAIN-ACTION-PARTIAL",
      "DOMAIN-ACTION-STALE",
      "DOMAIN-ACTION-EXPIRED",
      "DOMAIN-ACTION-CANCELLED",
      "DOMAIN-ACTION-ATTENTION",
      "DOMAIN-ACTION-INSPECT-PENDING",
      "DOMAIN-ACTION-INSPECT-COMPLETED",
      "DOMAIN-ACTION-COMMIT-COMPLETED",
      "DOMAIN-DOCTOR-HEALTHY",
      "DOMAIN-DOCTOR-ATTENTION",
      "DOMAIN-SYNC-AUTH-BLOCKED",
      "DOMAIN-SYNC-STATUS",
      "DOMAIN-ROUTING-COMMITTED",
      "DOMAIN-ROUTING-DRY-RUN",
      "DOMAIN-LABEL-COMMITTED",
      "DOMAIN-LABEL-DRY-RUN",
      "DOMAIN-LABEL-UNCOMMITTED",
      "DOMAIN-DEFAULT-SUCCESS",
    ]),
    "domain outcome rules",
  );
  const dsl = oracle.domainRuleDsl;
  exactValue(
    {
      version: dsl.version,
      selection: dsl.selection,
      registeredErrorProjection: dsl.registeredErrorProjection,
      expressionOperators: dsl.expressionOperators,
      projectionOperators: dsl.projectionOperators,
      noMatch: dsl.noMatch,
      targetIdentity: dsl.targetIdentity,
    },
    {
      version: 1,
      selection: "first-match",
      registeredErrorProjection: {
        op: "input-path",
        path: ["registeredErrorSemanticKind"],
      },
      expressionOperators: ["const", "eq", "in", "all", "any", "not-null"],
      projectionOperators: [
        "path",
        "literal",
        "has-path",
        "union-discriminant",
        "array-empty",
        "array-any-eq",
        "array-any-not-eq",
        "array-mixed-eq",
        "array-all-eq-nonempty",
        "target-coverage",
      ],
      noMatch: { semanticKind: "protocol", localCode: "cli.protocol" },
      targetIdentity: {
        encoding: "json-array-v1",
        fields: ["accountId", "mailboxId", "uidValidity", "uid"],
        problemOrder: ["missing", "duplicate", "unexpected"],
        coverageValues: ["exact", "missing", "duplicate", "unexpected", "multiple-invalid"],
        classification: [
          { problems: [], value: "exact" },
          { problems: ["missing"], value: "missing" },
          { problems: ["duplicate"], value: "duplicate" },
          { problems: ["unexpected"], value: "unexpected" },
          { minimumProblemCount: 2, value: "multiple-invalid" },
        ],
      },
    },
    "domain DSL authority",
  );
  exactValue(
    dsl.factSchemas,
    {
      registeredErrorSemanticKind: {
        enum: [
          null,
          "invalid_input",
          "not_found",
          "unavailable",
          "internal",
          "temporary",
          "authorization",
          "conflict",
          "stale",
          "expired",
          "replay",
          "tampered",
          "cancelled",
        ],
      },
      planState: {
        enum: [
          "pending",
          "executing",
          "completed",
          "partial",
          "failed",
          "rejected",
          "expired",
          "uncertain",
          "restore-quarantined",
        ],
      },
      resultsEmpty: { type: "boolean" },
      anyUncertainResult: { type: "boolean" },
      mixedSuccessAndNonSuccess: { type: "boolean" },
      allResultsStale: { type: "boolean" },
      anyNonSuccessResult: { type: "boolean" },
      targetCoverage: {
        enum: ["exact", "missing", "duplicate", "unexpected", "multiple-invalid"],
      },
      approvalState: {
        enum: [
          "not-applicable",
          "absent",
          "available",
          "consumed",
          "expired",
          "cancelled",
          "invalidated",
        ],
      },
      terminalState: {
        enum: [
          "not-applicable",
          "absent",
          "completed",
          "partial",
          "failed",
          "rejected",
          "expired",
          "uncertain",
          "restore-quarantined",
        ],
      },
      executorDisposition: {
        enum: [
          "not-applicable",
          "absent",
          "started",
          "never-started-after-restore",
          "unknown-after-restore",
        ],
      },
      hasConsumptionReceipt: { type: "boolean" },
      doctorStatus: { enum: ["healthy", "degraded", "unhealthy"] },
      syncActorState: {
        enum: [
          "stopped",
          "starting",
          "backfilling",
          "watching",
          "sweeping",
          "retrying",
          "authBlocked",
          "paused",
          "stopping",
        ],
      },
      committed: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    "domain fact schemas",
  );
  exactSet(
    new Set(dsl.factSchemas.registeredErrorSemanticKind.enum.filter((value) => value !== null)),
    new Set([
      ...expectedSharedMappings.map((row) => row.semanticKind),
      ...expectedOperationMappings.flatMap((row) =>
        row.semanticKind === undefined ? Object.values(row.cases) : [row.semanticKind],
      ),
    ]),
    "registered error semantic projection",
  );
  exactValue(
    [
      dsl.expressionSchema.$id,
      dsl.outcomeSchema.$id,
      dsl.projectionSchema.$id,
      dsl.ruleSchema.$id,
      dsl.selectorSchema.$id,
    ],
    [
      "agent-mail://cli-domain-expression/v1",
      "agent-mail://cli-domain-outcome/v1",
      "agent-mail://cli-domain-projection/v1",
      "agent-mail://cli-domain-rule/v1",
      "agent-mail://cli-domain-selector/v1",
    ],
    "domain schema IDs",
  );
  exactValue(
    [
      dsl.expressionSchema.oneOf.length,
      dsl.outcomeSchema.oneOf.length,
      dsl.projectionSchema.oneOf.length,
    ],
    [5, 2, 5],
    "domain schema variant counts",
  );

  const rulesById = new Map(oracle.domainOutcomeRules.map((row) => [row.id, row]));
  for (const rule of oracle.domainOutcomeRules) {
    exactSet(new Set(Object.keys(rule)), new Set(["id", "when", "outcome"]), rule.id + " keys");
    requireSchemaAccepts(rule, dsl.ruleSchema, schemaRegistry, rule.id + " rule schema");
    validateExpressionValues(rule.when, dsl.factSchemas, schemaRegistry, rule.id);
    if (rule.outcome.kind === "constant" && !semanticKinds.has(rule.outcome.semanticKind)) {
      fail(rule.id + " has an unregistered constant semantic kind");
    }
  }

  const selectorIds = unique(oracle.domainSelectors, (row) => row.id, "domain selectors");
  exactSet(selectorIds, new Set(expectedSelectorOperations.keys()), "domain selector IDs");
  const selectorById = new Map(oracle.domainSelectors.map((row) => [row.id, row]));
  const selectorOperationRows = [];
  const referencedRuleIds = new Set();
  for (const selector of oracle.domainSelectors) {
    requireSchemaAccepts(
      selector,
      dsl.selectorSchema,
      schemaRegistry,
      selector.id + " selector schema",
    );
    exactValue(
      selector.operations,
      expectedSelectorOperations.get(selector.id),
      selector.id + " operations",
    );
    exactValue(
      selector.ruleOrder,
      expectedSelectorRules.get(selector.id),
      selector.id + " rule order",
    );
    if (selector.ruleOrder[0] !== "DOMAIN-REGISTERED-ERROR") {
      fail(selector.id + " does not give registered errors first precedence");
    }
    for (const ruleId of selector.ruleOrder) {
      if (!domainIds.has(ruleId)) fail(selector.id + " references unknown rule " + ruleId);
      referencedRuleIds.add(ruleId);
    }
    const usedFacts = new Set();
    for (const ruleId of selector.ruleOrder) {
      collectExpressionFacts(rulesById.get(ruleId).when, usedFacts);
    }
    usedFacts.delete("registeredErrorSemanticKind");
    exactSet(
      new Set(Object.keys(selector.factProjection)),
      usedFacts,
      selector.id + " projected facts",
    );
    for (const [fact, projection] of Object.entries(selector.factProjection)) {
      if (dsl.factSchemas[fact] === undefined) fail(selector.id + " projects unknown fact " + fact);
      requireSchemaAccepts(
        projection,
        dsl.projectionSchema,
        schemaRegistry,
        selector.id + "." + fact + " projection",
      );
    }
    for (const operationKey of selector.operations) {
      selectorOperationRows.push({ operationKey, selectorId: selector.id });
    }
  }
  exactSet(referencedRuleIds, domainIds, "selector rule reachability");
  unique(selectorOperationRows, (row) => row.operationKey, "domain selector operations");
  exactSet(
    new Set(selectorOperationRows.map((row) => row.operationKey)),
    new Set(
      oracle.operationMatrix
        .filter((row) => row.streaming === "none")
        .map((row) => row.operationKey),
    ),
    "value operation selector assignment",
  );
  exactSet(
    new Set(
      oracle.operationMatrix
        .filter((row) => row.streaming === "bytes")
        .map((row) => row.operationKey),
    ),
    new Set(["messages.raw", "attachments.get", "exports.selected"]),
    "raw operation selector exclusion",
  );

  const fixtureBaseIds = unique(oracle.domainFixtureBases, (row) => row.id, "domain fixture bases");
  exactValue(oracle.domainFixtureBases.length, 8, "domain fixture base count");
  const fixtureBaseById = new Map(oracle.domainFixtureBases.map((row) => [row.id, row]));
  for (const base of oracle.domainFixtureBases) {
    exactSet(
      new Set(Object.keys(base)),
      new Set(["id", "selectorId", "operationKey", "facts"]),
      base.id + " keys",
    );
    const selector = selectorById.get(base.selectorId);
    if (selector === undefined || !selector.operations.includes(base.operationKey)) {
      fail(base.id + " does not match its selector operation");
    }
    exactSet(
      new Set(Object.keys(base.facts)),
      new Set(["registeredErrorSemanticKind", ...Object.keys(selector.factProjection)]),
      base.id + " fact inventory",
    );
    for (const [fact, value] of Object.entries(base.facts)) {
      requireSchemaAccepts(value, dsl.factSchemas[fact], schemaRegistry, base.id + "." + fact);
    }
  }

  unique(oracle.domainFixtures, (row) => row.id, "domain fixtures");
  exactValue(oracle.domainFixtures.length, 62, "domain fixture count");
  const exitBySemanticKind = new Map(
    oracle.exitCodeRegistry.map((row) => [row.semanticKind, row.code]),
  );
  const reachedRules = new Set();
  const reachedSelectors = new Set();
  const observedFactValues = new Map();
  const fixtureTags = new Set();
  for (const fixture of oracle.domainFixtures) {
    exactSet(
      new Set(Object.keys(fixture)),
      new Set([
        "id",
        "baseId",
        "factOverrides",
        "expectedRuleId",
        "expectedSemanticKind",
        "expectedExitCode",
        "expectedLocalCode",
        ...(fixture.tags === undefined ? [] : ["tags"]),
      ]),
      fixture.id + " keys",
    );
    if (!fixtureBaseIds.has(fixture.baseId)) fail(fixture.id + " references unknown base");
    const base = fixtureBaseById.get(fixture.baseId);
    const selector = selectorById.get(base.selectorId);
    for (const [fact, value] of Object.entries(fixture.factOverrides)) {
      if (!Object.hasOwn(base.facts, fact)) fail(fixture.id + " overrides unknown fact " + fact);
      requireSchemaAccepts(value, dsl.factSchemas[fact], schemaRegistry, fixture.id + "." + fact);
    }
    const facts = { ...base.facts, ...fixture.factOverrides };
    for (const [fact, value] of Object.entries(facts)) {
      const values = observedFactValues.get(fact) ?? new Set();
      values.add(stable(value));
      observedFactValues.set(fact, values);
    }
    const actual = selectDomainOutcome(facts, selector, rulesById, dsl);
    exactValue(
      actual,
      {
        ruleId: fixture.expectedRuleId,
        semanticKind: fixture.expectedSemanticKind,
        localCode: fixture.expectedLocalCode,
      },
      fixture.id + " selected outcome",
    );
    if (fixture.expectedExitCode !== exitBySemanticKind.get(fixture.expectedSemanticKind)) {
      fail(fixture.id + " expected exit does not match the central registry");
    }
    if (fixture.expectedRuleId !== null) reachedRules.add(fixture.expectedRuleId);
    reachedSelectors.add(base.selectorId);
    for (const tag of fixture.tags ?? []) fixtureTags.add(tag);
  }
  exactSet(reachedRules, domainIds, "constructively reached domain rules");
  exactSet(reachedSelectors, selectorIds, "constructively reached selectors");
  exactSet(
    fixtureTags,
    new Set([
      "registered-error-precedence",
      "uncertain-over-partial",
      "partial-over-stale",
      "stale-over-expired",
      "expired-over-cancelled",
      "missing-target",
      "duplicate-target",
      "unexpected-target",
      "multiple-invalid-targets",
      "no-match",
      "default",
    ]),
    "domain fixture tags",
  );

  let registeredPrecedenceProbes = 0;
  const registeredSemantics = dsl.factSchemas.registeredErrorSemanticKind.enum.filter(
    (value) => value !== null,
  );
  for (const selector of oracle.domainSelectors) {
    const base = oracle.domainFixtureBases.find((row) => row.selectorId === selector.id);
    if (base === undefined) fail(selector.id + " lacks a fixture base");
    for (const semanticKind of registeredSemantics) {
      const actual = selectDomainOutcome(
        { ...base.facts, registeredErrorSemanticKind: semanticKind },
        selector,
        rulesById,
        dsl,
      );
      exactValue(
        actual,
        { ruleId: "DOMAIN-REGISTERED-ERROR", semanticKind, localCode: null },
        selector.id + " registered precedence for " + semanticKind,
      );
      registeredPrecedenceProbes += 1;
    }
  }

  for (const [fact, schema] of Object.entries(dsl.factSchemas)) {
    if (fact === "registeredErrorSemanticKind") continue;
    const expectedValues = schema.enum ?? (schema.type === "boolean" ? [false, true] : []);
    exactSet(
      observedFactValues.get(fact) ?? new Set(),
      new Set(expectedValues.map(stable)),
      fact + " constructive values",
    );
  }

  unique(oracle.domainProjectionFixtures, (row) => row.id, "domain projection fixtures");
  exactValue(oracle.domainProjectionFixtures.length, 16, "domain projection fixture count");
  const projectedSelectors = new Set();
  const projectedResultKinds = new Set();
  const projectedTargetCoverage = new Set();
  const projectedOperatorValues = new Map();
  for (const fixture of oracle.domainProjectionFixtures) {
    exactSet(
      new Set(Object.keys(fixture)),
      new Set(["id", "selectorId", "operationKey", "input", "expectedFacts"]),
      fixture.id + " keys",
    );
    const selector = selectorById.get(fixture.selectorId);
    if (selector === undefined || !selector.operations.includes(fixture.operationKey)) {
      fail(fixture.id + " does not match its selector operation");
    }
    const projected = projectDomainFacts(fixture.input, selector, dsl);
    exactValue(projected, fixture.expectedFacts, fixture.id + " projected facts");
    exactSet(
      new Set(Object.keys(projected)),
      new Set(["registeredErrorSemanticKind", ...Object.keys(selector.factProjection)]),
      fixture.id + " projected fact inventory",
    );
    for (const [fact, value] of Object.entries(projected)) {
      requireSchemaAccepts(value, dsl.factSchemas[fact], schemaRegistry, fixture.id + "." + fact);
    }
    for (const [fact, projection] of Object.entries(selector.factProjection)) {
      const values = projectedOperatorValues.get(projection.op) ?? new Set();
      values.add(stable(projected[fact]));
      projectedOperatorValues.set(projection.op, values);
    }
    selectDomainOutcome(projected, selector, rulesById, dsl);
    projectedSelectors.add(selector.id);
    if (typeof projected.targetCoverage === "string") {
      projectedTargetCoverage.add(projected.targetCoverage);
    }
    for (const result of fixture.input.results ?? []) projectedResultKinds.add(result.kind);
  }
  exactSet(projectedSelectors, selectorIds, "projected selectors");
  exactSet(
    projectedTargetCoverage,
    new Set(dsl.targetIdentity.coverageValues),
    "projected target coverage values",
  );
  exactSet(
    projectedResultKinds,
    new Set(["success", "stale", "rejected", "failed", "uncertain"]),
    "projected action result kinds",
  );
  exactSet(
    new Set(projectedOperatorValues.keys()),
    new Set(dsl.projectionOperators),
    "constructively exercised projection operators",
  );
  for (const operator of [
    "has-path",
    "array-empty",
    "array-any-eq",
    "array-any-not-eq",
    "array-mixed-eq",
    "array-all-eq-nonempty",
  ]) {
    exactSet(
      projectedOperatorValues.get(operator) ?? new Set(),
      new Set([stable(false), stable(true)]),
      operator + " constructive branches",
    );
  }

  exactSet(
    unique(oracle.outputDispositionMatrix, (row) => row.id, "output dispositions"),
    new Set([
      "OUT-JSON-VALUE",
      "OUT-JSON-FAILURE",
      "OUT-HUMAN-VALUE",
      "OUT-HUMAN-FAILURE",
      "OUT-RAW-STREAM",
      "OUT-RAW-PREFAIL",
      "OUT-RAW-PARTIAL",
      "OUT-EPIPE",
      "OUT-SIGNAL",
    ]),
    "output disposition rows",
  );
  exactSet(
    unique(oracle.runtimeFailureMatrix, (row) => row.id, "runtime failure rows"),
    new Set([
      "RUN-PRE-SINK-IO",
      "RUN-POST-SINK-IO",
      "RUN-EPIPE-ZERO",
      "RUN-EPIPE-PARTIAL",
      "RUN-STREAM-FAIL-ZERO",
      "RUN-STREAM-FAIL-PARTIAL",
      "RUN-CALLER-ABORT-ZERO",
      "RUN-CALLER-ABORT-PARTIAL",
      "RUN-SIGINT",
      "RUN-SIGTERM",
      "RUN-RENDER-FAIL",
      "RUN-CLEANUP-FAIL-ZERO",
      "RUN-CLEANUP-FAIL-PARTIAL",
      "RUN-DIAGNOSTIC-FAIL-ZERO",
      "RUN-DIAGNOSTIC-FAIL-PARTIAL",
    ]),
    "runtime failure rows",
  );
  exactSet(
    new Set(oracle.executionProtocol.states.map((row) => row.id)),
    new Set([
      "validating",
      "rendering",
      "emitting",
      "cancelling",
      "cleaning",
      "reporting",
      "settled",
    ]),
    "emission states",
  );
  if (
    !oracle.executionProtocol.receiptRule.includes("cancelled with 130 or 143") ||
    !oracle.executionProtocol.receiptRule.includes("partial_output with 141") ||
    !oracle.executionProtocol.cleanupReceiptRule.includes("must settle cleanup before any receipt")
  ) {
    fail("execution receipt/cleanup rule is incomplete");
  }

  exactSet(
    new Set(oracle.planningShieldApplicability.map((row) => row.id)),
    new Set(Array.from({ length: 12 }, (_, index) => "S" + String(index + 1).padStart(2, "0"))),
    "planning shield applicability",
  );
  exactSet(
    new Set(oracle.implementationObligations.map((row) => String(row.issue))),
    new Set([
      "156",
      "157",
      "158",
      "159",
      "160",
      "161",
      "162",
      "163",
      "164",
      "165",
      "166",
      "169",
      "176",
      "178",
      "183",
      "184",
      "185",
      "186",
      "191",
      "192",
      "193",
      "194",
      "195",
      "214",
    ]),
    "downstream issue owners",
  );
  const routingObligation = oracle.implementationObligations.find((row) => row.id === "I156-01");
  if (
    routingObligation === undefined ||
    !routingObligation.must.includes("no strict replay/expiry/tamper public discriminants") ||
    !routingObligation.must.includes("instead of parsing")
  ) {
    fail("routing discriminant gap is not explicit");
  }

  exactValue(
    oracle.primaryStandards.map(({ id, url }) => ({ id, url })),
    [
      {
        id: "POSIX-SHELL-2024",
        url: "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html",
      },
      {
        id: "APPLE-SYSEXITS",
        url: "https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/sysexits.3.html",
      },
      {
        id: "APPLE-EXIT",
        url: "https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/exit.3.html",
      },
      {
        id: "APPLE-SIGACTION",
        url: "https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/sigaction.2.html",
      },
    ],
    "primary standards",
  );

  return {
    requirementIds,
    decisionIds,
    exampleIds,
    propertyIds,
    obligationIds,
    counterexampleIds,
    domainIds,
    localEnvelopeProbes,
    receiptProbes,
    registeredPrecedenceProbes,
  };
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
if (oracleDigest !== EXPECTED_ORACLE_SHA256) {
  fail("oracle digest " + oracleDigest + " != " + EXPECTED_ORACLE_SHA256);
}
const oracle = JSON.parse(oracleBytes.toString("utf8"));

const frozenBytes = new Map();
const downstreamWorktreeDrift = [];
for (const input of oracle.frozenInputs) {
  if (input.gitCommit !== ACCEPTED_HEAD) fail(input.id + " does not pin accepted HEAD");
  const bytes = readCommitted(input.path, input.gitCommit);
  const digest = sha256(bytes);
  if (digest !== input.sha256) fail(input.id + " digest " + digest + " != " + input.sha256);
  frozenBytes.set(input.id, bytes);
  try {
    const worktreeDigest = sha256(readFileSync(join(repositoryRoot, input.path)));
    if (worktreeDigest !== digest) {
      downstreamWorktreeDrift.push({
        id: input.id,
        authoritySha256: digest,
        worktreeSha256: worktreeDigest,
      });
    }
  } catch {
    downstreamWorktreeDrift.push({
      id: input.id,
      authoritySha256: digest,
      worktreeSha256: null,
    });
  }
}
const acceptedClientKinds = parseClientKinds(frozenBytes.get("CLI-CLIENT").toString("utf8"));
const inventories = validateCore(oracle, acceptedClientKinds);

const viewBytes = viewPaths.map((path) => readFileSync(path));
for (const [index, bytes] of viewBytes.entries()) {
  const digest = sha256(bytes);
  if (digest !== EXPECTED_VIEW_SHA256[index]) {
    fail("view " + (index + 1) + " digest " + digest + " != " + EXPECTED_VIEW_SHA256[index]);
  }
}
const viewTexts = viewBytes.map((bytes) => bytes.toString("utf8"));
for (const [index, text] of viewTexts.entries()) {
  if (!text.includes(EXPECTED_ORACLE_SHA256)) fail("view " + (index + 1) + " omits oracle digest");
  if (!text.includes("cli-command-outcome-oracle.v1.json")) {
    fail("view " + (index + 1) + " omits normative oracle link");
  }
}
for (const id of inventories.decisionIds) {
  if (!viewTexts[1].includes(id)) fail("decision view omits " + id);
}
for (const id of [
  ...inventories.requirementIds,
  ...inventories.propertyIds,
  ...inventories.obligationIds,
  ...inventories.counterexampleIds,
]) {
  if (!viewTexts[2].includes(id)) fail("coverage view omits " + id);
}
for (const row of [
  ...oracle.exitCodeRegistry,
  ...oracle.localErrorRegistry,
  ...oracle.sharedErrorMatrix,
  ...oracle.cliClientErrorMatrix,
  ...oracle.operationErrorMappings,
  ...oracle.operationMatrix,
]) {
  const value = row.semanticKind ?? row.code ?? row.kind ?? row.operationKey;
  if (!viewTexts[2].includes(String(value))) fail("coverage view omits matrix value " + value);
}
for (const row of oracle.localErrorRegistry) {
  for (const value of [row.code, row.message, row.detailSchemaId]) {
    if (!viewTexts[2].includes(value)) fail("coverage view omits local authority " + value);
  }
}
for (const id of [...inventories.domainIds, ...oracle.domainSelectors.map((row) => row.id)]) {
  if (!viewTexts[2].includes(id)) fail("coverage view omits domain authority " + id);
}
if (!viewTexts[0].includes("specified, not implemented")) {
  fail("design view does not distinguish design from implementation");
}
if (!viewTexts[2].includes("No unresolved #213 policy choices.")) {
  fail("coverage view does not close #213 choices");
}

let selfTests = 0;
if (process.argv.includes("--self-test")) {
  function rejected(name, mutate) {
    const fixture = structuredClone(oracle);
    mutate(fixture);
    try {
      validateCore(fixture, acceptedClientKinds);
    } catch {
      selfTests += 1;
      return;
    }
    fail("self-test did not reject " + name);
  }
  rejected("duplicate shared row", (value) =>
    value.sharedErrorMatrix.push(value.sharedErrorMatrix[0]),
  );
  rejected("missing shared row", (value) => value.sharedErrorMatrix.pop());
  rejected("bad client semantic", (value) => {
    value.cliClientErrorMatrix[0].semanticKind = "invented";
  });
  rejected("duplicate exit number", (value) => {
    value.exitCodeRegistry[1].code = 0;
  });
  rejected("missing operation applicability", (value) => value.operationErrorApplicability.pop());
  rejected("missing operation", (value) => value.operationMatrix.pop());
  rejected("missing output disposition", (value) => value.outputDispositionMatrix.pop());
  rejected("bad signal status", (value) => {
    value.signalMatrix[0].processStatus = 1;
  });
  rejected("bad receipt status", (value) => {
    value.structuredSchemas.executionReceiptV1.properties.exitCode.enum.push(255);
  });
  rejected("missing receipt pair", (value) => {
    value.structuredSchemas.executionReceiptV1.oneOf.pop();
  });
  rejected("added receipt cross-product", (value) => {
    value.structuredSchemas.executionReceiptV1.oneOf.push({
      properties: {
        semanticKind: { const: "success" },
        exitCode: { const: 88 },
      },
      required: ["semanticKind", "exitCode"],
    });
  });
  rejected("mismatched receipt pair", (value) => {
    value.structuredSchemas.executionReceiptV1.oneOf[0].properties.exitCode.const = 88;
  });
  rejected("missing mode row", (value) => value.modeCompatibility.pop());
  rejected("missing domain rule", (value) => value.domainOutcomeRules.pop());
  rejected("unknown domain operator", (value) => {
    value.domainOutcomeRules.find((row) => row.id === "DOMAIN-ACTION-STALE").when.op = "invented";
  });
  rejected("ambiguous stale selector", (value) => {
    value.domainOutcomeRules.find((row) => row.id === "DOMAIN-ACTION-STALE").when = {
      op: "eq",
      fact: "allResultsStale",
      value: true,
    };
  });
  rejected("domain precedence order", (value) => {
    const selector = value.domainSelectors.find((row) => row.id === "SELECTOR-ACTION-INSPECT");
    [selector.ruleOrder[1], selector.ruleOrder[2]] = [selector.ruleOrder[2], selector.ruleOrder[1]];
  });
  rejected("missing selector operation", (value) => {
    value.domainSelectors.find((row) => row.id === "SELECTOR-DEFAULT").operations.pop();
  });
  rejected("wrong domain fixture outcome", (value) => {
    value.domainFixtures[0].expectedSemanticKind = "success";
  });
  rejected("wrong action projection", (value) => {
    value.domainSelectors.find(
      (row) => row.id === "SELECTOR-ACTION-INSPECT",
    ).factProjection.approvalState = {
      op: "path",
      path: ["approvalState", "state"],
    };
  });
  rejected("missing projection fixture", (value) => value.domainProjectionFixtures.pop());
  rejected("wrong target projection", (value) => {
    value.domainProjectionFixtures.find(
      (row) => row.id === "PROJECTION-ACTION-INSPECT-DUPLICATE",
    ).expectedFacts.targetCoverage = "exact";
  });
  rejected("weakened local detail strictness", (value) => {
    value.localDetailSchemas[0].schema.additionalProperties = true;
  });
  rejected("wrong local detail pairing", (value) => {
    value.localErrorRegistry[0].detailSchemaId = value.localErrorRegistry[1].detailSchemaId;
  });
  rejected("wrong local envelope message", (value) => {
    value.structuredSchemas.localErrorEnvelopeV1.oneOf[0].properties.message.const = "changed";
  });
  rejected("recursive local detail property", (value) => {
    value.localDetailSchemas[0].schema.properties.recursive = { type: "object" };
  });
  rejected("missing requirement coverage", (value) => {
    delete value.coverage["REQ-EXIT"];
  });
}

console.log(
  JSON.stringify({
    format: "agent-mail.cli-command-outcome-check/v1",
    status: "pass",
    oracleSha256: oracleDigest,
    acceptedHead: ACCEPTED_HEAD,
    counts: {
      exits: oracle.exitCodeRegistry.length,
      localErrors: oracle.localErrorRegistry.length,
      clientKinds: oracle.cliClientErrorMatrix.length,
      sharedErrors: oracle.sharedErrorMatrix.length,
      operationErrorCodes: oracle.operationErrorMappings.length,
      operationErrorApplicability: oracle.operationErrorApplicability.length,
      operations: oracle.operationMatrix.length,
      domainRules: oracle.domainOutcomeRules.length,
      domainSelectors: oracle.domainSelectors.length,
      domainFixtures: oracle.domainFixtures.length,
      domainProjectionFixtures: oracle.domainProjectionFixtures.length,
      receiptPairs: oracle.structuredSchemas.executionReceiptV1.oneOf.length,
      localDetailSchemas: oracle.localDetailSchemas.length,
      localEnvelopeProbes: inventories.localEnvelopeProbes,
      receiptProbes: inventories.receiptProbes,
      registeredPrecedenceProbes: inventories.registeredPrecedenceProbes,
      runtimeRows: oracle.runtimeFailureMatrix.length,
      obligations: oracle.implementationObligations.length,
    },
    selfTests,
    downstreamWorktreeDrift,
  }),
);
