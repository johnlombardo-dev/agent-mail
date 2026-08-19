import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c";
const EXPECTED_VIEW_SHA256 = [
  "1068bbccf0de7054baaf604e38bf30a3dd400543585bcca2779e0ff33d5fcc28",
  "a6af40637d1aa4e3642d2c38e465a99d2c25caab312b4e692f30ab84e2f89c84",
  "6f567a5973a3050d265c92881d093d9c3c7e9467c110d8b6d40e488175221f47",
];
const ACCEPTED_HEAD = "547f70dd67959541324688b7b737749bc43791ab";
const EXPECTED_AUTHORITY_SHA256 = {
  signedBuild: "c2118c1396fb599b892649eb55592d464e312543ae3a52cd3a5aa41adc700dd9",
  authenticatedHello: "da4582b5ad8f242d83955d2ca2586d721ad58eae65c4dbd3571737140fe6ebb0",
  brokerContracts: "7d4a0fcb576f69401d21d94acf0fc71717c0a01a295cc6d59a8e7549d470efe0",
  operationContracts: "2f15b4ab15d7c645019c160a48935a05a4e80616b22cdd84f12ce66dd56f3531",
  stateMachine: "88573ae68c39e246838c15dd2b189f7aca240e14a7a210770ce4b32a191f3005",
  removal: "717b287c66965fe667e265f389f797b2cdf3a825ce2da98fdbfd947a3a3ed301",
  connection: "8c84350bfae4fdc97e65df3b4003a0b914de84c49aaa0ab60b4d33d79cc55f98",
  moduleOwnership: "889da3f91ecf3ecd7e254254af881bd6b311f129e3aeae9a8d5dcc82f00a8f86",
  proofMatrices: "4c9e0e7ca03e061276f5c10964967d4d61d02cc2dfdc96438f1779231428eb60",
};

const EXPECTED_LIST_ONLY_HELPER_SOURCE = `import type { ImapFlow, ListOptions, ListResponse } from "imapflow";

type IcloudListOnlyOptions = ListOptions & { readonly listOnly: true };

function forwardListOnly(
  client: Pick<ImapFlow, "list">,
  options: IcloudListOnlyOptions,
): Promise<ListResponse[]> {
  return client.list(options);
}

export function listIcloudMailboxesReadOnly(
  client: Pick<ImapFlow, "list">,
): Promise<ListResponse[]> {
  const options: IcloudListOnlyOptions = { listOnly: true };
  return forwardListOnly(client, options);
}
`;

const EXPECTED_LIST_ONLY_COMPILE_FIXTURE_SOURCE = `import type { ImapFlow, ListResponse } from "imapflow";
import { listIcloudMailboxesReadOnly } from "./icloud-list-only.js";

declare const client: Pick<ImapFlow, "list">;
const rows: Promise<ListResponse[]> = listIcloudMailboxesReadOnly(client);
void rows;
`;

const EXPECTED_LIST_ONLY_FORBIDDEN_CONSTRUCTS = [
  "any",
  "unknown",
  "type assertion with as",
  "angle-bracket type assertion",
  "module augmentation",
  "@ts-ignore",
  "@ts-expect-error",
  "caller-supplied ListOptions",
];

const architectureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDirectory, "../..");
const oraclePath = join(architectureDirectory, "icloud-credential-authority-oracle.v1.json");
const viewPaths = [
  join(architectureDirectory, "icloud-credential-authority-design.v1.md"),
  join(architectureDirectory, "icloud-credential-authority-decisions.v1.md"),
  join(architectureDirectory, "icloud-credential-authority-coverage.v1.md"),
];

const expectedStateIds = [
  "absent",
  "awaiting-user-credential",
  "storing-keychain-item",
  "writing-nonsecret-configuration",
  "validating-authentication",
  "discovering-mailboxes",
  "installing-starting-service",
  "cleaning-old-credential-item",
  "usable-while-backfilling",
  "ready",
  "credentials-required",
  "keychain-unavailable-before-first-unlock",
  "authentication-blocked",
  "replacing",
  "removing",
  "failed-with-recoverable-step",
];

const expectedActiveStates = [
  "awaiting-user-credential",
  "storing-keychain-item",
  "writing-nonsecret-configuration",
  "validating-authentication",
  "discovering-mailboxes",
  "installing-starting-service",
  "cleaning-old-credential-item",
  "replacing",
  "removing",
];

const expectedPrincipalRows = [
  ["PRINCIPAL-OUTER", "dev.johnlombardo.agent-mail", false],
  ["PRINCIPAL-CLI", "dev.johnlombardo.agent-mail.cli", false],
  ["PRINCIPAL-BROKER", "dev.johnlombardo.agent-mail.credential-broker", true],
  ["PRINCIPAL-DAEMON", "dev.johnlombardo.agent-mail.daemon", true],
];

const expectedForbiddenSinkIds = [
  "SINK-ARGV",
  "SINK-STDIN",
  "SINK-ENV",
  "SINK-FILE",
  "SINK-CONFIG",
  "SINK-XPC",
  "SINK-HTTP",
  "SINK-RESULT",
  "SINK-LOG",
  "SINK-TRANSCRIPT",
  "SINK-EVIDENCE",
  "SINK-BACKUP",
];

const expectedOperationRows = [
  ["OP-CONNECT", "account.connect", "agent-mail account connect", "AccountUsableResultV1"],
  ["OP-STATUS", "account.status", "agent-mail account status", "AccountStatusResultV1"],
  ["OP-REPAIR", "account.repair", "agent-mail account repair", "AccountUsableResultV1"],
  ["OP-REPLACE", "account.replace", "agent-mail account replace", "AccountUsableResultV1"],
  ["OP-REMOVE", "account.remove", "agent-mail account remove", "AccountRemovedResultV1"],
];

const expectedErrorRows = [
  [
    "account.interaction_required",
    "attention",
    85,
    "A signed local user interaction is required.",
    ["state"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.credentials_required",
    "attention",
    85,
    "iCloud credentials are required.",
    ["state", "recoveryAction"],
    ["account.repair"],
  ],
  [
    "account.authentication_blocked",
    "authorization",
    77,
    "iCloud authentication is blocked until credentials are replaced.",
    ["state", "credentialRevision"],
    ["account.connect", "account.repair", "account.replace"],
  ],
  [
    "account.keychain_before_first_unlock",
    "temporary",
    75,
    "The Keychain is unavailable until this user unlocks the Mac.",
    ["state"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.local_authority_denied",
    "authorization",
    77,
    "The local credential authority denied this caller.",
    ["reasonCode"],
    ["all-local-account-operations"],
  ],
  [
    "account.provider_unavailable",
    "temporary",
    75,
    "iCloud Mail is temporarily unavailable.",
    ["phase", "attemptCount"],
    ["account.connect", "account.repair", "account.replace"],
  ],
  [
    "account.provider_protocol_failure",
    "protocol",
    76,
    "The iCloud Mail authentication protocol failed safely.",
    ["phase", "reasonCode"],
    ["account.connect", "account.repair", "account.replace"],
  ],
  [
    "account.operation_busy",
    "conflict",
    79,
    "Another local account operation is active.",
    ["activeOperation"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.request_replayed",
    "replay",
    82,
    "The local account request was rejected as a replay.",
    ["receiptState"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.receipt_capacity",
    "conflict",
    79,
    "The local request receipt capacity is temporarily full.",
    ["capacity", "retryAfter"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.stale_reference",
    "stale",
    80,
    "The configured credential reference is stale.",
    ["state", "recoveryAction"],
    ["account.repair"],
  ],
  [
    "account.cancelled",
    "cancelled",
    84,
    "The local account operation was cancelled.",
    ["phase"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.cleanup_required",
    "partial",
    86,
    "Local credential cleanup is required.",
    ["recoveryStep"],
    ["account.connect", "account.repair", "account.replace", "account.remove"],
  ],
  [
    "account.internal",
    "internal",
    70,
    "The local account operation failed.",
    ["phase", "correlationId"],
    ["all-local-account-operations"],
  ],
];

const expectedAllowlist = [
  "CAPABILITY",
  "ID",
  "LOGIN",
  "AUTHENTICATE",
  "NAMESPACE",
  "LIST",
  "XLIST",
  "LOGOUT",
];

const expectedDenylist = [
  "SELECT",
  "EXAMINE",
  "FETCH",
  "UID FETCH",
  "STORE",
  "UID STORE",
  "MOVE",
  "UID MOVE",
  "COPY",
  "UID COPY",
  "DELETE",
  "EXPUNGE",
  "UID EXPUNGE",
  "CLOSE",
  "APPEND",
  "CREATE",
  "RENAME",
  "LSUB",
  "STATUS",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "SETACL",
  "DELETEACL",
];

const expectedAuthCategories = [
  ["AUTH-ACCEPTED", "accepted"],
  [
    "AUTH-REJECTED",
    "local-part advances once to full-address when the shared budget has capacity, local-part exhaustion is provider-unavailable, and full-address is authentication-blocked",
  ],
  ["AUTH-MISSING", "credentials-required"],
  ["AUTH-FIRST-UNLOCK", "keychain-unavailable-before-first-unlock"],
  ["AUTH-NETWORK", "provider-unavailable after bounded retry"],
  ["AUTH-TLS", "provider-protocol-failure with no fallback"],
  ["AUTH-MALFORMED", "provider-protocol-failure"],
  ["AUTH-INTERNAL", "redacted internal failure"],
];

const expectedProofCounts = {
  keychain: 11,
  writeCrash: 12,
  broker: 12,
  plaintext: 12,
  lifecycle: 9,
  authentication: 9,
  validation: 3,
  parityIsolation: 3,
  secretScan: 1,
  adapters: 2,
  signedBuild: 5,
  removal: 6,
  capacity: 5,
  contractProjection: 4,
};

const expectedMutationIds = [
  "MUT-SIGNED-BUILD-SELF-REFERENCE",
  "MUT-PROCESS-AUTHORITY",
  "MUT-PREAUTH-OPERATION-METADATA",
  "MUT-KEYCHAIN-ACCESSIBILITY",
  "MUT-PLAINTEXT-PATH",
  "MUT-PLAINTEXT-ADD-PASSWORD",
  "MUT-PUBLIC-HTTP-REACHABILITY",
  "MUT-PARTIAL-WRITE-RECOVERY",
  "MUT-REMOVAL-UNCONDITIONAL-T28",
  "MUT-RECOVERY-UNSPECIFIED-T30",
  "MUT-AUTHBLOCKED-GENERATION",
  "MUT-VALIDATION-LSUB",
  "MUT-TYPE-LISTONLY-REMOVED",
  "MUT-TYPE-LISTONLY-BOOLEAN",
  "MUT-TYPE-LISTONLY-OPTIONAL",
  "MUT-TYPE-LISTONLY-CAST",
  "MUT-TYPE-LISTONLY-ANY",
  "MUT-TYPE-DECLARATION-PIN-DROPPED",
  "MUT-TYPE-COMPILE-PROOF-DROPPED",
  "MUT-RECEIPT-CAPACITY-257",
  "MUT-ATTEMPT-BUDGET-NESTED",
  "MUT-BACKUP-SECRET-EXCLUSION",
  "MUT-UNINSTALL-REVOCATION",
  "MUT-DEMO-ISOLATION",
  "MUT-OWNERSHIP-OVERLAP",
  "MUT-VIEW-DIVERGENCE",
  "MUT-EVIDENCE-TIER",
];

const expectedEvidenceRows = [
  ["EVIDENCE-DESIGN", "verified-by-this-checker"],
  ["EVIDENCE-LOCAL", "unverified-future"],
  ["EVIDENCE-SIGNED-INSTALLED", "unverified-future"],
  ["EVIDENCE-LIVE-READ-ONLY", "unverified-future-explicit-authorization-required"],
  ["EVIDENCE-DEPLOYED", "unverified-future"],
  ["EVIDENCE-SECURITY", "unverified-future-independent-review"],
  ["EVIDENCE-DOCUMENTATION", "unverified-future"],
  ["EVIDENCE-DELIVERY", "unverified-future"],
];

const expectedDownstreamRows = [
  ["DOWNSTREAM-PLAN", "planning-repair", "high"],
  ["DOWNSTREAM-KEYCHAIN", "signed-keychain-provider-implementation", "xhigh"],
  ["DOWNSTREAM-CONNECTION", "production-icloud-connection-and-recovery-implementation", "xhigh"],
  [
    "DOWNSTREAM-LOCAL-COMMANDS",
    "local-account-command-and-setup-primitives-implementation",
    "xhigh",
  ],
  ["DOWNSTREAM-QUALIFICATION", "independent-credential-qualification", "high"],
];

const expectedIssueEvidenceRows = [
  [
    235,
    "issue-body",
    "9e8dc92cc0b60af075448d5bfeb5606e68b0a521a3067dbb059c1f613d4ebab7",
    "2026-08-19T06:19:00Z",
  ],
  [
    236,
    "issue-body",
    "b4ecf908c28a91b53c446f01d65ec46a40d1b179059e4d7740c3c25f117b5a6e",
    "2026-08-19T06:18:21Z",
  ],
  [
    153,
    "issue-comment:5338317946",
    "a327de77b1ad9643f817a42bc2bcb99909364562d7faffaf555a61bf5af3964e",
    "2026-08-19T06:19:02Z",
  ],
  [
    167,
    "issue-comment:5338318173",
    "8917b529b47a7125efebf31bd335837a9aae6fe58cb60ac4677b44e5419e1443",
    "2026-08-19T06:19:03Z",
  ],
  [
    168,
    "issue-comment:5338318632",
    "2169b2ab84ffb7a22ea1d0a417df51ce94f8ed533193152dff605a6a84987c5b",
    "2026-08-19T06:19:07Z",
  ],
  [
    171,
    "issue-comment:5338319134",
    "3695b7e435246b5f9864a83e59550d58e3e1bc0bc8c0c6e29c4e0afe55df6a5d",
    "2026-08-19T06:19:10Z",
  ],
  [
    175,
    "issue-comment:5338319443",
    "6518c4d88c102130aa19df4e23151245de108c71552332c24a6f672fc4138cbc",
    "2026-08-19T06:19:13Z",
  ],
  [
    177,
    "issue-comment:5338319712",
    "78c10843d5cba42818fb814fa7989c3b434a669400184e50896b9a968f3fdb0c",
    "2026-08-19T06:19:15Z",
  ],
  [
    183,
    "issue-comment:5338319934",
    "df69897939f0305908bb9d3d98030ac06b61f7af2daae8dfce6614bb3dcedae7",
    "2026-08-19T06:19:16Z",
  ],
  [
    185,
    "issue-comment:5338320130",
    "8f6a4c055f3b854a656483ce3d0a5a8267dfc78e5f327bfed47910bc204c9980",
    "2026-08-19T06:19:18Z",
  ],
  [
    203,
    "issue-body",
    "ba470d9239b52402bc49762471e853559454e5914efd6a978437dceeddada13c",
    "2026-08-18T21:06:08Z",
  ],
  [
    204,
    "issue-body",
    "e6c496c210a244441421808c55b45912463a16f042e5aa1fcf5342caad6fb614",
    "2026-08-18T21:42:49Z",
  ],
  [
    213,
    "issue-body",
    "1b38261635a3dc44b3e30222e45a5f70c949a12547cd015f13380b95379ee097",
    "2026-08-19T01:07:09Z",
  ],
  [
    214,
    "issue-body",
    "0861f9503361b95bdec1889d1b8d98e95ee9e2a8f4099cb5f84cdcce2917d1c3",
    "2026-08-19T01:57:31Z",
  ],
  [
    215,
    "issue-comment:5338320380",
    "199f9aa76d10b0ec48f2eb2eb1ddec67e6fb7e1668ca673728ccdb7bd8b8f7bf",
    "2026-08-19T06:19:20Z",
  ],
  [
    217,
    "issue-comment:5338320608",
    "610c92b7bd1dea4332c5ec52f2e46e578b0074aeafbb202d1914b7f5a64a3653",
    "2026-08-19T06:19:22Z",
  ],
  [
    221,
    "issue-body",
    "0cbde2dd9b5f3756ccf12bdabcb07047377794221c0e8bfa062427a48c1001c3",
    "2026-08-19T02:18:18Z",
  ],
];

const expectedThreatAssetIds = [
  "ASSET-APP-PASSWORD",
  "ASSET-CREDENTIAL-REFERENCE",
  "ASSET-AUTHORITY-STATE",
  "ASSET-ARCHIVE",
  "ASSET-APPLE-ACCOUNT",
  "ASSET-SIGNING-AUTHORITY",
  "ASSET-EVIDENCE-INTEGRITY",
];

const expectedAttackerRows = [
  ["ATTACK-SAME-USER", "partially-mitigated"],
  ["ATTACK-OTHER-USER", "mitigated"],
  ["ATTACK-UNSIGNED-RESIGNED", "mitigated"],
  ["ATTACK-FILE-TAMPER", "partially-mitigated"],
  ["ATTACK-PROVIDER-NETWORK", "mitigated"],
  ["ATTACK-MAIL-CONTENT", "mitigated-at-existing-mail-boundaries"],
  ["ATTACK-REPLAY-CRASH", "mitigated"],
  ["ATTACK-DEMO-MISROUTE", "mitigated"],
  ["ATTACK-BACKUP-COPY", "mitigated"],
  ["ATTACK-SIGNING-COMPROMISE", "explicit-limit"],
  ["ATTACK-ROOT-SESSION", "explicit-limit"],
];

const expectedTrustBoundaryIds = [
  "TB-USER-BROKER",
  "TB-CLI-BROKER",
  "TB-CLI-STORAGE",
  "TB-CLI-VALIDATOR",
  "TB-DAEMON-KEYCHAIN",
  "TB-DAEMON-APPLE",
  "TB-LOCAL-PUBLIC",
  "TB-PRODUCTION-DEMO",
  "TB-BACKUP-RESTORE",
  "TB-INSTALL-SIGNING",
];

function fail(message) {
  throw new Error("iCloud credential authority check failed: " + message);
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

function authorityDigests(oracle) {
  const authorities = {
    signedBuild: oracle.bundleTopology.signing,
    authenticatedHello: oracle.localAdministration.authenticatedHello,
    brokerContracts: {
      requestEnvelope: oracle.localAdministration.requestEnvelope,
      operationSchemas: oracle.localAdministration.operationSchemas,
      responseEnvelope: oracle.localAdministration.responseEnvelope,
      authorization: oracle.localAdministration.authorization,
      callerAuthentication: oracle.localAdministration.callerAuthentication,
      receiptLedger: oracle.localAdministration.receiptLedger,
      replay: oracle.localAdministration.replay,
      concurrency: oracle.localAdministration.concurrency,
      publicReachability: oracle.localAdministration.publicReachability,
    },
    operationContracts: {
      requestEnvelopeSchema: oracle.operationAuthority.requestEnvelopeSchema,
      operations: oracle.operationAuthority.operations,
      resultSchemas: oracle.operationAuthority.resultSchemas,
      errors: oracle.operationAuthority.errors,
    },
    stateMachine: {
      states: oracle.stateMachine.states,
      transitions: oracle.stateMachine.transitions,
      recoveryResumeMap: oracle.stateMachine.recoveryResumeMap,
    },
    removal: {
      removalTransactionSchema: oracle.configurationAuthority.removalTransactionSchema,
      removalProtocol: oracle.removalRestoreAuthority.removalProtocol,
      removalCrashOrderings: oracle.removalCrashOrderings,
    },
    connection: {
      providerInterface: oracle.provider.providerInterface,
      usernameCandidates: oracle.provider.usernameCandidates,
      maximumAuthenticationCandidatesPerGeneration:
        oracle.provider.maximumAuthenticationCandidatesPerGeneration,
      attemptBudget: oracle.provider.attemptBudget,
      connectionFactory: oracle.connectionFactory,
    },
    moduleOwnership: oracle.moduleOwnership,
    proofMatrices: oracle.proofMatrices,
  };
  return Object.fromEntries(
    Object.entries(authorities).map(([name, value]) => [name, sha256(stable(value))]),
  );
}

function exact(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(label + " differs: " + stable(actual));
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual)) fail(label + " is not an array");
  exact(actual.map(stable).sort(), expected.map(stable).sort(), label);
}

function unique(items, selector, label) {
  if (!Array.isArray(items)) fail(label + " is not an array");
  const values = items.map(selector);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(label + " contains an invalid key");
  }
  if (new Set(values).size !== values.length) fail(label + " contains a duplicate");
  return new Set(values);
}

function requireText(value, label, fragments = []) {
  if (typeof value !== "string" || value.length === 0) fail(label + " is empty");
  for (const fragment of fragments) {
    if (!value.includes(fragment)) fail(label + " omits " + fragment);
  }
}

function requireReferences(values, authority, label) {
  if (!Array.isArray(values) || values.length === 0) fail(label + " is empty");
  for (const value of values) {
    if (!authority.has(value)) fail(label + " references unknown " + value);
  }
}

function requireReferencesAllowEmpty(values, authority, label) {
  if (!Array.isArray(values)) fail(label + " is not an array");
  for (const value of values) {
    if (!authority.has(value)) fail(label + " references unavailable or cyclic " + value);
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
    fail("cannot read committed source " + commit + ":" + path);
  }
}

function byId(items, id, label) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) fail(label + " is missing " + id);
  return item;
}

function validateCore(oracle) {
  exact(oracle.format, "agent-mail.icloud-credential-authority-oracle/v1", "format");
  exact(oracle.schemaVersion, 1, "schemaVersion");
  exact(oracle.modelVersion, "1.0.0", "modelVersion");
  exact(oracle.status, "frozen-design", "status");
  exact(oracle.oracle?.normative, true, "normative flag");
  exact(oracle.oracle?.issue, 236, "issue");
  exact(oracle.oracle?.parentIssue, 235, "parent issue");
  exact(oracle.oracle?.acceptedHead, ACCEPTED_HEAD, "accepted head");
  requireText(oracle.oracle?.invariant, "oracle invariant", ["signed", "raw secret"]);
  exact(
    oracle.executionProfile,
    {
      worker: "gpt-5.6-sol",
      reasoningEffort: "max",
      assignment: "whole-and-undecomposed",
      failureDomain: "the five icloud-credential-authority v1 artifacts only",
    },
    "execution profile",
  );
  exact(oracle.remainingConsequentialChoices, [], "remaining consequential choices");

  exact(
    oracle.productBoundary?.selectedMethod,
    "dedicated-apple-app-specific-password",
    "credential method",
  );
  exact(
    oracle.productBoundary?.primaryAppleAccountPassword,
    "forbidden",
    "primary password policy",
  );
  exact(oracle.productBoundary?.accountLimit, 1, "account limit");
  exact(oracle.provider?.id, "icloud-imap-app-password-v1", "provider id");
  exact(oracle.provider?.host, "imap.mail.me.com", "provider host");
  exact(oracle.provider?.port, 993, "provider port");
  exact(oracle.provider?.secure, true, "provider secure");
  exact(oracle.provider?.tlsRejectUnauthorized, true, "provider TLS validation");
  exact(oracle.provider?.tlsMinimumVersion, "TLSv1.2", "provider TLS floor");
  exact(oracle.provider?.protocolSettingsUserConfigurable, false, "provider configuration policy");
  exact(
    oracle.provider?.providerInterface?.additionalProperties,
    false,
    "provider interface strictness",
  );
  exactSet(
    oracle.provider?.providerInterface?.required,
    ["method", "providerId", "credentialInput", "connectionFactory"],
    "provider interface fields",
  );
  exact(
    oracle.provider?.providerInterface?.properties,
    {
      method: { const: "apple-app-specific-password-imap-v1" },
      providerId: { const: "icloud-imap-app-password-v1" },
      credentialInput: { const: "accepted-opaque-keychain-reference-only" },
      connectionFactory: { const: "createProductionIcloudConnectionV1" },
    },
    "provider interface properties",
  );
  requireText(oracle.provider?.providerInterface?.futureMethodRule, "future provider method rule", [
    "new discriminant",
    "cannot be selected as fallback",
  ]);
  exact(
    oracle.provider?.usernameCandidates?.map((row) => [row.order, row.form]),
    [
      [1, "local-part"],
      [2, "full-address"],
    ],
    "username candidates",
  );
  exact(oracle.provider?.maximumAuthenticationCandidatesPerGeneration, 2, "username attempt limit");
  exact(
    oracle.provider?.attemptBudget?.maximumProviderSessions,
    3,
    "shared provider-session budget",
  );
  exact(
    oracle.provider?.attemptBudget?.delayBeforeRetryMilliseconds,
    [1000, 2000],
    "shared retry delays",
  );
  requireText(oracle.provider?.attemptBudget?.scope, "attempt budget scope", [
    "across both username candidates",
  ]);
  requireText(oracle.provider?.attemptBudget?.sessionAccounting, "session accounting", [
    "Every",
    "three total attempts",
    "no nested",
  ]);
  exact(
    oracle.provider?.attemptBudget?.schedules?.map((row) => [row.id, row.events, row.outcome]),
    [
      [
        "ATTEMPT-01",
        ["local transient", "wait 1000", "local transient", "wait 2000", "local transient"],
        "account.provider_unavailable after three sessions",
      ],
      [
        "ATTEMPT-02",
        ["local structural rejection", "full accepted"],
        "accepted after two sessions",
      ],
      [
        "ATTEMPT-03",
        ["local transient", "wait 1000", "local structural rejection", "full accepted"],
        "accepted after three sessions",
      ],
      [
        "ATTEMPT-04",
        ["local structural rejection", "full transient", "wait 2000", "full accepted"],
        "accepted after three sessions",
      ],
      [
        "ATTEMPT-05",
        [
          "local transient",
          "wait 1000",
          "local transient",
          "wait 2000",
          "local structural rejection",
        ],
        "account.provider_unavailable because no session remains for full-address",
      ],
    ],
    "username/transport schedules",
  );
  exact(oracle.provider?.password?.requiresTwoFactorAuthentication, true, "2FA requirement");
  exact(oracle.provider?.password?.maximumActiveAtApple, 25, "Apple active-password limit");
  exact(oracle.provider?.password?.individualRevocation, true, "individual revocation");
  exact(
    oracle.provider?.password?.primaryPasswordChangeRevokesAll,
    true,
    "primary password revocation",
  );
  for (const forbidden of [
    "primary Apple Account password",
    "environment, file, stdin, argv, or test-client credential injection",
  ]) {
    if (!oracle.provider.noFallbacks.includes(forbidden))
      fail("provider fallbacks omit " + forbidden);
  }

  exact(oracle.platform?.minimumCredentialFeatureMacOS, 12, "minimum macOS");
  requireText(oracle.platform?.belowMinimum, "below-minimum rule", ["fail-closed"]);
  exact(oracle.platform?.systemLaunchDaemon, "forbidden", "system daemon policy");
  requireText(oracle.platform?.distribution, "distribution", ["Homebrew Cask"]);
  exact(oracle.platform?.formulaOrSourceBuildForLive, "forbidden", "formula live policy");

  const principalIds = unique(oracle.bundleTopology?.principals, (row) => row.id, "principal ids");
  exact(
    oracle.bundleTopology.principals.map((row) => [
      row.id,
      row.bundleIdentifier,
      row.keychainAccessGroupMember,
    ]),
    expectedPrincipalRows,
    "signed principal topology",
  );
  exactSet(
    oracle.bundleTopology?.launchAgents?.map((row) => row.label),
    ["dev.johnlombardo.agent-mail.credential-broker", "dev.johnlombardo.agent-mail.daemon"],
    "LaunchAgent labels",
  );
  const brokerAgent = oracle.bundleTopology.launchAgents.find(
    (row) => row.principal === "PRINCIPAL-BROKER",
  );
  const daemonAgent = oracle.bundleTopology.launchAgents.find(
    (row) => row.principal === "PRINCIPAL-DAEMON",
  );
  exact(
    [brokerAgent?.runAtLoad, brokerAgent?.keepAlive],
    [false, false],
    "broker LaunchAgent policy",
  );
  exact(
    [daemonAgent?.runAtLoad, daemonAgent?.keepAlive],
    [true, true],
    "daemon LaunchAgent policy",
  );
  requireText(oracle.bundleTopology?.oneShotValidation, "one-shot validation topology", [
    "anonymous C XPC",
    "never enters argv",
  ]);
  exact(
    oracle.bundleTopology?.signing?.distributionIdentity,
    "Developer ID Application",
    "signing identity",
  );
  exact(oracle.bundleTopology?.signing?.hardenedRuntime, true, "hardened runtime");
  exact(oracle.bundleTopology?.signing?.notarizedAndStapled, true, "notarization");
  exact(
    oracle.bundleTopology?.signing?.releaseInputsArePolicyChoices,
    false,
    "release input classification",
  );
  requireText(oracle.bundleTopology?.signing?.acceptedRequirementTemplate, "code requirement", [
    "anchor apple generic",
    "identifier",
    "subject.OU",
  ]);
  requireText(oracle.bundleTopology?.signing?.resignedDefinition, "re-signed definition", [
    "ad-hoc",
    "cdhash",
  ]);
  exact(
    oracle.bundleTopology?.signing?.manifestSchema?.forbidden,
    ["outerCdhash", "outerArtifactSha256", "notarizationTicket"],
    "manifest non-self-reference fields",
  );
  exact(
    oracle.bundleTopology?.signing?.manifestSchema?.nestedPrincipalIds,
    ["PRINCIPAL-CLI", "PRINCIPAL-BROKER", "PRINCIPAL-DAEMON"],
    "manifest nested principal ids",
  );
  const constructionIds = unique(
    oracle.bundleTopology?.signing?.construction,
    (row) => row.id,
    "signed build steps",
  );
  exactSet(
    [...constructionIds],
    Array.from({ length: 8 }, (_, index) => `SBUILD-${String(index + 1).padStart(2, "0")}`),
    "signed build step ids",
  );
  const completedBuildSteps = new Set();
  for (const step of oracle.bundleTopology.signing.construction) {
    requireReferencesAllowEmpty(step.after, completedBuildSteps, step.id + " build dependencies");
    requireText(step.effect, step.id + " build effect");
    completedBuildSteps.add(step.id);
  }
  requireText(oracle.bundleTopology?.signing?.acyclicityInvariant, "signed build acyclicity", [
    "No SBUILD step reads its own output",
    "remain detached",
  ]);
  requireText(
    oracle.bundleTopology?.signing?.signedInstalledConstructionProof,
    "signed-installed construction proof",
    ["codesign --verify --deep --strict", "resource seal", "Design evidence does not claim"],
  );

  exact(
    oracle.keychainAuthority?.implementation,
    "Security.framework SecItem API with kSecUseDataProtectionKeychain=true on every add, query, and delete",
    "Keychain implementation",
  );
  exact(
    oracle.keychainAuthority?.accessGroupTemplate,
    "$(AppIdentifierPrefix)dev.johnlombardo.agent-mail.credentials.v1",
    "access group",
  );
  exactSet(
    oracle.keychainAuthority?.accessGroupPrincipals,
    ["PRINCIPAL-BROKER", "PRINCIPAL-DAEMON"],
    "access-group principals",
  );
  requireReferences(
    oracle.keychainAuthority?.accessGroupPrincipals,
    principalIds,
    "access-group principals",
  );
  exact(oracle.keychainAuthority?.item?.kSecClass, "kSecClassGenericPassword", "Keychain class");
  exact(
    oracle.keychainAuthority?.item?.kSecAttrService,
    "dev.johnlombardo.agent-mail.icloud-mail.v1",
    "Keychain service",
  );
  exact(
    oracle.keychainAuthority?.item?.kSecAttrServer,
    "absent-not-applicable-to-kSecClassGenericPassword",
    "generic-password server attribute",
  );
  exact(
    oracle.keychainAuthority?.item?.kSecAttrAccessible,
    "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
    "Keychain accessibility",
  );
  exact(oracle.keychainAuthority?.item?.kSecAttrSynchronizable, false, "Keychain sync policy");
  exact(
    oracle.keychainAuthority?.item?.kSecUseDataProtectionKeychain,
    true,
    "data-protection Keychain policy",
  );
  exact(
    oracle.keychainAuthority?.reference?.pattern,
    "^amcred:v1:[A-Za-z0-9_-]{43}$",
    "opaque-ref pattern",
  );
  exact(
    oracle.keychainAuthority?.reference?.notReturnedByUserFacingResults,
    true,
    "opaque-ref result policy",
  );
  requireText(oracle.keychainAuthority?.duplicatePolicy, "duplicate policy", [
    "SecItemAdd only",
    "Never update",
  ]);
  requireText(oracle.keychainAuthority?.replacementPolicy, "replacement policy", [
    "new reference",
    "delete the old",
  ]);
  requireText(oracle.keychainAuthority?.enumerationPolicy, "enumeration policy", [
    "Never enumerate",
  ]);
  requireText(oracle.keychainAuthority?.firstUnlock, "first-unlock policy", ["no timer"]);

  exact(
    oracle.localAdministration?.transport,
    "C XPC Mach service in the logged-in user's bootstrap namespace",
    "broker transport",
  );
  exact(oracle.localAdministration?.protocolVersion, 1, "broker protocol version");
  exact(
    oracle.localAdministration?.authenticatedHello?.acceptorFirst,
    true,
    "acceptor-first hello",
  );
  exact(
    oracle.localAdministration?.authenticatedHello?.challengeLifetimeSeconds,
    5,
    "hello expiry",
  );
  exact(
    oracle.localAdministration?.authenticatedHello?.appliesTo,
    ["broker Mach XPC", "one-shot validator anonymous XPC"],
    "authenticated hello surfaces",
  );
  for (const [name, schema] of Object.entries({
    serverChallenge: oracle.localAdministration?.authenticatedHello?.serverChallengeSchema,
    clientHello: oracle.localAdministration?.authenticatedHello?.clientHelloSchema,
    serverAccepted: oracle.localAdministration?.authenticatedHello?.serverAcceptedSchema,
  })) {
    exact(schema?.additionalProperties, false, name + " strictness");
    exactSet(Object.keys(schema?.properties ?? {}), schema?.required ?? [], name + " properties");
    for (const forbidden of [
      "operation",
      "requestId",
      "credentialRef",
      "accountEmail",
      "transactionId",
      "ui",
    ]) {
      if (!schema?.forbidden?.includes(forbidden)) fail(name + " permits pre-auth " + forbidden);
    }
  }
  exact(
    oracle.localAdministration?.authenticatedHello?.verificationOrder?.length,
    5,
    "hello steps",
  );
  requireText(
    oracle.localAdministration?.authenticatedHello?.verificationOrder?.join("\n"),
    "hello verification order",
    [
      "before decoding any peer-provided operation metadata",
      "received challenge message",
      "received hello message",
      "received accepted message",
      "then and only then",
    ],
  );
  requireText(
    oracle.localAdministration?.authenticatedHello?.wrongPeerPostcondition,
    "wrong-peer postcondition",
    ["zero operation decoding", "zero operation metadata disclosure", "zero UI", "zero Keychain"],
  );
  exact(
    oracle.localAdministration?.requestEnvelope?.additionalKeys,
    false,
    "broker request strictness",
  );
  exactSet(
    oracle.localAdministration?.requestEnvelope?.requiredKeys,
    [
      "protocolVersion",
      "handshakeId",
      "transcriptSha256",
      "requestId",
      "requestNonce",
      "operation",
      "payload",
    ],
    "broker request keys",
  );
  exactSet(
    oracle.localAdministration?.requestEnvelope?.properties?.operation?.enum,
    ["credential.store", "credential.exists", "credential.remove"],
    "broker operations",
  );
  exact(
    oracle.localAdministration?.requestEnvelope?.maximumEncodedBytes,
    16384,
    "broker frame limit",
  );
  exactSet(
    oracle.localAdministration?.operationSchemas?.map((row) => row.operation),
    ["credential.store", "credential.exists", "credential.remove"],
    "broker schema operations",
  );
  for (const row of oracle.localAdministration.operationSchemas) {
    exact(row.payload?.additionalProperties, false, row.operation + " payload strictness");
    exact(row.result?.additionalProperties, false, row.operation + " result strictness");
    exactSet(
      Object.keys(row.payload?.properties ?? {}),
      row.payload?.required,
      row.operation + " payload schema",
    );
    exactSet(
      Object.keys(row.result?.properties ?? {}),
      row.result?.required,
      row.operation + " result schema",
    );
    for (const forbidden of ["password", "secret", "credentialBytes"]) {
      if (
        !row.payload?.forbidden?.includes(forbidden) ||
        !row.result?.forbidden?.includes(forbidden)
      ) {
        fail(row.operation + " does not forbid " + forbidden);
      }
    }
  }
  exact(
    oracle.localAdministration?.responseEnvelope?.additionalKeys,
    false,
    "broker response strictness",
  );
  exact(
    oracle.localAdministration?.authorization,
    {
      "credential.store":
        "only a durable CLI transaction naming a new exact reference, revision, account display identity, and Apple label; the password is collected inside the broker UI",
      "credential.exists":
        "only an exact reference named by validated active, pending, old, or removal-journal authority",
      "credential.remove":
        "only an exact reference named by validated active, pending, old, or removal-journal authority and a journaled compensation, generation-healthy replacement cleanup, or user-confirmed account removal",
    },
    "broker operation authorization",
  );
  requireText(
    oracle.localAdministration?.callerAuthentication?.preparse?.join("\n"),
    "caller authentication checks",
    [
      "authenticatedHello",
      "every received",
      "requirement",
      "cdhash",
      "effective UID",
      "audit-session",
    ],
  );
  exact(oracle.localAdministration?.callerAuthentication?.pidOnly, "forbidden", "PID-only policy");
  exact(
    oracle.localAdministration?.callerAuthentication?.sameUidOnly,
    "insufficient",
    "UID-only policy",
  );
  exact(oracle.localAdministration?.receiptLedger?.retentionSeconds, 86400, "receipt retention");
  exact(oracle.localAdministration?.receiptLedger?.maximumUnexpiredRecords, 256, "receipt cap");
  requireText(
    oracle.localAdministration?.receiptLedger?.admissionOrder?.join("\n"),
    "receipt admission order",
    [
      "compact every receipt",
      "even when 256",
      "reject the next unique",
      "before UI",
      "reserve and fsync",
    ],
  );
  exact(
    oracle.localAdministration?.receiptLedger?.capacityError?.code,
    "account.receipt_capacity",
    "receipt capacity code",
  );
  requireText(oracle.localAdministration?.replay, "replay policy", ["257th", "before UI/effect"]);
  requireText(oracle.localAdministration?.concurrency, "concurrency policy", [
    "One mutation actor",
  ]);
  requireText(oracle.localAdministration?.publicReachability, "public reachability", [
    "No HTTP route",
    "OpenAPI",
    "demo",
  ]);

  exactSet(
    oracle.secretAuthority?.permittedLocations?.map((row) => row.id),
    ["SECRET-BROKER-FIELD", "SECRET-KEYCHAIN", "SECRET-DAEMON-AUTH"],
    "permitted secret locations",
  );
  exactSet(
    oracle.secretAuthority?.forbiddenSinks?.map((row) => row.id),
    expectedForbiddenSinkIds,
    "forbidden secret sinks",
  );
  requireText(oracle.secretAuthority?.deterministicZeroizationLimit, "zeroization limit", [
    "cannot be proven",
    "ImapFlow",
  ]);

  exact(oracle.configurationAuthority?.activePath, "config/accounts.v1.json", "active config path");
  exact(
    oracle.configurationAuthority?.journalPath,
    "journal/account-authority.v1.json",
    "journal path",
  );
  exact(
    oracle.configurationAuthority?.activeSchema?.additionalProperties,
    false,
    "active config strictness",
  );
  exactSet(
    oracle.configurationAuthority?.activeSchema?.required,
    [
      "schemaVersion",
      "installationId",
      "accountId",
      "providerId",
      "email",
      "usernameForm",
      "credentialRef",
      "credentialRevision",
      "appleCredentialLabel",
      "state",
    ],
    "active config fields",
  );
  exact(
    oracle.configurationAuthority?.journalSchema?.maximumPendingTransactions,
    1,
    "pending transaction limit",
  );
  exact(oracle.configurationAuthority?.journalSchema?.rawSecretFields, [], "journal secret fields");
  exact(
    oracle.configurationAuthority?.receiptRecordSchema?.maximumUnexpiredRecords,
    256,
    "receipt-record capacity",
  );
  exactSet(
    oracle.configurationAuthority?.removalTransactionSchema?.required,
    [
      "schemaVersion",
      "transactionId",
      "requestId",
      "requestNonceSha256",
      "accountId",
      "phase",
      "cursor",
      "daemon",
      "plist",
      "binding",
      "credentialTargets",
      "appleCredentialLabel",
      "preserveArchive",
      "preserveBackups",
      "appleRevocation",
      "confirmationDigest",
    ],
    "removal transaction fields",
  );
  exact(
    oracle.configurationAuthority?.removalTransactionSchema?.properties?.credentialTargets
      ?.maximumItems,
    3,
    "bounded removal target count",
  );
  exact(
    oracle.configurationAuthority?.removalTransactionSchema?.properties?.credentialTargets
      ?.minimumItems,
    0,
    "empty removal target lower bound",
  );
  exactSet(
    oracle.configurationAuthority?.removalTransactionSchema?.properties?.credentialTargets?.items
      ?.required,
    ["credentialRef", "expectedMetadataSha256", "appleCredentialLabel", "role", "absenceConfirmed"],
    "exact removal item fields",
  );
  exact(
    oracle.configurationAuthority?.removalTransactionSchema?.properties?.credentialTargets?.items
      ?.additionalProperties,
    false,
    "exact removal item strictness",
  );
  requireText(
    oracle.configurationAuthority?.removalTransactionSchema?.firstEffectRule,
    "removal target journal ordering",
    ["file-fsynced", "parent-fsynced", "before stop/unload", "Keychain delete"],
  );
  for (const excluded of ["kSecValueData", "raw password", "Keychain export"]) {
    if (!oracle.configurationAuthority.backupExclusions.includes(excluded))
      fail("backup exclusions omit " + excluded);
  }
  requireText(oracle.configurationAuthority?.restoreRule, "restore rule", ["credentialsRequired"]);

  const stateIds = unique(oracle.stateMachine?.states, (row) => row.id, "state ids");
  exactSet([...stateIds], expectedStateIds, "state ids");
  exactSet(
    oracle.stateMachine.states.filter((row) => row.kind === "active").map((row) => row.id),
    expectedActiveStates,
    "active states",
  );
  for (const state of oracle.stateMachine.states) {
    if (state.kind === "active") requireText(state.activeEffect, state.id + " active effect");
    else exact(state.activeEffect, null, state.id + " stable effect");
  }
  exact(oracle.stateMachine?.owner, "PRINCIPAL-CLI", "state machine owner");
  requireText(oracle.stateMachine?.cancellation, "cancellation ownership", [
    "owner alone",
    "awaits",
  ]);
  const transitionIds = unique(oracle.stateMachine?.transitions, (row) => row.id, "transition ids");
  exactSet(
    [...transitionIds],
    Array.from({ length: 34 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
    "transition ids",
  );
  for (const transition of oracle.stateMachine.transitions) {
    const sources = Array.isArray(transition.from) ? transition.from : [transition.from];
    for (const source of sources) {
      if (!stateIds.has(source) && source !== "any-active-state") {
        fail(transition.id + " has unknown source " + source);
      }
    }
    if (transition.to !== undefined && !stateIds.has(transition.to)) {
      fail(transition.id + " has unknown target " + transition.to);
    }
    if (transition.to === undefined && transition.targetByRecoveryStep !== "recoveryResumeMap") {
      fail(transition.id + " has no constructive target");
    }
    requireText(transition.event, transition.id + " event");
    requireText(transition.guard, transition.id + " guard");
    requireText(transition.effect, transition.id + " effect");
    requireText(transition.postcondition, transition.id + " postcondition");
  }
  const resumeSteps = unique(
    oracle.stateMachine?.recoveryResumeMap,
    (row) => row.step,
    "recovery resume steps",
  );
  exact(resumeSteps.size, 13, "recovery resume step count");
  for (const row of oracle.stateMachine.recoveryResumeMap) {
    if (!stateIds.has(row.target)) fail(row.step + " maps to unknown state " + row.target);
    requireText(row.guard, row.step + " recovery guard");
  }
  const t25 = byId(oracle.stateMachine.transitions, "T25", "transition");
  exactSet(
    t25.from,
    [
      "usable-while-backfilling",
      "ready",
      "credentials-required",
      "keychain-unavailable-before-first-unlock",
      "authentication-blocked",
      "failed-with-recoverable-step",
    ],
    "T25 stable/recovery entry states",
  );
  requireText(t25.guard, "T25 failed-state reconciliation", [
    "PriorRecoveryAuthorityIncluded",
    "NoIndeterminateEffect",
  ]);
  requireText(t25.effect, "T25 journal-before-effect", [
    "before stop",
    "fsync",
    "complete exact",
    "atomically replace any prior failed transaction",
  ]);
  requireText(t25.postcondition, "T25 target closure", [
    "every prior active, pending, or old ref",
    "request identity",
  ]);
  const t28 = byId(oracle.stateMachine.transitions, "T28", "transition");
  exact(
    t28.guard,
    "daemonStoppedAndPlistAbsentAndEveryJournaledCredentialItemConfirmedAbsentAndBindingAbsentAndArchivePreservedAndCompletionReadyDurable",
    "T28 exact removal guard",
  );
  const t30 = byId(oracle.stateMachine.transitions, "T30", "transition");
  exact(t30.targetByRecoveryStep, "recoveryResumeMap", "T30 recovery map");
  if (Object.hasOwn(t30, "to")) fail("T30 must not carry a pseudo target");
  const t12 = byId(oracle.stateMachine.transitions, "T12", "transition");
  exact(
    [t12.event, t12.guard],
    [
      "authentication.finalUsernameRejected",
      "attemptBoundToLatestRevisionAndCandidateIsFullAddress",
    ],
    "final-candidate authentication block",
  );
  const t34 = byId(oracle.stateMachine.transitions, "T34", "transition");
  exact(
    [t34.event, t34.guard, t34.to],
    [
      "authentication.localPartRejected",
      "attemptBoundToLatestRevisionAndCandidateIsLocalPartAndSharedBudgetHasAnotherSession",
      "validating-authentication",
    ],
    "username candidate advance",
  );
  exact(
    [
      byId(oracle.stateMachine.transitions, "T10", "transition").from,
      byId(oracle.stateMachine.transitions, "T10", "transition").to,
    ],
    ["writing-nonsecret-configuration", "validating-authentication"],
    "prepare-to-validation ordering",
  );
  exact(
    [
      byId(oracle.stateMachine.transitions, "T18", "transition").from,
      byId(oracle.stateMachine.transitions, "T18", "transition").to,
    ],
    ["discovering-mailboxes", "writing-nonsecret-configuration"],
    "discovery-to-promotion ordering",
  );
  exact(
    [
      byId(oracle.stateMachine.transitions, "T20", "transition").from,
      byId(oracle.stateMachine.transitions, "T20", "transition").to,
    ],
    ["writing-nonsecret-configuration", "installing-starting-service"],
    "promotion-to-service ordering",
  );
  requireText(oracle.stateMachine?.runtimeGenerationGate?.releaseRule, "authBlocked release rule", [
    "Only a strictly newer",
    "cannot release",
  ]);
  requireText(oracle.stateMachine?.runtimeGenerationGate?.retryRule, "authBlocked retry rule", [
    "zero actors",
    "retry timers",
  ]);
  exactSet(
    oracle.stateMachine?.readiness?.usableWhileBackfilling,
    [
      "production authentication passed",
      "mailbox discovery normalized",
      "user LaunchAgent is generation-healthy",
      "one real search completed",
      "backfill progress remains visible",
    ],
    "usable readiness",
  );

  const recoveryIds = unique(oracle.recoveryOrderings, (row) => row.id, "recovery ids");
  exactSet(
    [...recoveryIds],
    Array.from({ length: 16 }, (_, index) => `REC-${String(index).padStart(2, "0")}`),
    "recovery ids",
  );
  for (const row of oracle.recoveryOrderings) {
    requireText(row.observed, row.id + " observed condition");
    requireText(row.action, row.id + " recovery action");
    requireText(row.postcondition, row.id + " postcondition");
  }
  requireText(
    byId(oracle.recoveryOrderings, "REC-04", "recovery").postcondition,
    "REC-04 ordering",
    ["no service install before validation"],
  );

  const removalCrashIds = unique(
    oracle.removalCrashOrderings,
    (row) => row.id,
    "removal crash ids",
  );
  exactSet(
    [...removalCrashIds],
    Array.from({ length: 18 }, (_, index) => `REM-${String(index).padStart(2, "0")}`),
    "removal crash ids",
  );
  for (const row of oracle.removalCrashOrderings) {
    requireText(row.crashPoint, row.id + " crash point");
    requireText(row.resumeAction, row.id + " resume action");
    requireText(row.postcondition, row.id + " postcondition");
  }
  requireText(byId(oracle.recoveryOrderings, "REC-08", "recovery").action, "REC-08 compensation", [
    "do not delete old item",
  ]);
  requireText(
    byId(oracle.recoveryOrderings, "REC-11", "recovery").postcondition,
    "REC-11 orphan handling",
    ["not silent"],
  );

  exact(
    oracle.connectionFactory?.name,
    "createProductionIcloudConnectionV1",
    "connection factory name",
  );
  exact(
    oracle.connectionFactory?.input?.additionalProperties,
    false,
    "connection input strictness",
  );
  exactSet(
    oracle.connectionFactory?.input?.required,
    ["accountId", "credentialRef", "credentialRevision", "purpose"],
    "connection input fields",
  );
  exact(
    oracle.connectionFactory?.input?.properties,
    {
      accountId: { const: "icloud-primary" },
      credentialRef: { pattern: "^amcred:v1:[A-Za-z0-9_-]{43}$" },
      credentialRevision: { type: "nonnegative-safe-integer" },
      purpose: { enum: ["validation", "sync"] },
    },
    "connection input properties",
  );
  exact(oracle.connectionFactory?.input?.passwordField, "forbidden", "connection password input");
  exact(
    oracle.connectionFactory?.output,
    {
      additionalProperties: false,
      required: ["purpose", "credentialRevision", "usernameForm", "clientHandle"],
      properties: {
        purpose: { enum: ["validation", "sync"] },
        credentialRevision: { type: "nonnegative-safe-integer" },
        usernameForm: { enum: ["local-part", "full-address"] },
        clientHandle: {
          const: "internal connected ImapFlow 1.7.1 handle with bounded cleanup ownership",
        },
      },
      forbidden: ["credentialRef", "password", "auth", "providerResponse"],
    },
    "connection output schema",
  );
  exact(
    oracle.connectionFactory?.validationOptions,
    {
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
      servername: "imap.mail.me.com",
      logger: false,
      logRaw: false,
      emitLogs: false,
      verifyOnly: false,
      includeMailboxes: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: true,
      qresync: false,
      "tls.rejectUnauthorized": true,
      "tls.minVersion": "TLSv1.2",
      connectionTimeout: 15000,
      greetingTimeout: 16000,
      socketTimeout: 30000,
    },
    "validation options",
  );
  exact(
    oracle.connectionFactory?.allowedValidationCommands,
    expectedAllowlist,
    "validation allowlist",
  );
  exact(
    oracle.connectionFactory?.forbiddenValidationCommands,
    expectedDenylist,
    "validation denylist",
  );
  exact(
    oracle.connectionFactory?.transientRetry,
    {
      maximumTransportAttempts: 3,
      budgetScope: "shared across local-part and full-address for one credential generation",
      delaysMilliseconds: [1000, 2000],
      authenticationRetriesAfterBlocked: 0,
    },
    "retry limits",
  );
  requireText(oracle.connectionFactory?.validationSequence, "validation sequence", [
    "listIcloudMailboxesReadOnly(client)",
    "constructively supplies listOnly:true",
    "before dispatch",
    "no general sync client",
  ]);
  const listTypeAuthority = oracle.connectionFactory?.listOnlyAuthority?.typeAuthority;
  exact(
    listTypeAuthority,
    {
      dependencyId: "IMAPFLOW-TYPES",
      observedDeclaration:
        "Installed ImapFlow 1.7.1 exports ListOptions without listOnly and declares ImapFlow.list(options?: ListOptions): Promise<ListResponse[]>.",
      owner: "MODULE-IMAP-SYNC-BRIDGE",
      helperPath: "packages/imap/src/icloud-list-only.ts",
      compileFixturePath: "packages/imap/test/icloud-list-only.compile.ts",
      optionsType: "ListOptions & { readonly listOnly: true }",
      helperSource: EXPECTED_LIST_ONLY_HELPER_SOURCE,
      compileFixtureSource: EXPECTED_LIST_ONLY_COMPILE_FIXTURE_SOURCE,
      compiler:
        "installed Vite+ 0.2.9 vp lint --type-aware --type-check against the repository node_modules and an exact strict noEmit Bundler-resolution tsconfig",
      forbiddenConstructs: EXPECTED_LIST_ONLY_FORBIDDEN_CONSTRUCTS,
      constructiveInvariant:
        'The exported function accepts only Pick<ImapFlow, "list">, constructs a typed IcloudListOnlyOptions variable with literal true, and passes that variable to a private forwardListOnly adapter accepting exactly ListOptions & { readonly listOnly: true }. There is no direct excess-property object-literal call and no escape hatch.',
    },
    "constructive listOnly type authority",
  );
  exact(
    oracle.connectionFactory?.listOnlyAuthority?.call,
    "listIcloudMailboxesReadOnly(client)",
    "listOnly adapter call",
  );
  const listTypeSources =
    listTypeAuthority.helperSource + "\n" + listTypeAuthority.compileFixtureSource;
  for (const [pattern, label] of [
    [/\bany\b/u, "any"],
    [/\bunknown\b/u, "unknown"],
    [/\bas\s+(?:const|[A-Za-z_$<{[])/u, "as type assertion"],
    [/=\s*<[A-Za-z_$][^>]*>/u, "angle-bracket type assertion"],
    [/declare\s+module/u, "module augmentation"],
    [/@ts-(?:ignore|expect-error)/u, "TypeScript diagnostic suppression"],
  ]) {
    if (pattern.test(listTypeSources)) fail("listOnly type authority contains " + label);
  }
  if (listTypeAuthority.helperSource.includes("client.list({")) {
    fail("listOnly helper uses a direct excess-property object-literal call");
  }
  requireText(
    oracle.connectionFactory?.listOnlyAuthority?.runtimeTranscript,
    "runtime transcript",
    [
      "exact IMAPFLOW-LIST hash",
      "all five capability branches",
      "exactly one LIST or XLIST",
      "no RETURN token, LSUB, or STATUS",
      "not production or live evidence",
    ],
  );
  exact(
    oracle.connectionFactory?.listOnlyAuthority?.capabilityBranches?.map((row) => row.id),
    [
      "LIST-BRANCH-SPECIAL-USE",
      "LIST-BRANCH-XLIST",
      "LIST-BRANCH-BASE",
      "LIST-BRANCH-EXTENDED",
      "LIST-BRANCH-REV2",
    ],
    "listOnly capability branches",
  );
  for (const branch of oracle.connectionFactory.listOnlyAuthority.capabilityBranches) {
    if (!["LIST", "XLIST"].includes(branch.command)) fail(branch.id + " has unsafe command");
    for (const denied of ["LSUB", "STATUS", "RETURN (SUBSCRIBED)"]) {
      if (!branch.forbiddenObserved.includes(denied)) fail(branch.id + " omits denial " + denied);
    }
    if (!branch.forbiddenObserved.includes("RETURN (...)")) {
      fail(branch.id + " omits denial RETURN (...)");
    }
  }
  exact(
    oracle.connectionFactory?.errorCategories?.map((row) => [row.id, row.outcome]),
    expectedAuthCategories,
    "authentication categories",
  );
  requireText(oracle.connectionFactory?.logging, "connection logging", [
    "No ImapFlow logger",
    "provider exception text",
  ]);
  requireText(oracle.connectionFactory?.lifetime, "credential lifetime", [
    "deletes auth.pass",
    "never retains",
  ]);

  exact(oracle.operationAuthority?.registry, "localAccountOperationRegistryV1", "local registry");
  exact(oracle.operationAuthority?.publicRegistryMembership, false, "public registry membership");
  exact(oracle.operationAuthority?.openApiMembership, false, "OpenAPI membership");
  exact(oracle.operationAuthority?.httpDispatch, false, "HTTP dispatch");
  exact(
    oracle.operationAuthority?.requestEnvelopeSchema?.additionalProperties,
    false,
    "local request strictness",
  );
  exactSet(
    oracle.operationAuthority?.requestEnvelopeSchema?.required,
    ["version", "operation", "requestId", "requestNonce", "payload"],
    "local request envelope fields",
  );
  exactSet(
    Object.keys(oracle.operationAuthority?.requestEnvelopeSchema?.properties ?? {}),
    oracle.operationAuthority?.requestEnvelopeSchema?.required,
    "local request envelope property closure",
  );
  const operationIds = unique(
    oracle.operationAuthority?.operations,
    (row) => row.id,
    "operation ids",
  );
  const operationKeys = unique(
    oracle.operationAuthority?.operations,
    (row) => row.key,
    "operation keys",
  );
  exact(
    oracle.operationAuthority.operations.map((row) => [
      row.id,
      row.key,
      row.command,
      row.successSchema,
    ]),
    expectedOperationRows,
    "local operation rows",
  );
  const resultSchemaIds = unique(
    oracle.operationAuthority?.resultSchemas,
    (row) => row.id,
    "result schema ids",
  );
  exactSet(
    [...resultSchemaIds],
    ["AccountUsableResultV1", "AccountStatusResultV1", "AccountRemovedResultV1", "AccountErrorV1"],
    "result schema ids",
  );
  for (const schema of oracle.operationAuthority.resultSchemas) {
    exact(schema.additionalProperties, false, schema.id + " strictness");
    exactSet(
      Object.keys(schema.properties ?? {}),
      schema.required,
      schema.id + " exact properties",
    );
    if (!schema.forbidden.includes("password")) fail(schema.id + " does not forbid password");
  }
  exactSet(
    byId(oracle.operationAuthority.resultSchemas, "AccountErrorV1", "result schema").required,
    ["version", "kind", "operation", "requestId", "code", "message", "details"],
    "AccountErrorV1 required fields",
  );
  exact(
    oracle.operationAuthority?.errors?.map((row) => [
      row.code,
      row.semanticKind,
      row.exitCode,
      row.fixedMessage,
      row.detailsRequired,
      row.applies,
    ]),
    expectedErrorRows,
    "local error authority",
  );
  const errorCodes = unique(
    oracle.operationAuthority?.errors,
    (row) => row.code,
    "local error codes",
  );
  for (const operation of oracle.operationAuthority.operations) {
    exact(operation.payload?.additionalProperties, false, operation.key + " payload strictness");
    exactSet(
      Object.keys(operation.payload?.properties ?? {}),
      operation.payload?.required,
      operation.key + " exact payload",
    );
    for (const forbidden of ["password", "secret", "credentialBytes"]) {
      if (Object.hasOwn(operation.payload?.properties ?? {}, forbidden)) {
        fail(operation.key + " payload transports " + forbidden);
      }
    }
    if (!resultSchemaIds.has(operation.successSchema))
      fail(operation.key + " references unknown success schema");
    requireReferences(operation.errors, errorCodes, operation.key + " errors");
    exact(
      operation.errors,
      oracle.operationAuthority.errors
        .filter(
          (error) =>
            error.applies.includes("all-local-account-operations") ||
            error.applies.includes(operation.key),
        )
        .map((error) => error.code),
      operation.key + " error applicability parity",
    );
  }
  for (const error of oracle.operationAuthority.errors) {
    exact(error.additionalProperties, false, error.code + " detail strictness");
    exact(error.detailsAllowed, error.detailsRequired, error.code + " detail allowlist");
    exactSet(
      Object.keys(error.detailsProperties ?? {}),
      error.detailsRequired,
      error.code + " detail properties",
    );
    requireText(error.fixedMessage, error.code + " fixed message");
    if (!Array.isArray(error.applies) || error.applies.length === 0)
      fail(error.code + " has no applicability");
    for (const target of error.applies) {
      if (target !== "all-local-account-operations" && !operationKeys.has(target)) {
        fail(error.code + " applies to unknown operation " + target);
      }
    }
  }
  requireText(oracle.operationAuthority?.setupOrchestration, "setup orchestration", [
    "owns no credential capture",
  ]);
  requireText(oracle.operationAuthority?.guidedStructuredParity, "guided/structured parity", [
    "same request",
    "no plaintext",
  ]);

  requireText(oracle.removalRestoreAuthority?.daemonUninstall, "daemon uninstall", [
    "preserves",
    "Keychain",
    "Apple",
  ]);
  requireText(oracle.removalRestoreAuthority?.accountRemove, "account remove", [
    "archive",
    "not-performed",
  ]);
  requireText(oracle.removalRestoreAuthority?.appleRevocation, "Apple revocation", [
    "Manual",
    "never",
  ]);
  requireText(oracle.removalRestoreAuthority?.emptyOrDifferentDeviceRestore, "restore behavior", [
    "credentials-required",
  ]);
  exactSet(
    oracle.removalRestoreAuthority?.removalProtocol?.entryStates,
    [
      "usable-while-backfilling",
      "ready",
      "credentials-required",
      "keychain-unavailable-before-first-unlock",
      "authentication-blocked",
      "failed-with-recoverable-step",
    ],
    "removal stable/recovery entry states",
  );
  exact(
    oracle.removalRestoreAuthority?.removalProtocol?.orderedSteps?.map((row) => row.id),
    Array.from({ length: 6 }, (_, index) => `REMOVE-${String(index + 1).padStart(2, "0")}`),
    "removal step ids",
  );
  for (const row of oracle.removalRestoreAuthority.removalProtocol.orderedSteps) {
    requireText(row.guard, row.id + " guard");
    requireText(row.effect, row.id + " effect");
    requireText(row.postcondition, row.id + " postcondition");
  }
  requireText(oracle.removalRestoreAuthority?.removalProtocol?.failureRule, "removal failure", [
    "entire target record",
    "active binding is retained",
    "never erased",
  ]);
  requireText(
    oracle.removalRestoreAuthority?.removalProtocol?.noTargetsRule,
    "empty removal targets",
    ["any listed entry state", "no active, pending, or old ref", "without enumeration"],
  );
  exact(
    oracle.demoIsolation?.mode,
    "compile-time/provider-graph separation plus runtime marker",
    "demo isolation mode",
  );
  if (oracle.demoIsolation?.rules?.length !== 6) fail("demo isolation rule count differs");
  requireText(oracle.demoIsolation.rules.join("\n"), "demo isolation rules", [
    "cannot import",
    "zero SecItem",
    "neither mode falls back",
  ]);

  const proofGroupIds = new Set(Object.keys(oracle.proofMatrices ?? {}));
  exactSet([...proofGroupIds], Object.keys(expectedProofCounts), "proof groups");
  const proofs = Object.values(oracle.proofMatrices).flat();
  const proofIds = unique(proofs, (row) => row.id, "proof ids");
  for (const [group, count] of Object.entries(expectedProofCounts)) {
    exact(oracle.proofMatrices[group].length, count, group + " proof count");
  }
  exact(proofs.length, 94, "total proof count");
  for (const proof of proofs) {
    if (!["positive", "negative"].includes(proof.polarity))
      fail(proof.id + " has invalid polarity");
    requireText(proof.case, proof.id + " case");
    requireText(proof.postcondition, proof.id + " observable postcondition");
    requireText(proof.tier, proof.id + " tier");
  }

  const threatAssetIds = unique(oracle.threatModel?.assets, (row) => row.id, "threat asset ids");
  exactSet([...threatAssetIds], expectedThreatAssetIds, "threat asset ids");
  for (const asset of oracle.threatModel.assets) {
    requireText(asset.description, asset.id + " description");
  }
  const attackerIds = unique(
    oracle.threatModel?.attackerCapabilities,
    (row) => row.id,
    "attacker capability ids",
  );
  exact(
    oracle.threatModel.attackerCapabilities.map((row) => [row.id, row.treatment]),
    expectedAttackerRows,
    "attacker capability treatments",
  );
  for (const attacker of oracle.threatModel.attackerCapabilities) {
    requireText(attacker.capability, attacker.id + " capability");
  }
  const trustBoundaryIds = unique(
    oracle.threatModel?.trustBoundaries,
    (row) => row.id,
    "trust boundary ids",
  );
  exactSet([...trustBoundaryIds], expectedTrustBoundaryIds, "trust boundary ids");
  const referencedThreatAssets = new Set();
  const referencedThreatProofGroups = new Set();
  for (const boundary of oracle.threatModel.trustBoundaries) {
    requireText(boundary.from, boundary.id + " source");
    requireText(boundary.to, boundary.id + " destination");
    requireReferences(boundary.assets, threatAssetIds, boundary.id + " assets");
    requireReferences(boundary.proofGroups, proofGroupIds, boundary.id + " proof groups");
    if (!Array.isArray(boundary.controls) || boundary.controls.length === 0) {
      fail(boundary.id + " controls are empty");
    }
    for (const [index, control] of boundary.controls.entries()) {
      requireText(control, boundary.id + " control " + index);
    }
    for (const asset of boundary.assets) referencedThreatAssets.add(asset);
    for (const group of boundary.proofGroups) referencedThreatProofGroups.add(group);
  }
  exactSet([...referencedThreatAssets], [...threatAssetIds], "trust-boundary asset closure");
  exactSet(
    [...referencedThreatProofGroups],
    [...proofGroupIds],
    "trust-boundary proof-group closure",
  );
  exact(oracle.threatModel?.limits?.length, 4, "threat-model limit count");
  requireText(oracle.threatModel.limits.join("\n"), "threat-model limits", [
    "same-user",
    "Developer ID",
    "local administrator",
    "separately authorized live",
  ]);

  const evidenceIds = unique(oracle.evidenceTiers, (row) => row.id, "evidence tier ids");
  exact(
    oracle.evidenceTiers.map((row) => [row.id, row.status]),
    expectedEvidenceRows,
    "evidence tiers",
  );
  for (const row of oracle.evidenceTiers) {
    requireText(row.mayClaim, row.id + " mayClaim");
    requireText(row.cannotClaim, row.id + " cannotClaim");
  }

  const requirementIds = unique(oracle.requirements, (row) => row.id, "requirement ids");
  exactSet(
    [...requirementIds],
    Array.from({ length: 10 }, (_, index) => `REQ-CRED-${String(index + 1).padStart(2, "0")}`),
    "requirement ids",
  );
  const decisionIds = unique(oracle.decisions, (row) => row.id, "decision ids");
  exactSet(
    [...decisionIds],
    Array.from({ length: 22 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`),
    "decision ids",
  );
  const rejectedIds = unique(
    oracle.rejectedAlternatives,
    (row) => row.id,
    "rejected alternative ids",
  );
  exactSet(
    [...rejectedIds],
    Array.from({ length: 20 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
    "rejected alternative ids",
  );
  const mutationIds = unique(oracle.mutationTests, (row) => row.id, "mutation ids");
  exactSet([...mutationIds], expectedMutationIds, "mutation ids");
  exactSet(Object.keys(oracle.coverage ?? {}), [...requirementIds], "coverage keys");
  for (const [requirementId, coverage] of Object.entries(oracle.coverage)) {
    requireReferences(coverage.decisions, decisionIds, requirementId + " decisions");
    requireReferences(coverage.proofGroups, proofGroupIds, requirementId + " proof groups");
    requireReferences(coverage.mutations, mutationIds, requirementId + " mutations");
  }

  const shieldIds = unique(oracle.planningShieldApplicability, (row) => row.id, "shield ids");
  exactSet(
    [...shieldIds],
    Array.from({ length: 12 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
    "shield ids",
  );
  for (const row of oracle.planningShieldApplicability) {
    exact(row.status, "required", row.id + " applicability");
    requireText(row.reason, row.id + " reason");
  }

  const planningRowIds = unique(oracle.planningRows, (row) => row.id, "planning row ids");
  exactSet(
    [...planningRowIds],
    Array.from({ length: 8 }, (_, index) => `CRED-${String(index + 1).padStart(2, "0")}`),
    "planning rows",
  );
  for (const row of oracle.planningRows) {
    for (const field of ["defect", "invariant", "owner", "proof"])
      requireText(row[field], row.id + " " + field);
  }

  const moduleIds = unique(oracle.moduleOwnership, (row) => row.id, "module ownership ids");
  exactSet(
    [...moduleIds],
    [
      "MODULE-SIGNED-BROKER-KEYCHAIN",
      "MODULE-ACTOR-JOURNAL",
      "MODULE-IMAP-SYNC-BRIDGE",
      "MODULE-LOCAL-COMMAND-ADAPTER",
      "MODULE-QUALIFICATION-READ-ONLY",
    ],
    "module ownership ids",
  );
  const imapModule = byId(oracle.moduleOwnership, "MODULE-IMAP-SYNC-BRIDGE", "module ownership");
  for (const path of [
    oracle.connectionFactory.listOnlyAuthority.typeAuthority.helperPath,
    oracle.connectionFactory.listOnlyAuthority.typeAuthority.compileFixturePath,
  ]) {
    const owners = oracle.moduleOwnership.filter((module) =>
      module.paths.some(
        (entry) =>
          (entry.kind === "file" && entry.path === path) ||
          (entry.kind === "prefix" && path.startsWith(entry.path)),
      ),
    );
    exact(
      owners.map((module) => module.id),
      [imapModule.id],
      path + " exact downstream owner",
    );
  }
  const ownedPaths = [];
  for (const module of oracle.moduleOwnership) {
    requireText(module.responsibility, module.id + " responsibility");
    requireText(module.forbidden, module.id + " forbidden responsibility");
    if (!Array.isArray(module.paths) || module.paths.length === 0)
      fail(module.id + " owns no paths");
    for (const entry of module.paths) {
      if (!["file", "prefix"].includes(entry.kind)) fail(module.id + " has invalid path kind");
      requireText(entry.path, module.id + " path");
      if (entry.path.startsWith("/") || entry.path.includes(".."))
        fail(module.id + " path escapes repo");
      ownedPaths.push({ module: module.id, ...entry });
    }
  }
  for (let leftIndex = 0; leftIndex < ownedPaths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ownedPaths.length; rightIndex += 1) {
      const left = ownedPaths[leftIndex];
      const right = ownedPaths[rightIndex];
      const overlap =
        left.path === right.path ||
        (left.kind === "prefix" && right.path.startsWith(left.path)) ||
        (right.kind === "prefix" && left.path.startsWith(right.path));
      if (overlap) fail("module ownership overlap: " + left.module + " and " + right.module);
    }
  }

  const downstreamIds = unique(oracle.downstreamIssues, (row) => row.id, "downstream ids");
  exact(
    oracle.downstreamIssues.map((row) => [row.id, row.kind, row.reasoningEffort]),
    expectedDownstreamRows,
    "downstream rows",
  );
  for (const row of oracle.downstreamIssues) {
    exact(row.worker, "luna_worker", row.id + " worker");
    if (!Array.isArray(row.dependsOn) || !Array.isArray(row.owns) || !Array.isArray(row.must))
      fail(row.id + " contract is incomplete");
    requireText(row.exit, row.id + " exit gate");
  }
  for (const module of oracle.moduleOwnership) {
    if (!downstreamIds.has(module.owner)) fail(module.id + " has unknown downstream owner");
    const owner = byId(oracle.downstreamIssues, module.owner, "downstream owner");
    if (!owner.owns.includes(module.id)) fail(module.id + " is absent from its downstream owner");
  }
  const assignedModules = oracle.downstreamIssues.flatMap((row) =>
    row.owns.filter((value) => value.startsWith("MODULE-")),
  );
  exactSet(assignedModules, [...moduleIds], "downstream module assignment closure");
  exactSet(
    oracle.heldIssueAddenda.map((row) => row.issue),
    [153, 167, 168, 171, 175, 177, 183, 185, 215, 217, 221],
    "held issue addenda",
  );
  const addendumIds = unique(oracle.heldIssueAddenda, (row) => row.id, "addendum ids");
  for (const row of oracle.heldIssueAddenda) requireText(row.mustAdd, row.id + " text");

  exactSet(
    oracle.issueEvidence.map((row) => row.issue),
    [235, 236, 153, 167, 168, 171, 175, 177, 183, 185, 203, 204, 213, 214, 215, 217, 221],
    "issue evidence set",
  );
  exact(
    oracle.issueEvidenceDigestMethod,
    "SHA-256 of the exact UTF-8 GitHub API body string for the URL target, with no added newline; issue URLs target the issue body and issuecomment fragments target that comment body",
    "issue evidence digest method",
  );
  exact(
    oracle.issueEvidence.map((row) => [
      row.issue,
      row.contentKind,
      row.contentSha256,
      row.contentUpdatedAt,
    ]),
    expectedIssueEvidenceRows,
    "issue evidence content pins",
  );
  for (const row of oracle.issueEvidence) {
    exact(
      row.state,
      [203, 204, 213, 214].includes(row.issue) ? "CLOSED" : "OPEN",
      "issue " + row.issue + " state",
    );
    requireText(row.role, "issue " + row.issue + " role");
    if (!/^[a-f0-9]{64}$/.test(row.contentSha256)) {
      fail("issue " + row.issue + " content digest is invalid");
    }
    const issueUrl = "https://github.com/johnlombardo-dev/agent-mail/issues/" + row.issue;
    if (row.contentKind.startsWith("issue-comment:")) {
      const commentId = row.contentKind.slice("issue-comment:".length);
      exact(
        row.url,
        issueUrl + "#issuecomment-" + commentId,
        "issue " + row.issue + " comment URL",
      );
    } else {
      exact(row.contentKind, "issue-body", "issue " + row.issue + " content kind");
      exact(row.url, issueUrl, "issue " + row.issue + " URL");
    }
    exact(row.fetchedAt, "2026-08-19", "issue " + row.issue + " fetch date");
  }

  const appleIds = unique(oracle.appleSources, (row) => row.id, "Apple source ids");
  exactSet(
    [...appleIds],
    [
      "APPLE-IMAP",
      "APPLE-APP-PASSWORD",
      "APPLE-THIRD-PARTY",
      "APPLE-TN3137",
      "APPLE-AFTER-FIRST-UNLOCK",
      "APPLE-DP-KEYCHAIN",
      "APPLE-KEYCHAIN-SERVICES",
      "APPLE-SIGNING",
      "APPLE-DAEMON-BUNDLE",
      "APPLE-XPC",
      "APPLE-XPC-GUIDANCE",
    ],
    "Apple source ids",
  );
  for (const row of oracle.appleSources) {
    requireText(row.url, row.id + " URL", [
      row.id.startsWith("APPLE-IMAP") || row.id.includes("PASSWORD") || row.id.includes("THIRD")
        ? "support.apple.com"
        : "developer.apple.com",
    ]);
    exact(row.retrieved, "2026-08-19", row.id + " retrieval date");
    if (!Array.isArray(row.claims) || row.claims.length === 0) fail(row.id + " has no claims");
  }
  exact(
    byId(oracle.appleSources, "APPLE-IMAP", "Apple source").published,
    "2026-02-03",
    "Apple IMAP publication date",
  );
  exact(
    byId(oracle.appleSources, "APPLE-APP-PASSWORD", "Apple source").published,
    "2025-10-08",
    "Apple app-password publication date",
  );
  exact(
    byId(oracle.appleSources, "APPLE-KEYCHAIN-SERVICES", "Apple source"),
    {
      id: "APPLE-KEYCHAIN-SERVICES",
      url: "https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain",
      published: "undated-current-documentation",
      retrieved: "2026-08-19",
      claims: [
        "SecItemAdd creates a password item from an explicit query",
        "kSecClassGenericPassword is appropriate when Internet-password-only attributes are unnecessary",
        "generic password items do not have kSecAttrServer",
      ],
    },
    "Apple generic-password source",
  );

  const dependencyIds = unique(oracle.dependencyPins, (row) => row.id, "dependency pin ids");
  exactSet(
    [...dependencyIds],
    [
      "IMAPFLOW-PACKAGE",
      "IMAPFLOW-TYPES",
      "IMAPFLOW-RUNTIME",
      "IMAPFLOW-LOGIN",
      "IMAPFLOW-AUTHENTICATE",
      "IMAPFLOW-LIST",
    ],
    "dependency pin ids",
  );
  for (const row of oracle.dependencyPins) exact(row.version, "1.7.1", row.id + " version");
  exact(
    byId(oracle.dependencyPins, "IMAPFLOW-TYPES", "dependency pin"),
    {
      id: "IMAPFLOW-TYPES",
      path: "node_modules/imapflow/lib/imap-flow.d.ts",
      version: "1.7.1",
      sha256: "ff06d0d933bfcbb3aa3a5fd88a45f242111d8bc01c725d5430ee1bfae8edb6e3",
      observed:
        "ListOptions omits listOnly while ImapFlow.list accepts options?: ListOptions and returns Promise<ListResponse[]>; the owned constructive intersection adapter and real compile fixture are required.",
    },
    "ImapFlow declaration pin",
  );
  exact(
    oracle.authorityPins?.issue203OracleSha256,
    "8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7",
    "issue 203 oracle pin",
  );
  exact(
    oracle.authorityPins?.issue213BaseOracleSha256,
    "d0f569cbb3364bebbf3e02ef33b69997a05b4bf6d5dd9485cf386e8ab7768c6d",
    "issue 213 base oracle pin",
  );

  unique(oracle.frozenInputs, (row) => row.id, "frozen input ids");
  unique(oracle.frozenInputs, (row) => row.path, "frozen input paths");
  exact(oracle.frozenInputs.length, 17, "frozen input count");
  exactSet(
    oracle.protectedScope?.ownedFiles,
    [
      "docs/architecture/icloud-credential-authority-oracle.v1.json",
      "docs/architecture/icloud-credential-authority-check.v1.mjs",
      "docs/architecture/icloud-credential-authority-design.v1.md",
      "docs/architecture/icloud-credential-authority-decisions.v1.md",
      "docs/architecture/icloud-credential-authority-coverage.v1.md",
    ],
    "owned files",
  );
  requireText(oracle.evidenceLimit, "evidence limit", [
    "exact embedded TypeScript compile fixture",
    "isolated installed ImapFlow list-command transcript",
    "No production adapter",
    "live IMAP session",
  ]);
  exact(authorityDigests(oracle), EXPECTED_AUTHORITY_SHA256, "exact authority schema digests");

  return {
    stateIds,
    transitionIds,
    recoveryIds,
    removalCrashIds,
    proofIds,
    proofGroupIds,
    evidenceIds,
    requirementIds,
    decisionIds,
    mutationIds,
    shieldIds,
    planningRowIds,
    downstreamIds,
    moduleIds,
    addendumIds,
    operationIds,
    threatAssetIds,
    attackerIds,
    trustBoundaryIds,
  };
}

function validateFrozenInputs(oracle, strict) {
  const drift = [];
  for (const input of oracle.frozenInputs) {
    exact(input.gitCommit, ACCEPTED_HEAD, input.id + " commit");
    const committed = readCommitted(input.path, input.gitCommit);
    exact(sha256(committed), input.sha256, input.id + " committed digest");
    const currentPath = join(repositoryRoot, input.path);
    const current = existsSync(currentPath) ? sha256(readFileSync(currentPath)) : null;
    if (current !== input.sha256)
      drift.push({ id: input.id, path: input.path, expected: input.sha256, current });
  }
  if (strict && drift.length > 0)
    fail("strict source drift: " + drift.map((row) => row.id).join(", "));
  return drift;
}

function validateDependencies(oracle, strict) {
  const drift = [];
  for (const input of oracle.dependencyPins) {
    const currentPath = join(repositoryRoot, input.path);
    const current = existsSync(currentPath) ? sha256(readFileSync(currentPath)) : null;
    if (current !== input.sha256)
      drift.push({ id: input.id, path: input.path, expected: input.sha256, current });
  }
  if (strict && drift.length > 0)
    fail("strict dependency drift: " + drift.map((row) => row.id).join(", "));
  return drift;
}

function runTypeCompile(helperPath, compileFixturePath, tsconfigPath) {
  return execFileSync(
    join(repositoryRoot, "node_modules/.bin/vp"),
    [
      "lint",
      "--type-aware",
      "--type-check",
      "--tsconfig=" + tsconfigPath,
      "--no-ignore",
      "-A",
      "all",
      helperPath,
      compileFixturePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function validateListOnlyCompileFixture(oracle) {
  const authority = oracle.connectionFactory.listOnlyAuthority.typeAuthority;
  const declarationPin = byId(oracle.dependencyPins, authority.dependencyId, "dependency pin");
  exact(
    sha256(readFileSync(join(repositoryRoot, declarationPin.path))),
    declarationPin.sha256,
    "compile fixture declaration digest",
  );
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agent-mail-icloud-list-types-"));
  const helperPath = join(fixtureRoot, "icloud-list-only.ts");
  const compileFixturePath = join(fixtureRoot, "icloud-list-only.compile.ts");
  const tsconfigPath = join(fixtureRoot, "tsconfig.json");
  try {
    symlinkSync(join(repositoryRoot, "node_modules"), join(fixtureRoot, "node_modules"), "dir");
    writeFileSync(helperPath, authority.helperSource, "utf8");
    writeFileSync(compileFixturePath, authority.compileFixtureSource, "utf8");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: "ESNext",
            module: "Preserve",
            moduleResolution: "Bundler",
          },
          files: ["icloud-list-only.ts", "icloud-list-only.compile.ts"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    try {
      runTypeCompile(helperPath, compileFixturePath, tsconfigPath);
    } catch (error) {
      const diagnostic = [error?.stderr, error?.stdout, error?.message]
        .filter(Boolean)
        .map(String)
        .join("\n")
        .slice(0, 4000);
      fail("constructive listOnly compile fixture failed: " + diagnostic);
    }

    const removalNeedle = "const options: IcloudListOnlyOptions = { listOnly: true };";
    const removalMutation = authority.helperSource.replace(
      removalNeedle,
      "const options: IcloudListOnlyOptions = {};",
    );
    if (removalMutation === authority.helperSource) {
      fail("listOnly compile negative control could not remove the property");
    }
    writeFileSync(helperPath, removalMutation, "utf8");
    let removalRejected = false;
    let removalDiagnostic = "";
    try {
      runTypeCompile(helperPath, compileFixturePath, tsconfigPath);
    } catch (error) {
      removalRejected = true;
      removalDiagnostic = [error?.stderr, error?.stdout, error?.message]
        .filter(Boolean)
        .map(String)
        .join("\n");
    }
    if (!removalRejected) fail("listOnly compile negative control unexpectedly passed");
    if (
      !removalDiagnostic.includes("typescript(TS2322)") ||
      !removalDiagnostic.includes("IcloudListOnlyOptions")
    ) {
      fail(
        "listOnly compile negative control failed without the exact type diagnostic: " +
          removalDiagnostic.slice(0, 4000),
      );
    }

    return {
      compiler: "Vite+ 0.2.9 vp lint --type-aware --type-check",
      dependencyId: authority.dependencyId,
      helperPath: authority.helperPath,
      compileFixturePath: authority.compileFixturePath,
      positive: "passed",
      removedListOnlyControl: "rejected",
      removedListOnlyDiagnostic: "typescript(TS2322) names IcloudListOnlyOptions",
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function collectArgumentAtoms(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentAtoms(item, output);
    return output;
  }
  if (value && typeof value === "object" && typeof value.value === "string") {
    output.push(value.value);
  }
  return output;
}

async function validateListOnlyRuntimeTranscript(oracle) {
  const runtimePin = byId(oracle.dependencyPins, "IMAPFLOW-LIST", "dependency pin");
  exact(
    sha256(readFileSync(join(repositoryRoot, runtimePin.path))),
    runtimePin.sha256,
    "runtime transcript list-command digest",
  );
  const requireFromChecker = createRequire(import.meta.url);
  const listCommand = requireFromChecker(
    join(repositoryRoot, "node_modules/imapflow/lib/commands/list.js"),
  );
  const transcript = [];
  for (const branch of oracle.connectionFactory.listOnlyAuthority.capabilityBranches) {
    const observed = [];
    const connection = {
      capabilities: new Map(branch.capabilities.map((capability) => [capability, true])),
      enabled: new Set(),
      namespace: { prefix: "", delimiter: "/" },
      log: { warn() {}, debug() {} },
      id: "list-only-runtime-fixture",
      async exec(command, arguments_) {
        observed.push({ command, argumentAtoms: collectArgumentAtoms(arguments_) });
        return { next() {} };
      },
    };
    for (const capability of branch.absentCapabilities ?? []) {
      if (connection.capabilities.has(capability)) {
        fail(branch.id + " runtime fixture contains forbidden capability " + capability);
      }
    }
    const rows = await listCommand(connection, "", "*", { listOnly: true });
    exact(rows, [], branch.id + " runtime fixture result");
    exact(observed.length, 1, branch.id + " runtime command count");
    exact(observed[0].command, branch.command, branch.id + " runtime command");
    if (observed[0].argumentAtoms.includes("RETURN")) {
      fail(branch.id + " runtime transcript contains RETURN");
    }
    if (["LSUB", "STATUS"].includes(observed[0].command)) {
      fail(branch.id + " runtime transcript contains a forbidden command");
    }
    transcript.push({
      id: branch.id,
      capabilities: branch.capabilities,
      command: observed[0].command,
      commandCount: observed.length,
      returnTokenCount: observed[0].argumentAtoms.filter((value) => value === "RETURN").length,
      resultRows: rows.length,
    });
  }
  exact(transcript.length, 5, "runtime transcript branch count");
  return transcript;
}

function renderProjectionHeader(title, oracleDigest) {
  return [
    "# " + title,
    "",
    "> Generated by `icloud-credential-authority-check.v1.mjs --write-views`. Do not edit by hand.",
    "> Normative source: [icloud-credential-authority-oracle.v1.json](./icloud-credential-authority-oracle.v1.json)",
    "> Oracle SHA-256: `" + oracleDigest + "`",
    "",
  ].join("\n");
}

function renderJsonSection(title, value) {
  return ["## " + title, "", "```json", JSON.stringify(value, null, 2), "```", ""].join("\n");
}

function renderDesign(oracle, oracleDigest) {
  const sections = [
    ["Normative authority", { oracle: oracle.oracle, executionProfile: oracle.executionProfile }],
    [
      "Product and provider",
      { productBoundary: oracle.productBoundary, provider: oracle.provider },
    ],
    [
      "Platform and signed bundle",
      { platform: oracle.platform, bundleTopology: oracle.bundleTopology },
    ],
    ["Keychain authority", oracle.keychainAuthority],
    ["Authenticated local administration", oracle.localAdministration],
    [
      "Secret and configuration authority",
      {
        secretAuthority: oracle.secretAuthority,
        configurationAuthority: oracle.configurationAuthority,
      },
    ],
    ["Lifecycle state machine", oracle.stateMachine],
    [
      "Recovery and removal",
      {
        recoveryOrderings: oracle.recoveryOrderings,
        removalRestoreAuthority: oracle.removalRestoreAuthority,
        removalCrashOrderings: oracle.removalCrashOrderings,
      },
    ],
    ["Production iCloud connection", oracle.connectionFactory],
    ["Local operation authority", oracle.operationAuthority],
    ["Module ownership", oracle.moduleOwnership],
    [
      "Demo isolation and threat model",
      { demoIsolation: oracle.demoIsolation, threatModel: oracle.threatModel },
    ],
    [
      "Evidence authority",
      {
        evidenceTiers: oracle.evidenceTiers,
        evidenceLimit: oracle.evidenceLimit,
        remainingConsequentialChoices: oracle.remainingConsequentialChoices,
      },
    ],
  ];
  return (
    renderProjectionHeader("iCloud credential authority V1 design", oracleDigest) +
    sections.map(([title, value]) => renderJsonSection(title, value)).join("\n")
  );
}

function renderDecisions(oracle, oracleDigest) {
  const decisions = oracle.decisions
    .map((row) => `- **${row.id}** ${row.decision}\n\n  Reason: ${row.reason}`)
    .join("\n\n");
  const rejected = oracle.rejectedAlternatives
    .map((row) => `- **${row.id}** ${row.alternative}\n\n  Rejected because: ${row.reason}.`)
    .join("\n\n");
  return [
    renderProjectionHeader("iCloud credential authority V1 decisions", oracleDigest),
    "## Accepted decisions",
    "",
    decisions,
    "",
    "## Rejected alternatives",
    "",
    rejected,
    "",
  ].join("\n");
}

function renderCoverage(oracle, oracleDigest) {
  const sections = [
    [
      "Requirements and traceability",
      { requirements: oracle.requirements, coverage: oracle.coverage },
    ],
    [
      "Constructive transitions",
      {
        transitions: oracle.stateMachine.transitions,
        recoveryResumeMap: oracle.stateMachine.recoveryResumeMap,
      },
    ],
    ["Recovery orderings", oracle.recoveryOrderings],
    ["Removal crash orderings", oracle.removalCrashOrderings],
    ["Constructive proof matrices", oracle.proofMatrices],
    ["Checker self-mutations", oracle.mutationTests],
    [
      "Planning shields and rows",
      {
        planningShieldApplicability: oracle.planningShieldApplicability,
        planningRows: oracle.planningRows,
      },
    ],
    [
      "Module and downstream issue ownership",
      { moduleOwnership: oracle.moduleOwnership, downstreamIssues: oracle.downstreamIssues },
    ],
    ["Held issue addenda", oracle.heldIssueAddenda],
    ["Threat-boundary coverage", oracle.threatModel],
    [
      "Evidence tiers and sources",
      {
        evidenceTiers: oracle.evidenceTiers,
        issueEvidence: oracle.issueEvidence,
        appleSources: oracle.appleSources,
        dependencyPins: oracle.dependencyPins,
      },
    ],
  ];
  return (
    renderProjectionHeader("iCloud credential authority V1 coverage", oracleDigest) +
    sections.map(([title, value]) => renderJsonSection(title, value)).join("\n")
  );
}

function formatMarkdownProjection(value, filename) {
  try {
    return execFileSync(
      join(repositoryRoot, "node_modules/.bin/vp"),
      ["fmt", "--stdin-filepath=" + filename],
      { cwd: repositoryRoot, input: value, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    fail("cannot format generated Markdown projection " + filename);
  }
}

function renderViews(oracle, oracleDigest) {
  return [
    formatMarkdownProjection(
      renderDesign(oracle, oracleDigest),
      "icloud-credential-authority-design.v1.md",
    ),
    formatMarkdownProjection(
      renderDecisions(oracle, oracleDigest),
      "icloud-credential-authority-decisions.v1.md",
    ),
    formatMarkdownProjection(
      renderCoverage(oracle, oracleDigest),
      "icloud-credential-authority-coverage.v1.md",
    ),
  ];
}

function requireGeneratedBytes(actual, expected, label) {
  if (!actual.equals(expected)) fail(label + " differs byte-for-byte from generated projection");
}

function validateViews(oracle, oracleDigest, authorities, writeViews) {
  const generated = renderViews(oracle, oracleDigest).map((view) => Buffer.from(view, "utf8"));
  if (writeViews) {
    for (const [index, path] of viewPaths.entries()) writeFileSync(path, generated[index]);
  }
  const views = viewPaths.map((path) => readFileSync(path));
  for (const [index, view] of views.entries()) {
    requireGeneratedBytes(view, generated[index], "view " + index);
  }
  if (!writeViews)
    exact(
      views.map((view) => sha256(view)),
      EXPECTED_VIEW_SHA256,
      "checked view digests",
    );
  for (const [index, bytes] of views.entries()) {
    const view = bytes.toString("utf8");
    if (!view.includes("icloud-credential-authority-oracle.v1.json"))
      fail("view " + index + " omits the oracle link");
    if (!view.includes(oracleDigest)) fail("view " + index + " omits the oracle digest");
  }

  const design = views[0].toString("utf8");
  for (const token of [
    ...authorities.stateIds,
    ...oracle.operationAuthority.operations.map((row) => row.key),
    ...oracle.bundleTopology.principals.map((row) => row.id),
    ...oracle.connectionFactory.errorCategories.map((row) => row.id),
    ...oracle.localAdministration.operationSchemas.map((row) => row.operation),
    ...oracle.operationAuthority.errors.map((row) => row.code),
    ...authorities.trustBoundaryIds,
  ]) {
    if (!design.includes(token)) fail("design view omits " + token);
  }

  const decisions = views[1].toString("utf8");
  for (const row of [...oracle.decisions, ...oracle.rejectedAlternatives]) {
    if (!decisions.includes(row.id)) fail("decisions view omits " + row.id);
  }

  const coverage = views[2].toString("utf8");
  const coverageTokens = [
    ...authorities.requirementIds,
    ...authorities.transitionIds,
    ...authorities.recoveryIds,
    ...authorities.removalCrashIds,
    ...authorities.proofIds,
    ...authorities.mutationIds,
    ...authorities.shieldIds,
    ...authorities.planningRowIds,
    ...authorities.downstreamIds,
    ...authorities.moduleIds,
    ...authorities.addendumIds,
    ...authorities.evidenceIds,
    ...authorities.trustBoundaryIds,
  ];
  for (const token of coverageTokens) {
    if (!coverage.includes(token)) fail("coverage view omits " + token);
  }
  return views.map((view) => sha256(view));
}

function runSelfTests(oracle) {
  const mutations = [
    [
      "MUT-SIGNED-BUILD-SELF-REFERENCE",
      (copy) => {
        const schema = copy.bundleTopology.signing.manifestSchema;
        schema.forbidden = schema.forbidden.filter((value) => value !== "outerCdhash");
        schema.required.push("outerCdhash");
        schema.properties = { outerCdhash: { type: "lowercase-hex-sha256" } };
      },
    ],
    [
      "MUT-PROCESS-AUTHORITY",
      (copy) => copy.keychainAuthority.accessGroupPrincipals.push("PRINCIPAL-CLI"),
    ],
    [
      "MUT-PREAUTH-OPERATION-METADATA",
      (copy) => {
        const schema = copy.localAdministration.authenticatedHello.serverChallengeSchema;
        schema.forbidden = schema.forbidden.filter((value) => value !== "operation");
        schema.required.push("operation");
        schema.properties.operation = { const: "credential.store" };
      },
    ],
    [
      "MUT-KEYCHAIN-ACCESSIBILITY",
      (copy) => {
        copy.keychainAuthority.item.kSecAttrAccessible = "kSecAttrAccessibleAfterFirstUnlock";
      },
    ],
    ["MUT-PLAINTEXT-PATH", (copy) => copy.secretAuthority.forbiddenSinks.pop()],
    [
      "MUT-PLAINTEXT-ADD-PASSWORD",
      (copy) => {
        const payload = byId(copy.operationAuthority.operations, "OP-CONNECT", "operation").payload;
        payload.required.push("password");
        payload.properties.password = { type: "string" };
      },
    ],
    [
      "MUT-PUBLIC-HTTP-REACHABILITY",
      (copy) => {
        copy.operationAuthority.httpDispatch = true;
      },
    ],
    ["MUT-PARTIAL-WRITE-RECOVERY", (copy) => copy.recoveryOrderings.splice(4, 1)],
    [
      "MUT-REMOVAL-UNCONDITIONAL-T28",
      (copy) => {
        byId(copy.stateMachine.transitions, "T28", "transition").guard = "always";
      },
    ],
    [
      "MUT-RECOVERY-UNSPECIFIED-T30",
      (copy) => {
        delete byId(copy.stateMachine.transitions, "T30", "transition").targetByRecoveryStep;
      },
    ],
    [
      "MUT-AUTHBLOCKED-GENERATION",
      (copy) => {
        copy.stateMachine.runtimeGenerationGate.releaseRule =
          "A restart can release authentication-blocked.";
      },
    ],
    [
      "MUT-VALIDATION-LSUB",
      (copy) => copy.connectionFactory.allowedValidationCommands.push("LSUB"),
    ],
    [
      "MUT-TYPE-LISTONLY-REMOVED",
      (copy) => {
        const authority = copy.connectionFactory.listOnlyAuthority.typeAuthority;
        authority.helperSource = authority.helperSource.replace(
          "const options: IcloudListOnlyOptions = { listOnly: true };",
          "const options: IcloudListOnlyOptions = {};",
        );
      },
    ],
    [
      "MUT-TYPE-LISTONLY-BOOLEAN",
      (copy) => {
        const authority = copy.connectionFactory.listOnlyAuthority.typeAuthority;
        authority.helperSource = authority.helperSource.replace(
          "readonly listOnly: true",
          "readonly listOnly: boolean",
        );
      },
    ],
    [
      "MUT-TYPE-LISTONLY-OPTIONAL",
      (copy) => {
        const authority = copy.connectionFactory.listOnlyAuthority.typeAuthority;
        authority.helperSource = authority.helperSource.replace(
          "readonly listOnly: true",
          "readonly listOnly?: true",
        );
      },
    ],
    [
      "MUT-TYPE-LISTONLY-CAST",
      (copy) => {
        const authority = copy.connectionFactory.listOnlyAuthority.typeAuthority;
        authority.helperSource = authority.helperSource.replace(
          "return client.list(options);",
          "return client.list(options as ListOptions);",
        );
      },
    ],
    [
      "MUT-TYPE-LISTONLY-ANY",
      (copy) => {
        const authority = copy.connectionFactory.listOnlyAuthority.typeAuthority;
        authority.helperSource = authority.helperSource.replace('Pick<ImapFlow, "list">', "any");
      },
    ],
    [
      "MUT-TYPE-DECLARATION-PIN-DROPPED",
      (copy) => {
        copy.dependencyPins = copy.dependencyPins.filter((row) => row.id !== "IMAPFLOW-TYPES");
      },
    ],
    [
      "MUT-TYPE-COMPILE-PROOF-DROPPED",
      (copy) => {
        copy.proofMatrices.validation = copy.proofMatrices.validation.filter(
          (row) => row.id !== "PROOF-VALIDATE-LIST-TYPES",
        );
      },
    ],
    [
      "MUT-RECEIPT-CAPACITY-257",
      (copy) => {
        copy.localAdministration.receiptLedger.maximumUnexpiredRecords = 257;
      },
    ],
    [
      "MUT-ATTEMPT-BUDGET-NESTED",
      (copy) => {
        copy.provider.attemptBudget.maximumProviderSessions = 6;
        copy.connectionFactory.transientRetry.delaysMilliseconds.push(4000);
      },
    ],
    [
      "MUT-BACKUP-SECRET-EXCLUSION",
      (copy) => {
        copy.configurationAuthority.backupExclusions = ["broker input"];
      },
    ],
    [
      "MUT-UNINSTALL-REVOCATION",
      (copy) => {
        copy.removalRestoreAuthority.daemonUninstall = "Uninstall revokes the Apple credential.";
      },
    ],
    ["MUT-DEMO-ISOLATION", (copy) => copy.demoIsolation.rules.pop()],
    [
      "MUT-OWNERSHIP-OVERLAP",
      (copy) => {
        byId(copy.moduleOwnership, "MODULE-ACTOR-JOURNAL", "module").paths.push({
          kind: "file",
          path: "packages/cli/src/account-command.ts",
        });
      },
    ],
    ["MUT-VIEW-DIVERGENCE", null],
    [
      "MUT-EVIDENCE-TIER",
      (copy) => {
        copy.evidenceTiers.find((row) => row.id === "EVIDENCE-LIVE-READ-ONLY").status =
          "verified-by-this-checker";
      },
    ],
  ];
  exactSet(
    mutations.map(([id]) => id),
    expectedMutationIds,
    "self-test mutation ids",
  );
  const rejected = [];
  for (const [id, mutate] of mutations) {
    if (id === "MUT-VIEW-DIVERGENCE") {
      const generated = Buffer.from(renderDesign(oracle, "0".repeat(64)), "utf8");
      const altered = Buffer.from(generated);
      altered[0] ^= 1;
      try {
        requireGeneratedBytes(altered, generated, "self-test divergent view");
      } catch {
        rejected.push(id);
        continue;
      }
      fail("self-test mutation survived: " + id);
    }
    const copy = structuredClone(oracle);
    mutate(copy);
    try {
      validateCore(copy);
    } catch {
      rejected.push(id);
      continue;
    }
    fail("self-test mutation survived: " + id);
  }
  return rejected;
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (
    ![
      "--self-test",
      "--strict-source",
      "--strict-dependency",
      "--strict-compile",
      "--strict-runtime",
      "--write-views",
    ].includes(flag)
  ) {
    fail("unknown option " + flag);
  }
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
if (!flags.has("--write-views")) exact(oracleDigest, EXPECTED_ORACLE_SHA256, "oracle digest");
const oracle = JSON.parse(oracleBytes.toString("utf8"));
const authorities = validateCore(oracle);
const sourceDrift = validateFrozenInputs(oracle, flags.has("--strict-source"));
const dependencyDrift = validateDependencies(oracle, flags.has("--strict-dependency"));
const compileFixture = flags.has("--strict-compile")
  ? validateListOnlyCompileFixture(oracle)
  : { status: "not-run; pass --strict-compile" };
const runtimeTranscript = flags.has("--strict-runtime")
  ? await validateListOnlyRuntimeTranscript(oracle)
  : { status: "not-run; pass --strict-runtime" };
const viewDigests = validateViews(oracle, oracleDigest, authorities, flags.has("--write-views"));
const selfTests = flags.has("--self-test") ? runSelfTests(oracle) : [];
const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

process.stdout.write(
  JSON.stringify(
    {
      status: "ok",
      oracleSha256: oracleDigest,
      acceptedHead: ACCEPTED_HEAD,
      currentHead,
      counts: {
        frozenInputs: oracle.frozenInputs.length,
        dependencyPins: oracle.dependencyPins.length,
        AppleSources: oracle.appleSources.length,
        issueEvidence: oracle.issueEvidence.length,
        principals: oracle.bundleTopology.principals.length,
        states: authorities.stateIds.size,
        transitions: authorities.transitionIds.size,
        recoveryOrderings: authorities.recoveryIds.size,
        operations: authorities.operationIds.size,
        errors: oracle.operationAuthority.errors.length,
        threatAssets: authorities.threatAssetIds.size,
        attackerCapabilities: authorities.attackerIds.size,
        trustBoundaries: authorities.trustBoundaryIds.size,
        proofGroups: authorities.proofGroupIds.size,
        constructiveProofs: authorities.proofIds.size,
        requirements: authorities.requirementIds.size,
        decisions: authorities.decisionIds.size,
        mutations: authorities.mutationIds.size,
        evidenceTiers: authorities.evidenceIds.size,
        planningRows: authorities.planningRowIds.size,
        downstreamIssues: authorities.downstreamIds.size,
        heldIssueAddenda: authorities.addendumIds.size,
      },
      viewDigests,
      authorityDigests: authorityDigests(oracle),
      compileFixture,
      runtimeTranscript,
      wroteViews: flags.has("--write-views"),
      selfTests,
      sourceDrift,
      dependencyDrift,
      evidenceLimit: oracle.evidenceLimit,
    },
    null,
    2,
  ) + "\n",
);
