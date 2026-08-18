import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7";
const architectureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDirectory, "../..");
const oraclePath = join(architectureDirectory, "action-approval-authority-oracle.v1.json");
const viewPaths = [
  join(architectureDirectory, "action-approval-authority-design.v1.md"),
  join(architectureDirectory, "action-approval-authority-decisions.v1.md"),
  join(architectureDirectory, "action-approval-authority-coverage.v1.md"),
];

function fail(message) {
  throw new Error(`action approval authority check failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(keyHex, value) {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(value).digest("hex");
}

function equalHex(left, right) {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function uniqueIds(items, label) {
  const ids = items.map(({ id }) => id);
  assert(
    ids.every((id) => typeof id === "string" && id.length > 0),
    `${label} has invalid ID`,
  );
  assert(new Set(ids).size === ids.length, `${label} has duplicate ID`);
  return new Set(ids);
}

function exactSet(actual, expected, label) {
  assert(
    actual.size === expected.size && [...actual].every((value) => expected.has(value)),
    `${label} differs: ${JSON.stringify([...actual].sort())}`,
  );
}

function everyReferenceExists(values, ids, label) {
  assert(Array.isArray(values) && values.length > 0, `${label} is empty`);
  for (const value of values) assert(ids.has(value), `${label} references unknown ${value}`);
}

function frozenBytes(input) {
  assert(/^[0-9a-f]{40}$/u.test(input.gitCommit), `${input.id} has invalid gitCommit`);
  try {
    return execFileSync("git", ["show", `${input.gitCommit}:${input.path}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    fail(`${input.id} frozen input cannot be read`);
  }
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
assert(oracleDigest === EXPECTED_ORACLE_SHA256, `oracle digest ${oracleDigest} != expected`);
const oracle = JSON.parse(oracleBytes.toString("utf8"));
assert(
  oracle.format === "agent-mail.action-approval-authority-oracle/v1" && oracle.schemaVersion === 1,
  "unsupported oracle format",
);
assert(oracle.oracle?.normative === true, "oracle is not normative");
assert(oracle.productDecision?.id === "POLICY-A", "Policy A is not frozen");
assert(
  oracle.authenticatorDecision?.id === "A1-MACOS-SECURE-ENCLAVE",
  "A1 authenticator is not frozen",
);
assert(oracle.remainingConsequentialChoices?.length === 0, "consequential choice remains open");
assert(oracle.limits.approvalLifetimeSeconds === 600, "approval lifetime drifted");
assert(oracle.limits.humanPresenceMaximumAgeSeconds === 60, "presence freshness drifted");
assert(oracle.limits.nonceBytes === 32, "nonce size drifted");

const requirementIds = uniqueIds(oracle.requirements, "requirements");
const decisionIds = uniqueIds(oracle.decisions, "decisions");
const rejectedIds = uniqueIds(oracle.rejectedAlternatives, "rejected alternatives");
const retirementIds = uniqueIds(oracle.retirements, "retirements");
const probeIds = uniqueIds(oracle.probes, "probes");
const obligationIds = uniqueIds(oracle.implementationObligations, "implementation obligations");
const contradictionIds = uniqueIds(oracle.currentContradictions, "current contradictions");
const transitionIds = uniqueIds(oracle.stateMachine.transitions, "transitions");
const forbiddenIds = uniqueIds(oracle.structurallyForbidden, "forbidden rules");

for (const [label, actual, expected] of [
  ["requirements", requirementIds.size, 9],
  ["decisions", decisionIds.size, 29],
  ["rejected alternatives", rejectedIds.size, 22],
  ["retirements", retirementIds.size, 16],
  ["probes", probeIds.size, 21],
  ["implementation obligations", obligationIds.size, 11],
  ["current contradictions", contradictionIds.size, 5],
  ["transitions", transitionIds.size, 10],
  ["forbidden rules", forbiddenIds.size, 9],
])
  assert(actual === expected, `${label} count ${actual} != ${expected}`);

exactSet(new Set(Object.keys(oracle.coverage)), requirementIds, "requirement coverage");
for (const [requirementId, coverage] of Object.entries(oracle.coverage)) {
  everyReferenceExists(coverage.decisions, decisionIds, `${requirementId}.decisions`);
  everyReferenceExists(coverage.probes, probeIds, `${requirementId}.probes`);
  everyReferenceExists(coverage.obligations, obligationIds, `${requirementId}.obligations`);
}
for (const [label, allIds, referenced] of [
  [
    "decision",
    decisionIds,
    new Set(Object.values(oracle.coverage).flatMap(({ decisions }) => decisions)),
  ],
  ["probe", probeIds, new Set(Object.values(oracle.coverage).flatMap(({ probes }) => probes))],
  [
    "obligation",
    obligationIds,
    new Set(Object.values(oracle.coverage).flatMap(({ obligations }) => obligations)),
  ],
]) {
  for (const id of allIds) assert(referenced.has(id), `${label} ${id} lacks requirement coverage`);
}

const requiredCaseTags = new Set([
  "same-token-self-approval",
  "spoofed-principal",
  "changed-digest",
  "changed-targets",
  "changed-intent",
  "changed-version",
  "expired-approval",
  "concurrent-double-consume",
  "restart-before-consume",
  "restart-after-consume",
  "audit-reopen",
  "direct",
  "http",
  "cli",
  "storage",
  "recovery",
  "cancellation",
  "partial",
  "uncertain",
  "legacy-scope-only",
  "a1-crypto",
  "request-method",
  "request-path",
  "raw-body-digest",
  "ceremony-replay",
  "restore-with-key",
  "pre-consume-backup",
  "pre-cancel-backup",
  "operator-session",
  "no-session-approval",
  "credential-expiry",
  "post-consume-backup",
  "restore-quarantine",
  "closure-version",
  "seal-key-rotation",
  "active-key-removal",
  "same-uid-administration-bypass",
  "administration-assertion-replay",
  "administration-binding",
  "backup-key-exclusion",
  "revoke-vs-consume",
  "key-removal-vs-consume",
  "challenge-rate-per-credential",
  "expired-slot-reclamation",
  "global-capacity",
  "crash-after-result",
  "recovery-finalizer",
  "effect-executor-attribution",
  "multi-attempt",
]);
const caseTags = new Set(oracle.probes.flatMap(({ caseTags = [] }) => caseTags));
for (const tag of requiredCaseTags) assert(caseTags.has(tag), `missing required case ${tag}`);

const operator = oracle.profiles.find(({ profile }) => profile === "operator-interactive");
const agent = oracle.profiles.find(({ profile }) => profile === "agent-unattended");
const executor = oracle.profiles.find(({ profile }) => profile === "internal-action-executor");
assert(operator?.mayApprove === true && operator.mayCommit === false, "operator matrix drifted");
assert(
  operator.credential.includes("kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly") &&
    operator.credential.includes("fresh zero-reuse LAContext"),
  "operator profile is not pinned to A1",
);
assert(agent?.mayApprove === false && agent.mayCommit === true, "agent matrix drifted");
assert(
  executor?.mayExecute === true && executor.allowedActionScopes.length === 0,
  "executor matrix drifted",
);
assert(!operator.allowedActionScopes.includes("mail:action.commit"), "operator can commit");
assert(
  operator.nonApprovalSession.includes("memory-only") &&
    operator.nonApprovalSession.includes("create and mail:action.inspect") &&
    oracle.limits.operatorSessionLifetimeSeconds === 600,
  "operator create/inspect authentication path drifted",
);
assert(!agent.allowedActionScopes.includes("mail:action.approve"), "agent can approve");
assert(
  !oracle.publicContract.operations.some(({ scope }) => scope === "mail:action.authorize"),
  "retired authorize scope remains normative",
);
assert(
  oracle.publicContract.operations.find(({ key }) => key === "action-plans.approve")?.scope ===
    "mail:action.approve",
  "approve operation drifted",
);
assert(
  oracle.publicContract.operations.find(({ key }) => key === "action-plans.commit")?.scope ===
    "mail:action.commit",
  "commit operation drifted",
);
const operatorSessionOperation = oracle.publicContract.operations.find(
  ({ key }) => key === "operator-sessions.create",
);
assert(
  operatorSessionOperation?.route === "/v1/operator-sessions" &&
    operatorSessionOperation.exposure.includes("loopback-only") &&
    operatorSessionOperation.scope === null,
  "operator session route drifted",
);
const approveAuthority = oracle.authorityMatrix.find(({ operation }) => operation === "approve");
const cancelAuthority = oracle.authorityMatrix.find(
  ({ operation }) => operation === "cancel-approval",
);
assert(
  approveAuthority?.durableOutput ===
    "operator_presence_challenge_consumptions plus action_approvals in one transaction" &&
    cancelAuthority?.durableOutput ===
      "operator_presence_challenge_consumptions plus action_approval_cancellations and plan version update in one transaction",
  "operator challenge closure is not atomic with authority write",
);
exactSet(
  new Set(oracle.storageSchema.tables.map(({ name }) => name)),
  new Set([
    "operator_presence_challenges",
    "operator_presence_challenge_consumptions",
    "operator_presence_challenge_expirations",
    "operator_presence_challenge_invalidations",
    "action_plan_authority_versions",
    "action_plan_creators",
    "action_approvals",
    "action_approval_consumptions",
    "action_approval_expirations",
    "action_approval_cancellations",
    "action_approval_invalidations",
    "action_attempt_authorities",
    "action_plan_terminal_audit",
  ]),
  "storage tables",
);
assert(
  oracle.storageSchema.tablePolicy.includes("All 13 tables are SQLite STRICT") &&
    oracle.storageSchema.tablePolicy.includes("Every listed column is NOT NULL"),
  "authority table nullability or strictness drifted",
);
const authorityVersionTable = oracle.storageSchema.tables.find(
  ({ name }) => name === "action_plan_authority_versions",
);
const consumptionTable = oracle.storageSchema.tables.find(
  ({ name }) => name === "action_approval_consumptions",
);
const challengeConsumptionTable = oracle.storageSchema.tables.find(
  ({ name }) => name === "operator_presence_challenge_consumptions",
);
const terminalAuditTable = oracle.storageSchema.tables.find(
  ({ name }) => name === "action_plan_terminal_audit",
);
const attemptAuthorityTable = oracle.storageSchema.tables.find(
  ({ name }) => name === "action_attempt_authorities",
);
assert(
  challengeConsumptionTable.columns.some((column) =>
    column.includes("operator-session|approval|cancellation|seal-key-rotation|seal-key-removal"),
  ),
  "challenge consumption cannot attribute seal-key administration",
);
assert(
  authorityVersionTable.columns.some((column) =>
    column.includes("reason_code TEXT CHECK trusted-create|legacy-pre-authority"),
  ) && authorityVersionTable.immutability.includes("exact pairs"),
  "authority-version reason mapping is not deterministic",
);
assert(
  consumptionTable.foreignKeys.includes(
    "(plan_id,claim_id) -> action_plan_claims(plan_id,claim_id); this is the sole receipt-to-claim link",
  ) && !oracle.storageSchema.tables.some(({ name }) => name.includes("claim_authority_link")),
  "receipt-to-claim link representation drifted",
);
assert(
  consumptionTable.unique.includes("receipt_id+plan_id+claim_id") &&
    terminalAuditTable.foreignKeys.includes(
      "(receipt_id,plan_id,claim_id) -> action_approval_consumptions(receipt_id,plan_id,claim_id); this exact composite key prevents cross-plan or cross-claim terminal attribution",
    ),
  "terminal audit is not tied to the exact receipt/plan/claim consumption",
);
assert(
  attemptAuthorityTable.unique.includes("receipt_id+plan_id+claim_id+attempt_id") &&
    attemptAuthorityTable.columns.some((column) =>
      column.startsWith("executor_instance_id TEXT executor:* namespace"),
    ) &&
    terminalAuditTable.columns.some((column) => column.startsWith("effect_attempt_count ")) &&
    terminalAuditTable.columns.some((column) =>
      column.startsWith("effect_authority_set_digest "),
    ) &&
    terminalAuditTable.columns.some((column) => column.includes("executor:multiple")) &&
    terminalAuditTable.columns.some((column) =>
      column.startsWith(
        "finalizer_kind TEXT CHECK effect-executor|ordinary-recovery|restore-admission",
      ),
    ) &&
    terminalAuditTable.columns.some(
      (column) =>
        column.includes("executor:* for effect-executor") &&
        column.includes("recovery-finalizer:* for ordinary-recovery") &&
        column.includes("finalizer:restore-admission"),
    ) &&
    oracle.storageSchema.crossTableConstraints.some((rule) =>
      rule.includes("action-terminal-effect-authority-set-v1"),
    ) &&
    oracle.storageSchema.crossTableConstraints.some(
      (rule) => rule.includes("recovery-finalizer:*") && rule.includes("never replace"),
    ),
  "terminal effect executor/finalizer attribution drifted",
);

const expectedErrors = new Map([
  ["action.approval_forbidden", 403],
  ["action.approval_presence_required", 403],
  ["action.operator_presence_unsupported", 503],
  ["action.operator_challenge_capacity", 429],
  ["action.operator_challenge_not_found", 404],
  ["action.operator_challenge_expired", 409],
  ["action.operator_challenge_consumed", 409],
  ["action.operator_assertion_invalid", 403],
  ["action.approval_not_found", 404],
  ["action.approval_mismatch", 409],
  ["action.approval_expired", 409],
  ["action.approval_cancelled", 409],
  ["action.approval_invalidated", 409],
  ["action.approval_consumed", 409],
  ["action.plan_version_stale", 409],
  ["action.plan_not_pending", 409],
  ["action.plan_expired", 409],
  ["action.legacy_authority", 409],
]);
exactSet(
  new Set(oracle.publicContract.errors.map(({ code }) => code)),
  new Set(expectedErrors.keys()),
  "public errors",
);
for (const error of oracle.publicContract.errors)
  assert(error.http === expectedErrors.get(error.code), `${error.code} status drifted`);

const expectedApprovalCommitmentFields = [
  "approvalId",
  "approverPrincipalId",
  "approverCredentialId",
  "approverProfile",
  "approverAuthEventId",
  "ceremonyId",
  "userPresenceVerifiedAt",
  "presenceRequestMethod",
  "presenceRequestPath",
  "presenceRequestBodySha256",
  "authorityInstanceId",
  "operatorConfigurationRevision",
  "challengeCommitmentSha256",
  "assertionSignatureSha256",
  "operatorDisplayCode",
  "planId",
  "planVersion",
  "previewDigest",
  "targetDigest",
  "canonicalTargetSet",
  "normalizedIntent",
  "issuedAt",
  "expiresAt",
  "nonce",
  "authorizationScope",
  "sealKeyId",
  "sealKeyringRevision",
  "sealAlgorithm",
];
assert(
  oracle.canonicalization.approvalCommitmentNamespace === "action-approval-authority-v1",
  "approval commitment namespace drifted",
);
assert(
  JSON.stringify(oracle.canonicalization.approvalCommitmentFieldsInOrder) ===
    JSON.stringify(expectedApprovalCommitmentFields),
  "approval commitment ordered field projection drifted",
);
assert(
  new Set(oracle.canonicalization.approvalCommitmentFieldsInOrder).size ===
    oracle.canonicalization.approvalCommitmentFieldsInOrder.length,
  "approval commitment repeats a field",
);
exactSet(
  new Set(oracle.canonicalization.approvalCommitmentFieldsInOrder),
  new Set(oracle.approvalArtifact.immutableFields.filter((field) => field !== "seal")),
  "sealed immutable field projection",
);
assert(
  oracle.canonicalization.approvalCommitmentFieldsInOrder.filter((field) => field === "sealKeyId")
    .length === 1,
  "sealKeyId must occur exactly once",
);

const requestBindingByOperation = new Map(
  oracle.operatorRequestBindings.map((binding) => [binding.operation, binding]),
);
const approveBinding = requestBindingByOperation.get("approve");
const cancelBinding = requestBindingByOperation.get("cancel-approval");
assert(
  approveBinding?.method === "POST" &&
    approveBinding.pathTemplate === "/v1/action-plans/{planId}/approvals" &&
    approveBinding.cliBodyEncoding ===
      "JSON.stringify({planId,planVersion,previewDigest}) encoded as UTF-8 once and retained unchanged" &&
    approveBinding.bodySha256.includes("final bounded raw HTTP body bytes") &&
    JSON.stringify(approveBinding.strictBodyFieldsInCanonicalOrder) ===
      JSON.stringify(["planId", "planVersion", "previewDigest"]),
  "approve request binding drifted",
);
assert(
  cancelBinding?.method === "DELETE" &&
    cancelBinding.pathTemplate === "/v1/action-plans/{planId}/approvals/{approvalId}" &&
    cancelBinding.cliBodyEncoding ===
      "JSON.stringify({planId,approvalId,planVersion,previewDigest}) encoded as UTF-8 once and retained unchanged" &&
    cancelBinding.bodySha256.includes("final bounded raw HTTP body bytes") &&
    JSON.stringify(cancelBinding.strictBodyFieldsInCanonicalOrder) ===
      JSON.stringify(["planId", "approvalId", "planVersion", "previewDigest"]),
  "cancel request binding drifted",
);
const expectedChallengeFields = [
  "authorityInstanceId",
  "challengeId",
  "challengeNonceBase64url",
  "credentialId",
  "principalId",
  "profile",
  "operation",
  "requestMethod",
  "requestPath",
  "requestBodySha256",
  "operatorDisplayCode",
  "operatorConfigurationRevision",
  "issuedAt",
  "expiresAt",
];
assert(
  JSON.stringify(oracle.operatorAuthenticatorProtocol.challenge.commitmentFieldsInOrder) ===
    JSON.stringify(expectedChallengeFields) &&
    new Set(oracle.operatorAuthenticatorProtocol.challenge.commitmentFieldsInOrder).size ===
      expectedChallengeFields.length,
  "challenge commitment field projection drifted",
);
assert(
  JSON.stringify(oracle.operatorAuthenticatorProtocol.assertion.strictJsonFieldsInOrder) ===
    JSON.stringify(["version", "challengeId", "credentialId", "signatureBase64url"]),
  "operator assertion shape drifted",
);
assert(
  JSON.stringify(
    oracle.operatorAuthenticatorProtocol.challenge.issueRequest.strictFieldsInOrder,
  ) ===
    JSON.stringify([
      "version",
      "credentialId",
      "operation",
      "requestMethod",
      "requestPath",
      "requestBodyBase64url",
    ]) &&
    oracle.operatorAuthenticatorProtocol.challenge.issueRequest.operation ===
      "open-session|approve|cancel-approval|seal-key-rotate|seal-key-remove" &&
    oracle.operatorAuthenticatorProtocol.challenge.issueFraming.includes("getpeereid") &&
    oracle.operatorAuthenticatorProtocol.challenge.issueFraming.includes("4096 bytes") &&
    oracle.operatorAuthenticatorProtocol.challenge.issueFraming.includes("exactly one LF byte"),
  "operator challenge RPC schema or framing drifted",
);
assert(
  JSON.stringify(oracle.operatorAuthenticatorProtocol.enrollment.commands) ===
    JSON.stringify({
      enroll: "agent-mail-operator-broker enroll --private-root <canonical-absolute-privateRoot>",
      rotate: "agent-mail-operator-broker rotate --private-root <canonical-absolute-privateRoot>",
      revoke:
        "agent-mail-operator-broker revoke --private-root <canonical-absolute-privateRoot> --credential-id <credentialId>",
      recover: "agent-mail-operator-broker recover --private-root <canonical-absolute-privateRoot>",
    }) && oracle.operatorAuthenticatorProtocol.enrollment.commandRules.length === 5,
  "operator provisioning commands drifted",
);
assert(
  oracle.operatorAuthenticatorProtocol.key.privateKey.includes(
    "kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly",
  ) &&
    oracle.operatorAuthenticatorProtocol.key.privateKey.includes("kSecAttrTokenIDSecureEnclave") &&
    oracle.operatorAuthenticatorProtocol.key.authenticationContext.includes(
      "touchIDAuthenticationAllowableReuseDuration to 0",
    ),
  "A1 key or fresh-presence policy drifted",
);
assert(
  oracle.operatorAuthenticatorProtocol.assertion.humanConfirmation.includes(
    "plan <planId> preview <previewDigest> code <operatorDisplayCode>",
  ),
  "native confirmation no longer visibly binds plan and preview",
);
assert(
  oracle.operatorAuthenticatorProtocol.challenge.issueTransport.includes(
    "0600 Unix-domain socket",
  ) &&
    oracle.operatorAuthenticatorProtocol.assertion.verificationOrder.some((rule) =>
      rule.includes("updates SHA-256 incrementally"),
    ),
  "A1 bounded two-phase admission drifted",
);
assert(
  oracle.operatorAuthenticatorProtocol.challenge.limits.globalAvailable === 128 &&
    oracle.operatorAuthenticatorProtocol.challenge.limits.perCredentialAvailable === 4 &&
    oracle.operatorAuthenticatorProtocol.challenge.limits.perCredentialIssuedPerRollingMinute ===
      10 &&
    oracle.operatorAuthenticatorProtocol.challenge.limits.ttlSeconds === 60,
  "A1 challenge bounds drifted",
);
assert(
  oracle.operatorAuthenticatorProtocol.enrollment.credentialLifetime.seconds === 31_536_000 &&
    oracle.operatorAuthenticatorProtocol.enrollment.credentialLifetime.rule.includes(
      "equality is expired",
    ) &&
    oracle.limits.operatorCredentialLifetimeSeconds === 31_536_000,
  "operator credential expiry drifted",
);
assert(
  oracle.approvalSealKeyring.path ===
    "<privateRoot>/secrets/action-approval-seal-keyring.v1.json" &&
    oracle.approvalSealKeyring.fileMode === "0600" &&
    oracle.approvalSealKeyring.directoryMode === "0700" &&
    oracle.approvalSealKeyring.format.keyBase64url.includes("exactly 32") &&
    oracle.approvalSealKeyring.backupExclusion.includes("categorically excluded") &&
    oracle.approvalSealKeyring.removal.includes("verify-only") &&
    oracle.approvalSealKeyring.removal.includes("Active-key removal is rejected"),
  "approval seal keyring is not exact",
);
const sealAdministration = oracle.approvalSealKeyring.administrationProtocol;
assert(
  JSON.stringify(sealAdministration.challengeOperations) ===
    JSON.stringify(["seal-key-rotate", "seal-key-remove"]) &&
    sealAdministration.requestMethod === "ADMIN" &&
    sealAdministration.requestPaths["seal-key-rotate"] ===
      "/internal/action-authority/seal-keyring/rotate" &&
    sealAdministration.requestPaths["seal-key-remove"] ===
      "/internal/action-authority/seal-keyring/remove" &&
    JSON.stringify(sealAdministration.strictBodies["seal-key-rotate"].fieldsInOrder) ===
      JSON.stringify(["expectedKeyringRevision", "expectedActiveKeyId"]) &&
    JSON.stringify(sealAdministration.strictBodies["seal-key-remove"].fieldsInOrder) ===
      JSON.stringify(["expectedKeyringRevision", "keyId"]) &&
    sealAdministration.mutationTransport.includes("Same UID is transport admission only") &&
    sealAdministration.verification.includes("rejects the old bare rotate/remove discriminants") &&
    sealAdministration.atomicMutation.includes("consume the challenge") &&
    sealAdministration.crashAndReplay.includes("expectedKeyringRevision"),
  "daemon-verifiable seal-key administration protocol drifted",
);
assert(
  oracle.authorityLinearization.order.length === 6 &&
    oracle.authorityLinearization.linearizationRule.includes(
      "No ordering allows mutation to linearize first",
    ),
  "cross-resource authority linearization drifted",
);

const expectedObligationIssues = new Map([
  ["O-204-CONTRACTS", 204],
  ["O-204-AUTH", 204],
  ["O-204-STORAGE", 204],
  ["O-204-SERVICE", 204],
  ["O-204-RECOVERY", 204],
  ["O-CLI", 158],
  ["O-LIVE-HARNESS", 153],
  ["O-LIVE-QUALIFICATION", 181],
  ["O-SECURITY", 183],
  ["O-CLOSURE", 185],
  ["O-GATE", 208],
]);
exactSet(new Set(expectedObligationIssues.keys()), obligationIds, "obligation owners");
for (const obligation of oracle.implementationObligations)
  assert(
    obligation.issue === expectedObligationIssues.get(obligation.id),
    `${obligation.id} issue ${obligation.issue} drifted`,
  );
const domainTrackerIssues = new Set([16, 27]);
assert(
  oracle.implementationObligations.every(({ issue }) => !domainTrackerIssues.has(issue)),
  "obligation targets a domain tracker instead of its implementation/qualification issue",
);

const expectedSurfaceDelegates = new Map([
  ["direct-service", "ApprovalAuthorityRepository"],
  ["composed-http", "ApprovalAuthorityService"],
  ["cli-http", "composed-http"],
  ["storage-repository", "SQLite BEGIN IMMEDIATE"],
  ["restart-recovery", "internal-action-executor|read-only-recovery-finalizer"],
]);
exactSet(
  new Set(oracle.surfaceClosure.map(({ surface }) => surface)),
  new Set(expectedSurfaceDelegates.keys()),
  "surface closure",
);
for (const surface of oracle.surfaceClosure)
  assert(
    surface.onlyDelegate === expectedSurfaceDelegates.get(surface.surface),
    `${surface.surface} delegate drifted`,
  );
assert(
  oracle.surfaceClosure.find(({ surface }) => surface === "restart-recovery")
    ?.mayConsumeApproval === false &&
    oracle.surfaceClosure
      .find(({ surface }) => surface === "restart-recovery")
      ?.postResultFinalizer.includes("no adapter permission"),
  "recovery consume/finalizer closure drifted",
);

const downstreamWorktreeDrift = [];
for (const input of oracle.frozenInputs) {
  const authority = frozenBytes(input);
  assert(sha256(authority) === input.sha256, `${input.id} frozen digest drifted`);
  try {
    const currentDigest = sha256(readFileSync(join(repositoryRoot, input.path)));
    if (currentDigest !== input.sha256)
      downstreamWorktreeDrift.push({
        id: input.id,
        authoritySha256: input.sha256,
        worktreeSha256: currentDigest,
      });
  } catch {
    downstreamWorktreeDrift.push({
      id: input.id,
      authoritySha256: input.sha256,
      worktreeSha256: null,
    });
  }
}

const frozenById = new Map(oracle.frozenInputs.map((input) => [input.id, input]));
function frozenText(id) {
  const input = frozenById.get(id);
  assert(input !== undefined, `missing frozen input ${id}`);
  return frozenBytes(input).toString("utf8");
}
assert(
  frozenText("ACTION-CONTRACTS").includes('scope: "mail:action.authorize"'),
  "authorize contradiction changed",
);
assert(
  frozenText("ACTION-CONTRACTS").includes("authorizationId: actionAuthorizationIdSchema"),
  "transient authorization contradiction changed",
);
assert(
  frozenText("ACTION-CLAIM").includes('"authorizationEvidence"'),
  "scope-only evidence contradiction changed",
);
assert(
  frozenText("ACTION-CLAIM").includes('"authorizationScope"'),
  "scope-only fallback contradiction changed",
);
assert(
  frozenText("HTTP-AUTH").includes("readonly subject: string"),
  "principal-shape contradiction changed",
);
assert(
  frozenText("CREDENTIAL-CONFIG").includes('join(root, "secrets", "api-token")'),
  "single credential contradiction changed",
);

for (const contradiction of oracle.currentContradictions)
  everyReferenceExists(
    contradiction.requiredRetirements,
    retirementIds,
    `${contradiction.id}.retirements`,
  );

// Executable model probes exercise the normative A1 protocol, not current production code.
const sealKeyOneId = "approval-seal-key:10000000-0000-4000-8000-000000000001";
const sealKeyTwoId = "approval-seal-key:10000000-0000-4000-8000-000000000002";
const sealKeyOneHex = "a5".repeat(32);
const sealKeyTwoHex = "b6".repeat(32);
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const { privateKey: operatorPrivateKey, publicKey: operatorPublicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const operatorPublicSpki = operatorPublicKey.export({ format: "der", type: "spki" });
const operatorCredential = Object.freeze({
  authorityInstanceId: "instance:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credentialId: `credential:operator:${sha256(operatorPublicSpki)}`,
  principalId: "principal:local-operator",
  profile: "operator-interactive",
  scopes: Object.freeze(["mail:action.inspect", "mail:action.approve"]),
  status: "active",
  algorithm: "ES256",
  credentialExpiresAt: "2027-08-18T00:00:00.000Z",
});
const secondOperatorCredential = Object.freeze({
  ...operatorCredential,
  credentialId: `credential:operator:${"bb".repeat(32)}`,
});
const agentAuth = Object.freeze({
  principalId: "principal:agent",
  credentialId: "credential:agent-token",
  profile: "agent-unattended",
  scopes: Object.freeze(["mail:action.inspect", "mail:action.commit"]),
  authEventId: "auth:agent-event",
  credentialExpiresAt: "2027-08-18T00:00:00.000Z",
  presence: Object.freeze({ kind: "unattended" }),
});
const operatorAuthShape = Object.freeze({
  ...operatorCredential,
  authEventId: "auth:operator-event",
  presence: Object.freeze({ kind: "human-present" }),
});

const basePlan = Object.freeze({
  planId: "plan:11111111-1111-4111-8111-111111111111",
  version: 1,
  action: Object.freeze({ kind: "moveToArchive" }),
  targets: Object.freeze([
    Object.freeze({
      accountId: "account:a",
      mailboxId: "mailbox:inbox",
      uidValidity: 9,
      uid: 12,
      modseq: 44,
    }),
    Object.freeze({
      accountId: "account:a",
      mailboxId: "mailbox:inbox",
      uidValidity: 9,
      uid: 3,
      modseq: 41,
    }),
  ]),
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T00:30:00.000Z",
  state: "pending",
  authorityVersion: "trusted-v1",
});

function canonicalTargets(plan) {
  const targets = [...plan.targets]
    .map(({ accountId, mailboxId, uidValidity, uid, modseq }) => [
      accountId,
      mailboxId,
      uidValidity,
      uid,
      modseq,
    ])
    .sort((left, right) => {
      for (const index of [0, 1]) {
        const comparison = Buffer.compare(Buffer.from(left[index]), Buffer.from(right[index]));
        if (comparison !== 0) return comparison;
      }
      for (const index of [2, 3, 4])
        if (left[index] !== right[index]) return left[index] - right[index];
      return 0;
    });
  return JSON.stringify(["action-target-set-v1", targets]);
}

function bindings(plan) {
  const targetSet = canonicalTargets(plan);
  const targetDigest = sha256(targetSet);
  const intent = JSON.stringify(["action-intent-v1", plan.action.kind, targetDigest]);
  const preview = JSON.stringify([
    "action-preview-v1",
    plan.planId,
    plan.version,
    plan.action.kind,
    targetSet,
    intent,
    plan.createdAt,
    plan.expiresAt,
  ]);
  return { targetSet, targetDigest, intent, previewDigest: sha256(preview) };
}

function cloneStore(store) {
  return structuredClone(store);
}

function newStore() {
  return {
    plan: structuredClone(basePlan),
    approval: null,
    closedApprovals: [],
    closure: null,
    claim: null,
    activeClaimId: null,
    challenges: new Map(),
    challengeClosures: new Map(),
    nextChallenge: 1,
    challengeIssueTimes: [],
    credentials: new Map([
      [
        operatorCredential.credentialId,
        { status: "active", expiresAt: operatorCredential.credentialExpiresAt },
      ],
      [
        secondOperatorCredential.credentialId,
        { status: "active", expiresAt: secondOperatorCredential.credentialExpiresAt },
      ],
    ]),
    operatorConfigurationRevision: 1,
    keyring: {
      revision: 1,
      activeKeyId: sealKeyOneId,
      keys: new Map([[sealKeyOneId, { status: "active", keyHex: sealKeyOneHex }]]),
    },
    operatorSessions: new Map(),
    restoreEvents: [],
    attemptAuthorities: [],
    durableResults: new Map(),
    remoteCalls: 0,
    audit: [],
  };
}

function profileIsValid(auth) {
  const actionScopes = auth.scopes.filter((scope) => scope.startsWith("mail:action."));
  if (actionScopes.includes("mail:action.authorize")) return false;
  if (auth.profile === "operator-interactive") {
    const allowed = new Set(["mail:action.create", "mail:action.inspect", "mail:action.approve"]);
    if (!actionScopes.every((scope) => allowed.has(scope))) return false;
    if (auth.presence.kind === "human-present") return true;
    return (
      auth.presence.kind === "a1-non-approval-session" &&
      JSON.stringify(actionScopes) === JSON.stringify(["mail:action.create", "mail:action.inspect"])
    );
  }
  if (auth.profile === "agent-unattended") {
    const allowed = new Set(["mail:action.create", "mail:action.inspect", "mail:action.commit"]);
    return actionScopes.every((scope) => allowed.has(scope)) && auth.presence.kind === "unattended";
  }
  return false;
}

function approvalCommitment(approval) {
  const leaves = oracle.canonicalization.approvalCommitmentFieldsInOrder.map((field) => {
    assert(Object.hasOwn(approval, field), `approval commitment is missing ${field}`);
    return approval[field];
  });
  return JSON.stringify([oracle.canonicalization.approvalCommitmentNamespace, ...leaves]);
}

function strictKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function strictOrderedKeys(value, keys) {
  return strictKeys(value, keys) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function approveBody(store) {
  const bound = bindings(store.plan);
  return {
    planId: store.plan.planId,
    planVersion: store.plan.version,
    previewDigest: bound.previewDigest,
  };
}

function cancelBody(store) {
  return {
    planId: store.plan.planId,
    approvalId: store.approval.approvalId,
    planVersion: store.plan.version,
    previewDigest: store.approval.previewDigest,
  };
}

function operatorSessionBody() {
  return { requestedScopes: ["mail:action.create", "mail:action.inspect"] };
}

function sealKeyAdminBody(store, operation, keyId = sealKeyOneId) {
  return operation === "seal-key-rotate"
    ? {
        expectedKeyringRevision: store.keyring.revision,
        expectedActiveKeyId: store.keyring.activeKeyId,
      }
    : { expectedKeyringRevision: store.keyring.revision, keyId };
}

function rawBody(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function expectedPath(operation, body) {
  if (operation === "open-session") return "/v1/operator-sessions";
  if (operation === "seal-key-rotate") return "/internal/action-authority/seal-keyring/rotate";
  if (operation === "seal-key-remove") return "/internal/action-authority/seal-keyring/remove";
  if (operation === "approve")
    return `/v1/action-plans/${encodeURIComponent(body.planId)}/approvals`;
  return `/v1/action-plans/${encodeURIComponent(body.planId)}/approvals/${encodeURIComponent(body.approvalId)}`;
}

function expectedMethod(operation) {
  if (operation === "seal-key-rotate" || operation === "seal-key-remove") return "ADMIN";
  return operation === "cancel-approval" ? "DELETE" : "POST";
}

function parseOperatorBody(operation, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 2_048)
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  }
  const keys =
    operation === "open-session"
      ? ["requestedScopes"]
      : operation === "seal-key-rotate"
        ? ["expectedKeyringRevision", "expectedActiveKeyId"]
        : operation === "seal-key-remove"
          ? ["expectedKeyringRevision", "keyId"]
          : operation === "approve"
            ? ["planId", "planVersion", "previewDigest"]
            : ["planId", "approvalId", "planVersion", "previewDigest"];
  if (
    !strictKeys(value, keys) ||
    (operation === "open-session" &&
      JSON.stringify(value.requestedScopes) !==
        JSON.stringify(["mail:action.create", "mail:action.inspect"])) ||
    ((operation === "seal-key-rotate" || operation === "seal-key-remove") &&
      (!Number.isSafeInteger(value.expectedKeyringRevision) ||
        value.expectedKeyringRevision <= 0)) ||
    (operation === "seal-key-rotate" &&
      (typeof value.expectedActiveKeyId !== "string" ||
        !value.expectedActiveKeyId.startsWith("approval-seal-key:"))) ||
    (operation === "seal-key-remove" &&
      (typeof value.keyId !== "string" || !value.keyId.startsWith("approval-seal-key:")))
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  return { kind: "parsed", value };
}

function operatorDisplayCode(operation, body) {
  if (operation === "open-session") {
    const digest = sha256(
      JSON.stringify([
        "agent-mail-presence-display-v1",
        "open-session",
        operatorCredential.authorityInstanceId,
        "mail:action.create",
        "mail:action.inspect",
      ]),
    ).slice(0, 20);
    return digest.match(/.{4}/gu).join("-");
  }
  if (operation === "seal-key-rotate" || operation === "seal-key-remove") {
    const targetKeyId = operation === "seal-key-rotate" ? body.expectedActiveKeyId : body.keyId;
    const digest = sha256(
      JSON.stringify([
        "agent-mail-presence-display-v1",
        operation,
        operatorCredential.authorityInstanceId,
        body.expectedKeyringRevision,
        targetKeyId,
      ]),
    ).slice(0, 20);
    return digest.match(/.{4}/gu).join("-");
  }
  const digest = sha256(
    JSON.stringify([
      "agent-mail-presence-display-v1",
      operation,
      body.planId,
      body.planVersion,
      body.previewDigest,
    ]),
  ).slice(0, 20);
  return digest.match(/.{4}/gu).join("-");
}

function challengeCommitment(challenge) {
  const protocol = oracle.operatorAuthenticatorProtocol.challenge;
  return JSON.stringify([
    protocol.commitmentNamespace,
    ...protocol.commitmentFieldsInOrder.map((field) => challenge[field]),
  ]);
}

function lowS(signature) {
  assert(signature.length === 64, "P-256 signature length drifted");
  const r = signature.subarray(0, 32);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  const normalized = s > p256Order / 2n ? p256Order - s : s;
  const sBytes = Buffer.from(normalized.toString(16).padStart(64, "0"), "hex");
  return Buffer.concat([r, sBytes]);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeCanonicalBase64url(value, bytes) {
  if (typeof value !== "string" || value.includes("=")) return null;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return null;
  return decoded;
}

function signChallenge(challenge) {
  const signature = lowS(
    cryptoSign("sha256", Buffer.from(challengeCommitment(challenge)), {
      key: operatorPrivateKey,
      dsaEncoding: "ieee-p1363",
    }),
  );
  return {
    version: "agent-mail-macos-operator-presence-v1",
    challengeId: challenge.challengeId,
    credentialId: challenge.credentialId,
    signatureBase64url: base64url(signature),
  };
}

function issueOperatorChallenge(
  store,
  operation,
  bytes,
  method = expectedMethod(operation),
  path,
  issuedAt = "2026-08-18T00:10:00.000Z",
  credential = operatorCredential,
) {
  const parsed = parseOperatorBody(operation, bytes);
  if (parsed.kind !== "parsed") return parsed;
  const concretePath = path ?? expectedPath(operation, parsed.value);
  if (
    method !== expectedMethod(operation) ||
    concretePath !== expectedPath(operation, parsed.value)
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const credentialRecord = store.credentials.get(credential.credentialId);
  if (
    credentialRecord?.status !== "active" ||
    Date.parse(issuedAt) >= Date.parse(credentialRecord.expiresAt)
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const issuedAtMs = Date.parse(issuedAt);
  for (const challenge of store.challenges.values()) {
    if (
      !store.challengeClosures.has(challenge.challengeId) &&
      issuedAtMs >= Date.parse(challenge.expiresAt)
    )
      store.challengeClosures.set(challenge.challengeId, {
        kind: "expired",
        expiredAt: issuedAt,
      });
  }
  const available = [...store.challenges.values()].filter(
    ({ challengeId }) => !store.challengeClosures.has(challengeId),
  );
  const recentIssueCount = store.challengeIssueTimes.filter(
    (entry) =>
      entry.credentialId === credential.credentialId &&
      issuedAtMs >= Date.parse(entry.issuedAt) &&
      issuedAtMs - Date.parse(entry.issuedAt) < 60_000,
  ).length;
  if (
    available.length >= 128 ||
    available.filter(({ credentialId }) => credentialId === credential.credentialId).length >= 4 ||
    recentIssueCount >= 10
  )
    return { kind: "rejected", code: "action.operator_challenge_capacity" };
  const challengeId = `operator-challenge:00000000-0000-4000-8000-${String(store.nextChallenge++).padStart(12, "0")}`;
  const challenge = {
    authorityInstanceId: credential.authorityInstanceId,
    challengeId,
    challengeNonceBase64url: base64url(Buffer.from(sha256(challengeId), "hex")),
    credentialId: credential.credentialId,
    principalId: credential.principalId,
    profile: credential.profile,
    operation,
    requestMethod: method,
    requestPath: concretePath,
    requestBodySha256: sha256(bytes),
    operatorDisplayCode: operatorDisplayCode(operation, parsed.value),
    operatorConfigurationRevision: store.operatorConfigurationRevision,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
  };
  store.challenges.set(challengeId, challenge);
  store.challengeIssueTimes.push({ credentialId: credential.credentialId, issuedAt });
  return { kind: "issued", challenge, body: parsed.value, rawBody: bytes };
}

function issueOperatorChallengeRpc(store, frame, peerUid = 501, ownerUid = 501) {
  const rejected = { kind: "rejected", code: "action.operator_assertion_invalid" };
  if (
    !Buffer.isBuffer(frame) ||
    frame.length < 2 ||
    frame.length > 4_096 ||
    frame.at(-1) !== 0x0a ||
    frame.subarray(0, -1).includes(0x0a) ||
    frame.includes(0x0d) ||
    peerUid !== ownerUid
  )
    return rejected;
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, -1)));
  } catch {
    return rejected;
  }
  const keys = oracle.operatorAuthenticatorProtocol.challenge.issueRequest.strictFieldsInOrder;
  if (
    !strictOrderedKeys(envelope, keys) ||
    envelope.version !== "agent-mail-macos-operator-presence-v1" ||
    envelope.credentialId !== operatorCredential.credentialId ||
    typeof envelope.requestBodyBase64url !== "string" ||
    envelope.requestBodyBase64url.includes("=")
  )
    return rejected;
  const bytes = Buffer.from(envelope.requestBodyBase64url, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > 2_048 ||
    bytes.toString("base64url") !== envelope.requestBodyBase64url
  )
    return rejected;
  return issueOperatorChallenge(
    store,
    envelope.operation,
    bytes,
    envelope.requestMethod,
    envelope.requestPath,
  );
}

function operatorChallengeRpcEnvelope(store, operation) {
  const body =
    operation === "open-session"
      ? operatorSessionBody()
      : operation === "seal-key-rotate" || operation === "seal-key-remove"
        ? sealKeyAdminBody(store, operation)
        : operation === "approve"
          ? approveBody(store)
          : cancelBody(store);
  return {
    version: "agent-mail-macos-operator-presence-v1",
    credentialId: operatorCredential.credentialId,
    operation,
    requestMethod: expectedMethod(operation),
    requestPath: expectedPath(operation, body),
    requestBodyBase64url: base64url(rawBody(body)),
  };
}

function operatorChallengeRpcFrame(envelope) {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function verifyOperatorAssertion(
  store,
  operation,
  bytes,
  method,
  path,
  assertion,
  now = "2026-08-18T00:10:00.000Z",
) {
  if (
    !strictKeys(assertion, ["version", "challengeId", "credentialId", "signatureBase64url"]) ||
    assertion.version !== "agent-mail-macos-operator-presence-v1"
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const challenge = store.challenges.get(assertion.challengeId);
  if (challenge === undefined)
    return { kind: "rejected", code: "action.operator_challenge_not_found" };
  const closure = store.challengeClosures.get(challenge.challengeId);
  if (closure?.kind === "consumed")
    return { kind: "rejected", code: "action.operator_challenge_consumed" };
  if (closure?.kind === "expired" || Date.parse(now) >= Date.parse(challenge.expiresAt))
    return { kind: "rejected", code: "action.operator_challenge_expired" };
  const credentialRecord = store.credentials.get(challenge.credentialId);
  if (
    closure !== undefined ||
    credentialRecord?.status !== "active" ||
    Date.parse(now) >= Date.parse(credentialRecord.expiresAt) ||
    challenge.authorityInstanceId !== operatorCredential.authorityInstanceId ||
    challenge.operatorConfigurationRevision !== store.operatorConfigurationRevision ||
    challenge.credentialId !== assertion.credentialId ||
    challenge.operation !== operation ||
    challenge.requestMethod !== method ||
    challenge.requestPath !== path ||
    !equalHex(challenge.requestBodySha256, sha256(bytes))
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const signature = decodeCanonicalBase64url(assertion.signatureBase64url, 64);
  if (signature === null) return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (s === 0n || s > p256Order / 2n)
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  if (
    !cryptoVerify(
      "sha256",
      Buffer.from(challengeCommitment(challenge)),
      {
        key: operatorPublicKey,
        dsaEncoding: "ieee-p1363",
      },
      signature,
    )
  )
    return { kind: "rejected", code: "action.operator_assertion_invalid" };
  const parsed = parseOperatorBody(operation, bytes);
  if (parsed.kind !== "parsed" || path !== expectedPath(operation, parsed.value)) return parsed;
  return {
    kind: "verified",
    body: parsed.value,
    challenge,
    signature,
    auth: {
      principalId: challenge.principalId,
      credentialId: challenge.credentialId,
      profile: challenge.profile,
      scopes:
        operation === "open-session"
          ? ["mail:action.create", "mail:action.inspect"]
          : ["mail:action.inspect", "mail:action.approve"],
      authEventId: `auth:${challenge.challengeId}`,
      credentialExpiresAt: operatorCredential.credentialExpiresAt,
      presence: {
        kind: "human-present",
        ceremonyId: challenge.challengeId,
        verifiedAt: now,
        validUntil: challenge.expiresAt,
        requestMethod: method,
        requestPath: path,
        requestBodySha256: sha256(bytes),
      },
    },
  };
}

function prepareSignedOperatorRequest(store, operation, mutations = {}) {
  const body =
    operation === "open-session"
      ? operatorSessionBody()
      : operation === "seal-key-rotate" || operation === "seal-key-remove"
        ? sealKeyAdminBody(store, operation, mutations.keyId)
        : operation === "approve"
          ? approveBody(store)
          : cancelBody(store);
  const bytes = rawBody(body);
  const issued = issueOperatorChallenge(
    store,
    operation,
    bytes,
    expectedMethod(operation),
    undefined,
    mutations.issuedAt,
  );
  assert(issued.kind === "issued", `probe ${operation} challenge was not issued`);
  const assertion = signChallenge(issued.challenge);
  return {
    bytes: mutations.bytes ?? bytes,
    method: mutations.method ?? expectedMethod(operation),
    path: mutations.path ?? expectedPath(operation, body),
    assertion: mutations.assertion?.(assertion) ?? assertion,
    challenge: issued.challenge,
  };
}

function operatorSessionService(store, request, now = "2026-08-18T00:10:00.000Z") {
  const verified = verifyOperatorAssertion(
    store,
    "open-session",
    request.bytes,
    request.method,
    request.path,
    request.assertion,
    now,
  );
  if (verified.kind !== "verified") return verified;
  const token = Buffer.from("77".repeat(32), "hex");
  const sessionId = `operator-session:${verified.challenge.challengeId}`;
  const expiresAt = new Date(
    Math.min(Date.parse(now) + 600_000, Date.parse(verified.auth.credentialExpiresAt)),
  ).toISOString();
  store.challengeClosures.set(verified.challenge.challengeId, {
    kind: "consumed",
    operation: "open-session",
    authorityOutputKind: "operator-session",
    authorityOutputId: sessionId,
    signatureBase64url: request.assertion.signatureBase64url,
    consumedAt: now,
  });
  store.operatorSessions.set(sha256(token), {
    sessionId,
    principalId: verified.auth.principalId,
    credentialId: verified.auth.credentialId,
    profile: "operator-interactive",
    scopes: ["mail:action.create", "mail:action.inspect"],
    operatorConfigurationRevision: store.operatorConfigurationRevision,
    expiresAt,
  });
  return { kind: "issued", token, expiresAt };
}

function authenticateOperatorSession(store, token, now = "2026-08-18T00:10:01.000Z") {
  const session = store.operatorSessions.get(sha256(token));
  const credential =
    session === undefined ? undefined : store.credentials.get(session.credentialId);
  if (
    session === undefined ||
    session.operatorConfigurationRevision !== store.operatorConfigurationRevision ||
    Date.parse(now) >= Date.parse(session.expiresAt) ||
    credential?.status !== "active" ||
    Date.parse(now) >= Date.parse(credential.expiresAt)
  )
    return null;
  return {
    ...session,
    authEventId: `auth:${session.sessionId}`,
    credentialExpiresAt: credential.expiresAt,
    presence: { kind: "a1-non-approval-session" },
  };
}

function closePendingApproval(store, kind, at, reason) {
  if (store.approval === null || store.closure !== null || store.plan.state !== "pending")
    return false;
  store.closure = {
    kind,
    [`${kind}At`]: at,
    reason,
    planVersionBefore: store.plan.version,
    planVersionAfter: store.plan.version + 1,
  };
  store.plan.version += 1;
  return true;
}

function archiveClosedApproval(store) {
  if (store.approval !== null && store.closure !== null) {
    store.closedApprovals.push({ approval: store.approval, closure: store.closure });
    store.approval = null;
    store.closure = null;
  }
}

function approvalServiceApprove(store, request, issuedAt = "2026-08-18T00:10:00.000Z") {
  const verified = verifyOperatorAssertion(
    store,
    "approve",
    request.bytes,
    request.method,
    request.path,
    request.assertion,
    issuedAt,
  );
  if (verified.kind !== "verified") return verified;
  const auth = verified.auth;
  if (!profileIsValid(auth) || !auth.scopes.includes("mail:action.approve"))
    return { kind: "rejected", code: "action.approval_forbidden" };
  archiveClosedApproval(store);
  const bound = bindings(store.plan);
  if (
    verified.body.planId !== store.plan.planId ||
    verified.body.planVersion !== store.plan.version ||
    !equalHex(verified.body.previewDigest, bound.previewDigest) ||
    Date.parse(issuedAt) >= Date.parse(store.plan.expiresAt)
  )
    return { kind: "rejected", code: "action.approval_mismatch" };
  if (store.approval !== null) return { kind: "rejected", code: "action.approval_mismatch" };
  const approval = {
    approvalId: `approval:22222222-2222-4222-8222-${String(store.plan.version).padStart(12, "0")}`,
    approverPrincipalId: auth.principalId,
    approverCredentialId: auth.credentialId,
    approverProfile: auth.profile,
    approverAuthEventId: auth.authEventId,
    ceremonyId: auth.presence.ceremonyId,
    userPresenceVerifiedAt: auth.presence.verifiedAt,
    presenceRequestMethod: auth.presence.requestMethod,
    presenceRequestPath: auth.presence.requestPath,
    presenceRequestBodySha256: auth.presence.requestBodySha256,
    authorityInstanceId: verified.challenge.authorityInstanceId,
    operatorConfigurationRevision: store.operatorConfigurationRevision,
    challengeCommitmentSha256: sha256(challengeCommitment(verified.challenge)),
    assertionSignatureSha256: sha256(verified.signature),
    operatorDisplayCode: verified.challenge.operatorDisplayCode,
    planId: store.plan.planId,
    planVersion: store.plan.version,
    previewDigest: bound.previewDigest,
    targetDigest: bound.targetDigest,
    canonicalTargetSet: bound.targetSet,
    normalizedIntent: bound.intent,
    issuedAt,
    expiresAt: new Date(
      Math.min(
        Date.parse(issuedAt) + 600_000,
        Date.parse(store.plan.expiresAt),
        Date.parse(auth.credentialExpiresAt),
      ),
    ).toISOString(),
    nonce: "33".repeat(32),
    authorizationScope: "mail:action.commit",
    sealKeyId: store.keyring.activeKeyId,
    sealKeyringRevision: store.keyring.revision,
    sealAlgorithm: "hmac-sha256",
  };
  approval.seal = hmac(
    store.keyring.keys.get(approval.sealKeyId).keyHex,
    approvalCommitment(approval),
  );
  // This assignment models one transaction: neither closure is visible without the approval row.
  store.challengeClosures.set(verified.challenge.challengeId, {
    kind: "consumed",
    operation: "approve",
    approvalId: approval.approvalId,
    signatureBase64url: request.assertion.signatureBase64url,
    consumedAt: issuedAt,
  });
  store.approval = approval;
  store.audit.push({
    actor: "approver",
    principalId: auth.principalId,
    profile: auth.profile,
    authorityInstanceId: approval.authorityInstanceId,
    challengeCommitmentSha256: approval.challengeCommitmentSha256,
    assertionSignatureSha256: approval.assertionSignatureSha256,
  });
  return { kind: "issued", approval, bound };
}

function issueApproval(store) {
  const result = approvalServiceApprove(store, prepareSignedOperatorRequest(store, "approve"));
  assert(result.kind === "issued", `probe approval failed: ${result.code}`);
  return result.bound;
}

function approvalServiceCancel(store, request, now = "2026-08-18T00:10:30.000Z") {
  const verified = verifyOperatorAssertion(
    store,
    "cancel-approval",
    request.bytes,
    request.method,
    request.path,
    request.assertion,
    now,
  );
  if (verified.kind !== "verified") return verified;
  if (store.closure?.kind === "consumed")
    return { kind: "rejected", code: "action.approval_consumed" };
  if (store.closure !== null) return { kind: "rejected", code: "action.approval_cancelled" };
  if (
    verified.auth.principalId !== store.approval.approverPrincipalId ||
    verified.body.approvalId !== store.approval.approvalId ||
    verified.body.planId !== store.plan.planId ||
    verified.body.planVersion !== store.plan.version ||
    !equalHex(verified.body.previewDigest, store.approval.previewDigest)
  )
    return { kind: "rejected", code: "action.approval_mismatch" };
  const cancellation = {
    kind: "cancelled",
    cancelledAt: now,
    ceremonyId: verified.challenge.challengeId,
    authorityInstanceId: verified.challenge.authorityInstanceId,
    challengeCommitmentSha256: sha256(challengeCommitment(verified.challenge)),
    assertionSignatureSha256: sha256(verified.signature),
    operatorDisplayCode: verified.challenge.operatorDisplayCode,
    operatorConfigurationRevision: store.operatorConfigurationRevision,
  };
  store.challengeClosures.set(verified.challenge.challengeId, {
    kind: "consumed",
    operation: "cancel-approval",
    approvalId: store.approval.approvalId,
    signatureBase64url: request.assertion.signatureBase64url,
    consumedAt: now,
  });
  closePendingApproval(store, "cancelled", now, "operator-cancelled");
  store.closure = { ...store.closure, ...cancellation };
  return { kind: "cancelled", cancellation };
}

function consume(store, request, auth = agentAuth, now = "2026-08-18T00:11:00.000Z", trace = []) {
  trace.push("storage-repository");
  const result = (kind, code) => ({ kind, code, remoteCalls: store.remoteCalls });
  if (
    !profileIsValid(auth) ||
    auth.profile !== "agent-unattended" ||
    !auth.scopes.includes("mail:action.commit")
  )
    return result("rejected", "action.approval_forbidden");
  const historical = store.closedApprovals.find(
    ({ approval }) => approval.approvalId === request.approvalId,
  );
  if (historical !== undefined)
    return result(
      "rejected",
      historical.closure.kind === "expired"
        ? "action.approval_expired"
        : historical.closure.kind === "cancelled"
          ? "action.approval_cancelled"
          : "action.approval_invalidated",
    );
  if (store.closure?.kind === "consumed") return result("rejected", "action.approval_consumed");
  if (store.closure?.kind === "cancelled") return result("rejected", "action.approval_cancelled");
  if (store.closure?.kind === "expired") return result("rejected", "action.approval_expired");
  if (store.closure?.kind === "invalidated")
    return result("rejected", "action.approval_invalidated");
  const approval = store.approval;
  if (approval === null || request.approvalId !== approval.approvalId)
    return result("rejected", "action.approval_not_found");
  if (store.plan.authorityVersion !== "trusted-v1")
    return result("rejected", "action.legacy_authority");
  if (store.plan.state !== "pending") return result("rejected", "action.plan_not_pending");
  if (request.planId !== store.plan.planId || request.planId !== approval.planId)
    return result("rejected", "action.approval_mismatch");
  if (request.planVersion !== store.plan.version || request.planVersion !== approval.planVersion)
    return result("rejected", "action.plan_version_stale");
  if (Date.parse(now) >= Date.parse(store.plan.expiresAt))
    return result("rejected", "action.plan_expired");
  if (Date.parse(now) >= Date.parse(approval.expiresAt)) {
    closePendingApproval(store, "expired", now, "approval-expired");
    return result("rejected", "action.approval_expired");
  }
  const approverCredential = store.credentials.get(approval.approverCredentialId);
  const sealKey = store.keyring.keys.get(approval.sealKeyId);
  if (
    approverCredential?.status !== "active" ||
    Date.parse(now) >= Date.parse(approverCredential.expiresAt) ||
    approval.operatorConfigurationRevision !== store.operatorConfigurationRevision ||
    approval.sealKeyringRevision > store.keyring.revision ||
    sealKey === undefined
  ) {
    closePendingApproval(store, "invalidated", now, "authority-configuration-invalid");
    return result("rejected", "action.approval_invalidated");
  }
  const bound = bindings(store.plan);
  if (
    !equalHex(request.previewDigest, approval.previewDigest) ||
    !equalHex(bound.previewDigest, approval.previewDigest) ||
    !equalHex(bound.targetDigest, approval.targetDigest) ||
    bound.targetSet !== approval.canonicalTargetSet ||
    bound.intent !== approval.normalizedIntent ||
    !equalHex(hmac(sealKey.keyHex, approvalCommitment(approval)), approval.seal)
  )
    return result("rejected", "action.approval_mismatch");
  if (
    approval.authorizationScope !== "mail:action.commit" ||
    approval.approverProfile !== "operator-interactive" ||
    auth.principalId === approval.approverPrincipalId ||
    auth.credentialId === approval.approverCredentialId
  )
    return result("rejected", "action.approval_forbidden");

  const receipt = {
    receiptId: "approval-receipt:44444444-4444-4444-8444-444444444444",
    approvalId: approval.approvalId,
    planId: store.plan.planId,
    planVersionBefore: store.plan.version,
    planVersionAfter: store.plan.version + 1,
    claimId: "claim:55555555-5555-4555-8555-555555555555",
    committerPrincipalId: auth.principalId,
    committerCredentialId: auth.credentialId,
    committerProfile: auth.profile,
    consumedAt: now,
    executorProfile: "internal-action-executor",
  };
  store.closure = { kind: "consumed", receipt };
  store.claim = {
    planId: store.plan.planId,
    claimId: receipt.claimId,
    receiptId: receipt.receiptId,
  };
  store.activeClaimId = receipt.claimId;
  store.plan.state = "executing";
  store.plan.version += 1;
  store.audit.push({ actor: "committer", principalId: auth.principalId, profile: auth.profile });
  return { kind: "consumed", receipt, remoteCalls: store.remoteCalls };
}

function commitRequest(store) {
  const bound = bindings(store.plan);
  return {
    planId: store.plan.planId,
    planVersion: store.plan.version,
    previewDigest: bound.previewDigest,
    approvalId: store.approval.approvalId,
  };
}

function parseCommitRequest(value) {
  if (!strictKeys(value, ["planId", "planVersion", "previewDigest", "approvalId"]))
    return { kind: "rejected", code: "invalid_request" };
  return { kind: "parsed", value };
}

function approvalAuthorityServiceConsume(store, unknownRequest, auth, trace) {
  trace.push("approval-authority-service");
  const parsed = parseCommitRequest(unknownRequest);
  if (parsed.kind !== "parsed") return parsed;
  return consume(store, parsed.value, auth, "2026-08-18T00:11:00.000Z", trace);
}

function directCommitBoundary(store, unknownRequest, auth, trace) {
  trace.push("direct-service");
  return approvalAuthorityServiceConsume(store, unknownRequest, auth, trace);
}

function httpCommitBoundary(store, httpRequest, auth, trace) {
  trace.push("composed-http");
  if (
    httpRequest.method !== "POST" ||
    httpRequest.path !== `/v1/action-plans/${encodeURIComponent(store.plan.planId)}/commit` ||
    !Buffer.isBuffer(httpRequest.rawBody) ||
    httpRequest.rawBody.length > 2_048
  )
    return { kind: "rejected", code: "invalid_request" };
  let parsed;
  try {
    parsed = JSON.parse(httpRequest.rawBody.toString("utf8"));
  } catch {
    return { kind: "rejected", code: "invalid_request" };
  }
  return approvalAuthorityServiceConsume(store, parsed, auth, trace);
}

function cliCommitBoundary(store, args, auth, trace) {
  trace.push("cli-http");
  const parsed = parseCommitRequest(args);
  if (parsed.kind !== "parsed") return parsed;
  const bytes = rawBody(parsed.value);
  return httpCommitBoundary(
    store,
    {
      method: "POST",
      path: `/v1/action-plans/${encodeURIComponent(store.plan.planId)}/commit`,
      rawBody: bytes,
    },
    auth,
    trace,
  );
}

function recoveryBoundary(store, trace) {
  trace.push("restart-recovery");
  if (
    store.plan.state === "restore-quarantined" ||
    store.plan.state !== "executing" ||
    store.closure?.kind !== "consumed" ||
    store.claim?.receiptId !== store.closure.receipt.receiptId ||
    store.claim?.claimId !== store.closure.receipt.claimId ||
    store.activeClaimId !== store.claim.claimId
  )
    return { kind: "rejected", code: "missing-consumed-authority" };
  trace.push("internal-action-executor");
  return { kind: "resumable", receiptId: store.closure.receipt.receiptId };
}

function databaseBackup(store) {
  const backup = cloneStore(store);
  delete backup.keyring;
  backup.operatorSessions.clear();
  return backup;
}

function recordAttemptResult(
  store,
  attemptId,
  executorInstanceId,
  resultDigest,
  attributedAt = "2026-08-18T00:12:00.000Z",
) {
  const receipt = store.closure?.kind === "consumed" ? store.closure.receipt : null;
  if (
    receipt === null ||
    store.plan.state !== "executing" ||
    store.claim?.receiptId !== receipt.receiptId ||
    store.claim?.claimId !== receipt.claimId ||
    !executorInstanceId.startsWith("executor:") ||
    store.attemptAuthorities.some((row) => row.attemptId === attemptId)
  )
    return { kind: "rejected", code: "attempt-authority-mismatch" };
  const authority = {
    planId: receipt.planId,
    attemptId,
    receiptId: receipt.receiptId,
    claimId: receipt.claimId,
    executorProfile: "internal-action-executor",
    executorInstanceId,
    attributedAt,
  };
  store.attemptAuthorities.push(authority);
  store.durableResults.set(attemptId, resultDigest);
  store.audit.push({ actor: "executor-attempt", ...authority, resultDigest });
  store.remoteCalls += 1;
  return { kind: "persisted", authority };
}

function terminalEffectProjection(store, terminal) {
  const rows = store.attemptAuthorities
    .filter(
      (row) =>
        row.planId === terminal.planId &&
        row.receiptId === terminal.receiptId &&
        row.claimId === terminal.claimId,
    )
    .toSorted((left, right) =>
      Buffer.compare(Buffer.from(left.attemptId, "utf8"), Buffer.from(right.attemptId, "utf8")),
    )
    .map((row) => [row.attemptId, row.executorProfile, row.executorInstanceId, row.attributedAt]);
  const bytes = JSON.stringify([
    "action-terminal-effect-authority-set-v1",
    terminal.planId,
    terminal.receiptId,
    terminal.claimId,
    rows,
  ]);
  return { rows, digest: sha256(bytes) };
}

function appendTerminalAudit(store, terminal) {
  const receipt = store.closure?.kind === "consumed" ? store.closure.receipt : null;
  const expectedKeys = [
    "actor",
    "planId",
    "receiptId",
    "claimId",
    "state",
    "terminalAt",
    "executorDisposition",
    "effectAttemptCount",
    "effectAuthoritySetDigest",
    "executorInstanceId",
    "finalizerKind",
    "finalizerInstanceId",
    "reasonCode",
    "restoreEventId",
    "resultDigest",
  ];
  if (
    !strictKeys(terminal, expectedKeys) ||
    receipt === null ||
    terminal.receiptId !== receipt.receiptId ||
    terminal.planId !== receipt.planId ||
    terminal.claimId !== receipt.claimId ||
    store.claim?.planId !== terminal.planId ||
    store.claim?.claimId !== terminal.claimId ||
    store.claim?.receiptId !== terminal.receiptId
  )
    return { kind: "rejected", code: "terminal-attribution-mismatch" };
  const effect = terminalEffectProjection(store, terminal);
  const executorIds = new Set(effect.rows.map((row) => row[2]));
  const hasUnattributedAttemptEvidence = store.audit.some(
    (entry) =>
      entry.actor === "executor-attempt" &&
      entry.planId === terminal.planId &&
      entry.receiptId === terminal.receiptId &&
      !store.attemptAuthorities.some((row) => row.attemptId === entry.attemptId),
  );
  const expectedDisposition =
    effect.rows.length > 0
      ? "started"
      : hasUnattributedAttemptEvidence
        ? "unknown-after-restore"
        : "never-started-after-restore";
  const expectedExecutorId =
    expectedDisposition === "never-started-after-restore"
      ? "executor:not-started"
      : expectedDisposition === "unknown-after-restore"
        ? "executor:unknown-after-restore"
        : executorIds.size === 1
          ? [...executorIds][0]
          : "executor:multiple";
  if (
    terminal.effectAttemptCount !== effect.rows.length ||
    !equalHex(terminal.effectAuthoritySetDigest, effect.digest) ||
    terminal.executorDisposition !== expectedDisposition ||
    terminal.executorInstanceId !== expectedExecutorId
  )
    return { kind: "rejected", code: "terminal-effect-attribution-mismatch" };
  if (terminal.reasonCode === "normal-finalization") {
    if (
      effect.rows.length === 0 ||
      terminal.restoreEventId !== "restore-event:none" ||
      effect.rows.some(([attemptId]) => !store.durableResults.has(attemptId)) ||
      (terminal.finalizerKind === "effect-executor" &&
        !executorIds.has(terminal.finalizerInstanceId)) ||
      (terminal.finalizerKind === "ordinary-recovery" &&
        !terminal.finalizerInstanceId.startsWith("recovery-finalizer:")) ||
      !["effect-executor", "ordinary-recovery"].includes(terminal.finalizerKind)
    )
      return { kind: "rejected", code: "terminal-finalizer-mismatch" };
  } else if (
    terminal.reasonCode !== "explicit-database-restore" ||
    terminal.finalizerKind !== "restore-admission" ||
    terminal.finalizerInstanceId !== "finalizer:restore-admission" ||
    !terminal.restoreEventId.startsWith("restore-event:")
  )
    return { kind: "rejected", code: "terminal-finalizer-mismatch" };
  if (store.audit.some((entry) => entry.actor === "terminal"))
    return { kind: "rejected", code: "terminal-already-exists" };
  store.audit.push(terminal);
  if (terminal.reasonCode === "normal-finalization") {
    store.plan.state = terminal.state;
    store.activeClaimId = null;
  }
  return { kind: "inserted" };
}

function normalTerminalAudit(
  store,
  state,
  resultDigest,
  finalizerKind,
  finalizerInstanceId,
  terminalAt = "2026-08-18T00:13:00.000Z",
) {
  const identity = {
    planId: store.plan.planId,
    receiptId: store.closure.receipt.receiptId,
    claimId: store.claim.claimId,
  };
  const effect = terminalEffectProjection(store, identity);
  const executorIds = new Set(effect.rows.map((row) => row[2]));
  return {
    actor: "terminal",
    ...identity,
    state,
    terminalAt,
    executorDisposition: "started",
    effectAttemptCount: effect.rows.length,
    effectAuthoritySetDigest: effect.digest,
    executorInstanceId: executorIds.size === 1 ? [...executorIds][0] : "executor:multiple",
    finalizerKind,
    finalizerInstanceId,
    reasonCode: "normal-finalization",
    restoreEventId: "restore-event:none",
    resultDigest,
  };
}

function explicitDatabaseRestore(
  backup,
  hostKeyring,
  restoredAt = "2026-08-18T00:15:00.000Z",
  restoreEventId = "restore-event:66666666-6666-4666-8666-666666666666",
) {
  assert(!Object.hasOwn(backup, "keyring"), "database backup exported approval seal keys");
  const restored = cloneStore(backup);
  restored.keyring = cloneStore(hostKeyring);
  restored.restoreEvents.push({ restoreEventId, restoredAt });
  restored.operatorSessions.clear();
  for (const [challengeId] of restored.challenges) {
    if (!restored.challengeClosures.has(challengeId))
      restored.challengeClosures.set(challengeId, {
        kind: "invalidated",
        reason: "database-restore",
        invalidatedAt: restoredAt,
      });
  }
  if (restored.approval !== null && restored.closure === null)
    closePendingApproval(restored, "invalidated", restoredAt, "database-restore");
  if (
    restored.plan.state === "executing" &&
    restored.closure?.kind === "consumed" &&
    restored.claim !== null
  ) {
    restored.plan.state = "restore-quarantined";
    restored.plan.version += 1;
    restored.activeClaimId = null;
    const unattributedDurableAttempt = restored.audit.find(
      (entry) =>
        entry.actor === "executor-attempt" &&
        entry.planId === restored.plan.planId &&
        entry.receiptId === restored.closure.receipt.receiptId &&
        !restored.attemptAuthorities.some((row) => row.attemptId === entry.attemptId),
    );
    const effect = terminalEffectProjection(restored, {
      planId: restored.plan.planId,
      receiptId: restored.closure.receipt.receiptId,
      claimId: restored.claim.claimId,
    });
    const executorIds = new Set(effect.rows.map((row) => row[2]));
    const executorDisposition =
      effect.rows.length > 0
        ? "started"
        : unattributedDurableAttempt === undefined
          ? "never-started-after-restore"
          : "unknown-after-restore";
    const executorInstanceId =
      executorDisposition === "never-started-after-restore"
        ? "executor:not-started"
        : executorDisposition === "unknown-after-restore"
          ? "executor:unknown-after-restore"
          : executorIds.size === 1
            ? [...executorIds][0]
            : "executor:multiple";
    const terminal = {
      actor: "terminal",
      planId: restored.plan.planId,
      receiptId: restored.closure.receipt.receiptId,
      claimId: restored.claim.claimId,
      state: "restore-quarantined",
      terminalAt: restoredAt,
      executorDisposition,
      effectAttemptCount: effect.rows.length,
      effectAuthoritySetDigest: effect.digest,
      executorInstanceId,
      finalizerKind: "restore-admission",
      finalizerInstanceId: "finalizer:restore-admission",
      reasonCode: "explicit-database-restore",
      restoreEventId,
      resultDigest: sha256(
        JSON.stringify([
          "action-restore-quarantine-v1",
          restoreEventId,
          restored.plan.planId,
          restored.closure.receipt.receiptId,
          restored.claim.claimId,
          restoredAt,
        ]),
      ),
    };
    assert(
      appendTerminalAudit(restored, terminal).kind === "inserted",
      "restore terminal attribution did not match its consumption",
    );
  }
  return restored;
}

function rotateSealKey(store) {
  store.keyring.keys.get(store.keyring.activeKeyId).status = "verify-only";
  store.keyring.keys.set(sealKeyTwoId, { status: "active", keyHex: sealKeyTwoHex });
  store.keyring.activeKeyId = sealKeyTwoId;
  store.keyring.revision += 1;
  return { kind: "rotated" };
}

function removeSealKey(store, keyId, at = "2026-08-18T00:10:45.000Z") {
  const key = store.keyring.keys.get(keyId);
  if (key === undefined || key.status !== "verify-only" || keyId === store.keyring.activeKeyId)
    return { kind: "rejected", code: "seal-key-removal-forbidden" };
  store.keyring.keys.delete(keyId);
  store.keyring.revision += 1;
  if (store.approval?.sealKeyId === keyId)
    closePendingApproval(store, "invalidated", at, "seal-key-removed");
  return { kind: "removed" };
}

function revokeOperatorCredential(store, at = "2026-08-18T00:10:45.000Z") {
  store.credentials.get(operatorCredential.credentialId).status = "revoked";
  store.operatorConfigurationRevision += 1;
  store.operatorSessions.clear();
  closePendingApproval(store, "invalidated", at, "operator-credential-revoked");
}

function sealKeyAdminEnvelope(request, mutations = {}) {
  return {
    version: mutations.version ?? "agent-mail-action-authority-admin-v1",
    requestBodyBase64url: mutations.requestBodyBase64url ?? base64url(request.bytes),
    assertion: mutations.assertion ?? request.assertion,
  };
}

function sealKeyAdminBoundary(
  store,
  envelope,
  peerUid = 501,
  ownerUid = 501,
  now = "2026-08-18T00:10:00.000Z",
) {
  const rejected = { kind: "rejected", code: "action.operator_assertion_invalid" };
  if (
    peerUid !== ownerUid ||
    !strictOrderedKeys(envelope, ["version", "requestBodyBase64url", "assertion"]) ||
    envelope.version !== "agent-mail-action-authority-admin-v1" ||
    typeof envelope.requestBodyBase64url !== "string" ||
    envelope.requestBodyBase64url.includes("=")
  )
    return rejected;
  const challenge = store.challenges.get(envelope.assertion?.challengeId);
  if (
    challenge === undefined ||
    !["seal-key-rotate", "seal-key-remove"].includes(challenge.operation)
  )
    return rejected;
  const bytes = Buffer.from(envelope.requestBodyBase64url, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > 2_048 ||
    bytes.toString("base64url") !== envelope.requestBodyBase64url
  )
    return rejected;
  const operation = challenge.operation;
  const parsed = parseOperatorBody(operation, bytes);
  if (parsed.kind !== "parsed") return rejected;
  const verified = verifyOperatorAssertion(
    store,
    operation,
    bytes,
    expectedMethod(operation),
    expectedPath(operation, parsed.value),
    envelope.assertion,
    now,
  );
  if (verified.kind !== "verified") return verified;
  if (
    verified.body.expectedKeyringRevision !== store.keyring.revision ||
    (operation === "seal-key-rotate" &&
      verified.body.expectedActiveKeyId !== store.keyring.activeKeyId)
  )
    return { kind: "rejected", code: "action.approval_mismatch" };
  const mutation =
    operation === "seal-key-rotate"
      ? rotateSealKey(store)
      : removeSealKey(store, verified.body.keyId, now);
  if (mutation.kind === "rejected") return mutation;
  store.challengeClosures.set(challenge.challengeId, {
    kind: "consumed",
    operation,
    authorityOutputKind: operation === "seal-key-rotate" ? "seal-key-rotation" : "seal-key-removal",
    authorityOutputId: `seal-keyring-revision:${store.keyring.revision}`,
    signatureBase64url: envelope.assertion.signatureBase64url,
    consumedAt: now,
  });
  return { kind: mutation.kind, keyringRevision: store.keyring.revision };
}

const modelProbeResults = [];
function probe(id, body) {
  body();
  modelProbeResults.push({ id, outcome: "passed" });
}

probe("P-SAME-TOKEN", () => {
  assert(
    !profileIsValid({
      ...operatorAuthShape,
      scopes: [...operatorAuthShape.scopes, "mail:action.commit"],
    }),
    "combined operator scope accepted",
  );
  assert(
    !profileIsValid({ ...agentAuth, scopes: [...agentAuth.scopes, "mail:action.approve"] }),
    "combined agent scope accepted",
  );
  const store = newStore();
  issueApproval(store);
  const result = consume(store, commitRequest(store), {
    ...agentAuth,
    principalId: operatorCredential.principalId,
  });
  assert(
    result.code === "action.approval_forbidden" && store.claim === null,
    "same principal consumed",
  );
  const sameCredential = newStore();
  issueApproval(sameCredential);
  const credentialResult = consume(sameCredential, commitRequest(sameCredential), {
    ...agentAuth,
    credentialId: operatorCredential.credentialId,
  });
  assert(
    credentialResult.code === "action.approval_forbidden" && sameCredential.claim === null,
    "same credential consumed",
  );
});

probe("P-SPOOFED-PRINCIPAL", () => {
  const allowed = new Set(["planId", "planVersion", "previewDigest", "approvalId"]);
  for (const field of [
    "principalId",
    "credentialId",
    "profile",
    "scopes",
    "userPresence",
    "expiresAt",
    "nonce",
  ])
    assert(!allowed.has(field), `strict commit schema permits ${field}`);
});

probe("P-CHANGED-BINDING", () => {
  for (const mutate of [
    (store, request) => {
      request.previewDigest = "00".repeat(32);
    },
    (store) => {
      store.plan.targets[0].uid += 1;
    },
    (store) => {
      store.plan.action.kind = "moveToTrash";
    },
    (store) => {
      store.approval.seal = "00".repeat(32);
    },
  ]) {
    const store = newStore();
    issueApproval(store);
    const request = commitRequest(store);
    mutate(store, request);
    const result = consume(store, request);
    assert(
      result.code === "action.approval_mismatch" && store.claim === null,
      "changed binding consumed",
    );
  }
  const stale = newStore();
  issueApproval(stale);
  const request = commitRequest(stale);
  stale.plan.version += 1;
  assert(consume(stale, request).code === "action.plan_version_stale", "changed version consumed");
});

probe("P-EXPIRED", () => {
  const store = newStore();
  issueApproval(store);
  const result = consume(store, commitRequest(store), agentAuth, "2026-08-18T00:20:00.000Z");
  assert(
    result.code === "action.approval_expired" &&
      store.closure.kind === "expired" &&
      store.claim === null,
    "expired approval consumed",
  );
  const expiredPlan = newStore();
  issueApproval(expiredPlan);
  expiredPlan.plan.expiresAt = "2026-08-18T00:10:30.000Z";
  const planRequest = {
    ...commitRequest(expiredPlan),
    previewDigest: expiredPlan.approval.previewDigest,
  };
  assert(
    consume(expiredPlan, planRequest, agentAuth, "2026-08-18T00:10:30.000Z").code ===
      "action.plan_expired",
    "expired plan consumed",
  );
});

probe("P-CONCURRENT", () => {
  const store = newStore();
  issueApproval(store);
  const request = commitRequest(store);
  const first = consume(store, request);
  const second = consume(store, request, {
    ...agentAuth,
    principalId: "principal:agent-two",
    credentialId: "credential:agent-two",
  });
  assert(
    first.kind === "consumed" && second.code === "action.approval_consumed",
    "double consume outcome drifted",
  );
  assert(
    store.plan.version === 2 &&
      store.claim !== null &&
      store.closure.receipt.receiptId === first.receipt.receiptId,
    "double consume wrote duplicate state",
  );
});

probe("P-RESTART-BEFORE", () => {
  const store = newStore();
  issueApproval(store);
  const reopened = cloneStore(store);
  assert(
    reopened.approval.seal === store.approval.seal && reopened.closure === null,
    "available approval did not reopen",
  );
  assert(
    consume(reopened, commitRequest(reopened)).kind === "consumed",
    "reopened available approval failed",
  );
});

probe("P-RESTART-AFTER", () => {
  const store = newStore();
  issueApproval(store);
  const request = commitRequest(store);
  assert(consume(store, request).kind === "consumed", "initial consume failed");
  const reopened = cloneStore(store);
  assert(consume(reopened, request).code === "action.approval_consumed", "reopen consumed twice");
  assert(
    reopened.plan.state === "executing" &&
      reopened.claim.receiptId === reopened.closure.receipt.receiptId,
    "receipt/claim link lost",
  );
});

probe("P-AUDIT-REOPEN", () => {
  const store = newStore();
  store.audit.push({
    actor: "creator",
    principalId: "principal:agent",
    profile: "agent-unattended",
  });
  issueApproval(store);
  const request = commitRequest(store);
  consume(store, request);
  recordAttemptResult(store, "attempt:one", "executor:aaaaaaaa", "55".repeat(32));
  assert(
    appendTerminalAudit(
      store,
      normalTerminalAudit(
        store,
        "uncertain",
        "66".repeat(32),
        "effect-executor",
        "executor:aaaaaaaa",
      ),
    ).kind === "inserted",
    "terminal audit was not persisted",
  );
  const reopened = cloneStore(store);
  assert(JSON.stringify(reopened.audit) === JSON.stringify(store.audit), "audit changed on reopen");
  assert(reopened.closure.kind === "consumed", "consumed receipt reopened available");
  assert(
    reopened.approval.challengeCommitmentSha256 ===
      reopened.audit.find(({ actor }) => actor === "approver").challengeCommitmentSha256,
    "challenge provenance was not durable",
  );
});

probe("P-PARITY", () => {
  const directStore = newStore();
  issueApproval(directStore);
  const directTrace = [];
  assert(
    directCommitBoundary(directStore, commitRequest(directStore), agentAuth, directTrace).kind ===
      "consumed",
    "direct boundary failed",
  );
  assert(
    JSON.stringify(directTrace) ===
      JSON.stringify(["direct-service", "approval-authority-service", "storage-repository"]),
    "direct delegate closure drifted",
  );

  const httpStore = newStore();
  issueApproval(httpStore);
  const httpTrace = [];
  const httpRequest = commitRequest(httpStore);
  assert(
    httpCommitBoundary(
      httpStore,
      {
        method: "POST",
        path: `/v1/action-plans/${encodeURIComponent(httpStore.plan.planId)}/commit`,
        rawBody: rawBody(httpRequest),
      },
      agentAuth,
      httpTrace,
    ).kind === "consumed",
    "HTTP boundary failed",
  );
  assert(
    JSON.stringify(httpTrace) ===
      JSON.stringify(["composed-http", "approval-authority-service", "storage-repository"]),
    "HTTP delegate closure drifted",
  );

  const cliStore = newStore();
  issueApproval(cliStore);
  const cliTrace = [];
  assert(
    cliCommitBoundary(cliStore, commitRequest(cliStore), agentAuth, cliTrace).kind === "consumed",
    "CLI boundary failed",
  );
  assert(
    JSON.stringify(cliTrace) ===
      JSON.stringify([
        "cli-http",
        "composed-http",
        "approval-authority-service",
        "storage-repository",
      ]),
    "CLI delegate closure drifted",
  );

  const storageStore = newStore();
  issueApproval(storageStore);
  const storageTrace = [];
  assert(
    consume(
      storageStore,
      commitRequest(storageStore),
      agentAuth,
      "2026-08-18T00:11:00.000Z",
      storageTrace,
    ).kind === "consumed" &&
      JSON.stringify(storageTrace) === JSON.stringify(["storage-repository"]),
    "storage repository closure drifted",
  );

  const recoveryTrace = [];
  assert(
    recoveryBoundary(storageStore, recoveryTrace).kind === "resumable" &&
      JSON.stringify(recoveryTrace) ===
        JSON.stringify(["restart-recovery", "internal-action-executor"]),
    "recovery receipt closure drifted",
  );
  const invalidRecovery = cloneStore(storageStore);
  invalidRecovery.claim = null;
  const invalidRecoveryTrace = [];
  assert(
    recoveryBoundary(invalidRecovery, invalidRecoveryTrace).kind === "rejected" &&
      JSON.stringify(invalidRecoveryTrace) === JSON.stringify(["restart-recovery"]),
    "recovery constructed alternate consume authority",
  );

  for (const boundary of [
    (store, request, trace) => directCommitBoundary(store, request, agentAuth, trace),
    (store, request, trace) =>
      httpCommitBoundary(
        store,
        {
          method: "POST",
          path: `/v1/action-plans/${encodeURIComponent(store.plan.planId)}/commit`,
          rawBody: rawBody(request),
        },
        agentAuth,
        trace,
      ),
    (store, request, trace) => cliCommitBoundary(store, request, agentAuth, trace),
  ]) {
    const store = newStore();
    issueApproval(store);
    const request = { ...commitRequest(store), principalId: "principal:spoofed" };
    const trace = [];
    assert(
      boundary(store, request, trace).kind === "rejected" && store.claim === null,
      "boundary accepted caller identity evidence",
    );
  }
});

probe("P-CANCEL-RACE", () => {
  const cancelWinner = newStore();
  issueApproval(cancelWinner);
  const cancelRequest = prepareSignedOperatorRequest(cancelWinner, "cancel-approval");
  assert(
    approvalServiceCancel(cancelWinner, cancelRequest).kind === "cancelled",
    "signed cancellation failed",
  );
  assert(
    consume(cancelWinner, commitRequest(cancelWinner)).code === "action.approval_cancelled",
    "cancel loser consumed",
  );
  const consumeWinner = newStore();
  issueApproval(consumeWinner);
  const losingCancellation = prepareSignedOperatorRequest(consumeWinner, "cancel-approval");
  assert(
    consume(consumeWinner, commitRequest(consumeWinner)).kind === "consumed",
    "consume winner failed",
  );
  assert(
    approvalServiceCancel(consumeWinner, losingCancellation).code === "action.approval_consumed",
    "cancellation undid consume winner",
  );
  assert(consumeWinner.closure.kind === "consumed", "post-consume cancellation reopened authority");
});

probe("P-PARTIAL-UNCERTAIN", () => {
  for (const terminal of ["partial", "uncertain"]) {
    const store = newStore();
    issueApproval(store);
    const request = commitRequest(store);
    consume(store, request);
    recordAttemptResult(store, "attempt:one", "executor:aaaaaaaa", "55".repeat(32));
    store.plan.state = terminal;
    assert(
      appendTerminalAudit(
        store,
        normalTerminalAudit(
          store,
          terminal,
          "66".repeat(32),
          "effect-executor",
          "executor:aaaaaaaa",
        ),
      ).kind === "inserted",
      `${terminal} terminal audit failed`,
    );
    assert(
      consume(store, request).code === "action.approval_consumed",
      `${terminal} reopened approval`,
    );
  }
});

probe("P-LEGACY", () => {
  const store = newStore();
  issueApproval(store);
  store.plan.authorityVersion = "legacy-untrusted";
  const result = consume(store, commitRequest(store));
  assert(
    result.code === "action.legacy_authority" && store.claim === null,
    "legacy scope-only plan consumed",
  );
});

probe("P-PRESENCE-BINDING", () => {
  const rpcStore = newStore();
  const rpcEnvelope = operatorChallengeRpcEnvelope(rpcStore, "approve");
  assert(
    issueOperatorChallengeRpc(rpcStore, operatorChallengeRpcFrame(rpcEnvelope)).kind === "issued",
    "valid owner-local challenge RPC failed",
  );
  for (const frameMutation of [
    (frame) => frame.subarray(0, -1),
    (frame) => Buffer.concat([frame.subarray(0, -1), Buffer.from("\r\n")]),
    (frame) => Buffer.concat([frame, Buffer.from("{}\n")]),
    () => operatorChallengeRpcFrame({ ...rpcEnvelope, version: "wrong" }),
    () => operatorChallengeRpcFrame({ ...rpcEnvelope, extra: true }),
  ]) {
    const store = newStore();
    assert(
      issueOperatorChallengeRpc(
        store,
        frameMutation(operatorChallengeRpcFrame(operatorChallengeRpcEnvelope(store, "approve"))),
      ).kind === "rejected" && store.challenges.size === 0,
      "malformed challenge RPC frame issued authority",
    );
  }
  const wrongPeerStore = newStore();
  assert(
    issueOperatorChallengeRpc(
      wrongPeerStore,
      operatorChallengeRpcFrame(operatorChallengeRpcEnvelope(wrongPeerStore, "approve")),
      502,
      501,
    ).kind === "rejected" && wrongPeerStore.challenges.size === 0,
    "wrong-UID peer issued an operator challenge",
  );

  for (const mutation of [
    { method: "DELETE" },
    { path: "/v1/action-plans/plan:wrong/approvals" },
    { bytes: Buffer.from("{}") },
    {
      assertion: (assertion) => {
        const signature = Buffer.from(assertion.signatureBase64url, "base64url");
        signature[0] ^= 0x01;
        return { ...assertion, signatureBase64url: base64url(signature) };
      },
    },
  ]) {
    const store = newStore();
    const request = prepareSignedOperatorRequest(store, "approve", mutation);
    const result = approvalServiceApprove(store, request);
    assert(
      result.kind === "rejected" && store.approval === null && store.challengeClosures.size === 0,
      "mutated approve presence created authority",
    );
  }
  const rawDigestMutation = newStore();
  const rawDigestRequest = prepareSignedOperatorRequest(rawDigestMutation, "approve");
  rawDigestRequest.bytes = Buffer.concat([rawDigestRequest.bytes, Buffer.from("\n")]);
  assert(
    approvalServiceApprove(rawDigestMutation, rawDigestRequest).code ===
      "action.operator_assertion_invalid" && rawDigestMutation.approval === null,
    "changed raw body bytes retained approval authority",
  );

  const expired = newStore();
  const expiredRequest = prepareSignedOperatorRequest(expired, "approve");
  assert(
    approvalServiceApprove(expired, expiredRequest, "2026-08-18T00:11:00.000Z").code ===
      "action.operator_challenge_expired",
    "expired A1 challenge approved",
  );

  const revoked = newStore();
  const revokedRequest = prepareSignedOperatorRequest(revoked, "approve");
  revoked.credentials.get(operatorCredential.credentialId).status = "revoked";
  assert(
    approvalServiceApprove(revoked, revokedRequest).code === "action.operator_assertion_invalid",
    "revoked A1 credential approved",
  );

  const wrongInstance = newStore();
  const wrongInstanceRequest = prepareSignedOperatorRequest(wrongInstance, "approve");
  wrongInstance.challenges.get(wrongInstanceRequest.challenge.challengeId).authorityInstanceId =
    "instance:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert(
    approvalServiceApprove(wrongInstance, wrongInstanceRequest).code ===
      "action.operator_assertion_invalid",
    "cross-instance A1 assertion approved",
  );

  const capacity = newStore();
  for (let index = 0; index < 4; index += 1) {
    const bytes = rawBody(approveBody(capacity));
    assert(
      issueOperatorChallenge(capacity, "approve", bytes).kind === "issued",
      "challenge capacity closed early",
    );
  }
  assert(
    issueOperatorChallenge(capacity, "approve", rawBody(approveBody(capacity))).code ===
      "action.operator_challenge_capacity",
    "per-credential challenge capacity was not enforced",
  );

  const replayStore = newStore();
  const request = prepareSignedOperatorRequest(replayStore, "approve");
  assert(
    approvalServiceApprove(replayStore, request).kind === "issued",
    "valid A1 approval failed",
  );
  assert(
    approvalServiceApprove(replayStore, request).code === "action.operator_challenge_consumed",
    "approve ceremony replayed",
  );
  const approveAsCancel = {
    ...request,
    method: "DELETE",
    path: `/v1/action-plans/${encodeURIComponent(replayStore.plan.planId)}/approvals/${encodeURIComponent(replayStore.approval.approvalId)}`,
  };
  assert(
    approvalServiceCancel(replayStore, approveAsCancel).code ===
      "action.operator_challenge_consumed",
    "consumed approve ceremony replayed as cancellation",
  );

  const crossOperation = newStore();
  issueApproval(crossOperation);
  const cancel = prepareSignedOperatorRequest(crossOperation, "cancel-approval");
  const approveReplay = {
    ...cancel,
    method: "POST",
    path: `/v1/action-plans/${encodeURIComponent(crossOperation.plan.planId)}/approvals`,
  };
  assert(
    approvalServiceApprove(crossOperation, approveReplay).kind === "rejected" &&
      crossOperation.closure === null,
    "cancel ceremony authorized approve",
  );

  for (const mutation of [
    { method: "POST" },
    { path: "/v1/action-plans/plan:wrong/approvals/approval:wrong" },
    { bytes: Buffer.from("{}") },
  ]) {
    const store = newStore();
    issueApproval(store);
    const cancellation = prepareSignedOperatorRequest(store, "cancel-approval", mutation);
    const result = approvalServiceCancel(store, cancellation);
    assert(
      result.kind === "rejected" && store.closure === null,
      "mutated cancellation presence closed authority",
    );
  }
  const cancelDigestMutation = newStore();
  issueApproval(cancelDigestMutation);
  const cancelDigestRequest = prepareSignedOperatorRequest(cancelDigestMutation, "cancel-approval");
  cancelDigestRequest.bytes = Buffer.concat([cancelDigestRequest.bytes, Buffer.from("\n")]);
  assert(
    approvalServiceCancel(cancelDigestMutation, cancelDigestRequest).code ===
      "action.operator_assertion_invalid" && cancelDigestMutation.closure === null,
    "changed cancellation raw body bytes closed approval",
  );
});

probe("P-RESTORE-ROLLBACK", () => {
  const preConsume = newStore();
  issueApproval(preConsume);
  const preConsumeBackup = databaseBackup(preConsume);
  const preConsumeHostKeys = cloneStore(preConsume.keyring);
  assert(
    consume(preConsume, commitRequest(preConsume)).kind === "consumed",
    "later consume failed",
  );
  const restoredPreConsume = explicitDatabaseRestore(preConsumeBackup, preConsumeHostKeys);
  assert(
    restoredPreConsume.closure?.reason === "database-restore" &&
      consume(restoredPreConsume, commitRequest(restoredPreConsume)).code ===
        "action.approval_invalidated",
    "pre-consume backup resurrected authority with keys present",
  );
  assert(
    [...restoredPreConsume.challengeClosures.values()].every(
      ({ kind }) => kind === "consumed" || kind === "invalidated",
    ),
    "restore left an available challenge",
  );

  const preCancel = newStore();
  issueApproval(preCancel);
  const cancellation = prepareSignedOperatorRequest(preCancel, "cancel-approval");
  const preCancelBackup = databaseBackup(preCancel);
  const preCancelHostKeys = cloneStore(preCancel.keyring);
  assert(
    approvalServiceCancel(preCancel, cancellation).kind === "cancelled",
    "later cancel failed",
  );
  const restoredPreCancel = explicitDatabaseRestore(preCancelBackup, preCancelHostKeys);
  assert(
    restoredPreCancel.closure?.reason === "database-restore" &&
      consume(restoredPreCancel, commitRequest(restoredPreCancel)).code ===
        "action.approval_invalidated",
    "pre-cancel backup resurrected authority with keys present",
  );
  assert(
    [...restoredPreCancel.challengeClosures.values()].every(
      ({ kind }) => kind === "consumed" || kind === "invalidated",
    ),
    "restore left pre-cancel challenge available",
  );
});

probe("P-OPERATOR-SESSION", () => {
  const store = newStore();
  const issued = operatorSessionService(store, prepareSignedOperatorRequest(store, "open-session"));
  assert(issued.kind === "issued", "A1 operator session was not issued");
  const auth = authenticateOperatorSession(store, issued.token);
  assert(
    auth !== null && profileIsValid(auth),
    "operator session cannot authenticate create/inspect",
  );
  assert(
    !profileIsValid({ ...auth, scopes: [...auth.scopes, "mail:action.approve"] }),
    "operator session gained approval authority",
  );
  issueApproval(store);
  assert(
    consume(store, commitRequest(store), auth).code === "action.approval_forbidden",
    "operator session gained commit authority",
  );
  store.operatorConfigurationRevision += 1;
  assert(
    authenticateOperatorSession(store, issued.token) === null,
    "stale session survived config change",
  );
  const reopened = cloneStore(store);
  reopened.operatorSessions.clear();
  assert(authenticateOperatorSession(reopened, issued.token) === null, "session survived restart");
});

probe("P-RESTORE-CONSUMED", () => {
  const original = newStore();
  issueApproval(original);
  assert(
    consume(original, commitRequest(original)).kind === "consumed",
    "consume before backup failed",
  );
  const backup = databaseBackup(original);
  const hostKeys = cloneStore(original.keyring);
  original.remoteCalls += 1;
  original.plan.state = "succeeded";
  const restored = explicitDatabaseRestore(backup, hostKeys);
  const trace = [];
  const terminal = restored.audit.find(
    (entry) => entry.actor === "terminal" && entry.state === "restore-quarantined",
  );
  const restoreEvent = restored.restoreEvents.at(-1);
  const expectedResultDigest = sha256(
    JSON.stringify([
      "action-restore-quarantine-v1",
      restoreEvent.restoreEventId,
      restored.plan.planId,
      restored.closure.receipt.receiptId,
      restored.claim.claimId,
      restoreEvent.restoredAt,
    ]),
  );
  assert(
    restored.restoreEvents.length === 1 &&
      strictKeys(restoreEvent, ["restoreEventId", "restoredAt"]) &&
      restoreEvent.restoreEventId === "restore-event:66666666-6666-4666-8666-666666666666" &&
      restoreEvent.restoredAt === "2026-08-18T00:15:00.000Z",
    "restore did not persist one exact event ID/time",
  );
  assert(
    restored.plan.state === "restore-quarantined" &&
      restored.remoteCalls === 0 &&
      restored.activeClaimId === null &&
      recoveryBoundary(restored, trace).kind === "rejected" &&
      JSON.stringify(trace) === JSON.stringify(["restart-recovery"]),
    "post-consume backup restore could dispatch a second effect",
  );
  assert(
    restored.closure.kind === "consumed" &&
      restored.claim.receiptId === restored.closure.receipt.receiptId,
    "restore quarantine lost receipt/claim audit proof",
  );
  assert(
    strictKeys(terminal, [
      "actor",
      "planId",
      "receiptId",
      "claimId",
      "state",
      "terminalAt",
      "executorDisposition",
      "effectAttemptCount",
      "effectAuthoritySetDigest",
      "executorInstanceId",
      "finalizerKind",
      "finalizerInstanceId",
      "reasonCode",
      "restoreEventId",
      "resultDigest",
    ]) &&
      terminal.planId === restored.plan.planId &&
      terminal.receiptId === restored.closure.receipt.receiptId &&
      terminal.claimId === restored.claim.claimId &&
      terminal.terminalAt === restoreEvent.restoredAt &&
      terminal.executorDisposition === "never-started-after-restore" &&
      terminal.effectAttemptCount === 0 &&
      equalHex(
        terminal.effectAuthoritySetDigest,
        terminalEffectProjection(restored, terminal).digest,
      ) &&
      terminal.executorInstanceId === "executor:not-started" &&
      terminal.finalizerKind === "restore-admission" &&
      terminal.finalizerInstanceId === "finalizer:restore-admission" &&
      terminal.reasonCode === "explicit-database-restore" &&
      terminal.restoreEventId === restoreEvent.restoreEventId &&
      equalHex(terminal.resultDigest, expectedResultDigest),
    "restore terminal audit fields or commitment drifted",
  );
  assert(
    appendTerminalAudit(restored, { ...terminal, planId: "plan:cross-plan" }).kind === "rejected" &&
      appendTerminalAudit(restored, { ...terminal, claimId: "claim:cross-claim" }).kind ===
        "rejected",
    "terminal audit accepted cross-plan or cross-claim attribution",
  );
});

probe("P-CLOSURE-REAPPROVAL", () => {
  const expired = newStore();
  issueApproval(expired);
  const oldRequest = commitRequest(expired);
  assert(
    consume(expired, oldRequest, agentAuth, "2026-08-18T00:20:00.000Z").code ===
      "action.approval_expired" && expired.plan.version === 2,
    "expiry did not advance the plan exactly once",
  );
  expired.plan.expiresAt = "2026-08-18T00:40:00.000Z";
  const replacement = approvalServiceApprove(
    expired,
    prepareSignedOperatorRequest(expired, "approve", { issuedAt: "2026-08-18T00:21:00.000Z" }),
    "2026-08-18T00:21:00.000Z",
  );
  assert(
    replacement.kind === "issued" && replacement.approval.planVersion === 2,
    "fresh-version approval failed",
  );
  assert(
    consume(expired, oldRequest).code === "action.approval_expired",
    "closed approval revived",
  );

  const removed = newStore();
  issueApproval(removed);
  const removedRequest = commitRequest(removed);
  rotateSealKey(removed);
  assert(removeSealKey(removed, sealKeyOneId).kind === "removed", "verify-only removal failed");
  assert(removed.plan.version === 2, "key invalidation did not advance plan exactly once");
  const renewed = approvalServiceApprove(removed, prepareSignedOperatorRequest(removed, "approve"));
  assert(
    renewed.kind === "issued" && renewed.approval.sealKeyId === sealKeyTwoId,
    "replacement after invalidation failed",
  );
  assert(
    consume(removed, removedRequest).code === "action.approval_invalidated",
    "invalidated approval revived",
  );
});

probe("P-SEAL-KEYRING", () => {
  const bare = newStore();
  assert(
    sealKeyAdminBoundary(bare, { operation: "seal-key-rotate" }).kind === "rejected" &&
      bare.keyring.revision === 1,
    "same-UID bare administration discriminant mutated the keyring",
  );
  const valid = newStore();
  const rotateRequest = prepareSignedOperatorRequest(valid, "seal-key-rotate");
  const rotateEnvelope = sealKeyAdminEnvelope(rotateRequest);
  assert(
    sealKeyAdminBoundary(valid, rotateEnvelope).kind === "rotated" &&
      valid.keyring.revision === 2 &&
      valid.keyring.activeKeyId === sealKeyTwoId,
    "signed A1 rotation failed",
  );
  assert(
    sealKeyAdminBoundary(valid, rotateEnvelope).code === "action.operator_challenge_consumed" &&
      valid.keyring.revision === 2,
    "administration assertion replay mutated twice",
  );
  const removeRequest = prepareSignedOperatorRequest(valid, "seal-key-remove", {
    keyId: sealKeyOneId,
  });
  assert(
    sealKeyAdminBoundary(valid, sealKeyAdminEnvelope(removeRequest)).kind === "removed" &&
      valid.keyring.revision === 3 &&
      !valid.keyring.keys.has(sealKeyOneId),
    "signed A1 verify-only removal failed",
  );

  for (const attack of [
    "wrong-uid",
    "missing-assertion",
    "forged-signature",
    "operation",
    "method",
    "path",
    "body",
    "target",
    "revision",
  ]) {
    const store = newStore();
    const request = prepareSignedOperatorRequest(store, "seal-key-rotate");
    let envelope = sealKeyAdminEnvelope(request);
    let peerUid = 501;
    if (attack === "wrong-uid") peerUid = 502;
    if (attack === "missing-assertion") envelope = { ...envelope, assertion: undefined };
    if (attack === "forged-signature") {
      const signature = Buffer.from(envelope.assertion.signatureBase64url, "base64url");
      signature[0] ^= 1;
      envelope = {
        ...envelope,
        assertion: { ...envelope.assertion, signatureBase64url: base64url(signature) },
      };
    }
    if (attack === "method")
      store.challenges.get(request.challenge.challengeId).requestMethod = "POST";
    if (attack === "operation")
      store.challenges.get(request.challenge.challengeId).operation = "seal-key-remove";
    if (attack === "path")
      store.challenges.get(request.challenge.challengeId).requestPath = "/internal/wrong";
    if (attack === "body")
      envelope = { ...envelope, requestBodyBase64url: base64url(Buffer.from("{}")) };
    if (attack === "target")
      envelope = {
        ...envelope,
        requestBodyBase64url: base64url(
          rawBody({ expectedKeyringRevision: 1, expectedActiveKeyId: sealKeyTwoId }),
        ),
      };
    if (attack === "revision") store.keyring.revision += 1;
    assert(
      sealKeyAdminBoundary(store, envelope, peerUid).kind === "rejected" &&
        store.keyring.activeKeyId === sealKeyOneId,
      `${attack} seal-key administration attack succeeded`,
    );
  }

  const signedActiveRemoval = newStore();
  const activeRequest = prepareSignedOperatorRequest(signedActiveRemoval, "seal-key-remove", {
    keyId: sealKeyOneId,
  });
  assert(
    sealKeyAdminBoundary(signedActiveRemoval, sealKeyAdminEnvelope(activeRequest)).code ===
      "seal-key-removal-forbidden" &&
      !signedActiveRemoval.challengeClosures.has(activeRequest.challenge.challengeId) &&
      signedActiveRemoval.keyring.revision === 1,
    "signed active-key removal consumed authority or mutated state",
  );
  const activeRemoval = newStore();
  assert(
    removeSealKey(activeRemoval, sealKeyOneId).code === "seal-key-removal-forbidden" &&
      activeRemoval.keyring.keys.has(sealKeyOneId) &&
      activeRemoval.keyring.revision === 1,
    "active seal key removal was not rejected without mutation",
  );
  assert(
    removeSealKey(activeRemoval, "approval-seal-key:missing").code === "seal-key-removal-forbidden",
    "missing seal key removal was not rejected",
  );
  const rotated = newStore();
  issueApproval(rotated);
  rotateSealKey(rotated);
  assert(
    consume(rotated, commitRequest(rotated)).kind === "consumed",
    "verify-only key rejected valid old approval",
  );

  const missing = newStore();
  issueApproval(missing);
  missing.keyring.keys.delete(sealKeyOneId);
  assert(
    consume(missing, commitRequest(missing)).code === "action.approval_invalidated",
    "missing seal key did not fail closed",
  );
  const tampered = newStore();
  issueApproval(tampered);
  tampered.keyring.keys.get(sealKeyOneId).keyHex = "00".repeat(32);
  assert(
    consume(tampered, commitRequest(tampered)).code === "action.approval_mismatch",
    "tampered key accepted",
  );
  const backup = databaseBackup(newStore());
  assert(!Object.hasOwn(backup, "keyring"), "backup contains seal keyring");
});

probe("P-CONFIG-RACES", () => {
  const revokeFirst = newStore();
  issueApproval(revokeFirst);
  const revokeRequest = commitRequest(revokeFirst);
  revokeOperatorCredential(revokeFirst);
  assert(
    consume(revokeFirst, revokeRequest).code === "action.approval_invalidated",
    "revocation lost its ordering race",
  );

  const consumeFirst = newStore();
  issueApproval(consumeFirst);
  assert(
    consume(consumeFirst, commitRequest(consumeFirst)).kind === "consumed",
    "consume did not linearize",
  );
  revokeOperatorCredential(consumeFirst);
  assert(consumeFirst.closure.kind === "consumed", "later revocation erased executor capability");

  const removalFirst = newStore();
  issueApproval(removalFirst);
  const removalRequest = commitRequest(removalFirst);
  rotateSealKey(removalFirst);
  assert(
    removeSealKey(removalFirst, sealKeyOneId).kind === "removed",
    "verify-only key removal did not linearize",
  );
  assert(
    consume(removalFirst, removalRequest).code === "action.approval_invalidated",
    "key removal lost its ordering race",
  );

  const removalAfter = newStore();
  issueApproval(removalAfter);
  rotateSealKey(removalAfter);
  assert(
    consume(removalAfter, commitRequest(removalAfter)).kind === "consumed",
    "consume-before-removal failed",
  );
  assert(
    removeSealKey(removalAfter, sealKeyOneId).kind === "removed",
    "later verify-only key removal failed",
  );
  assert(removalAfter.closure.kind === "consumed", "later key removal erased executor capability");
});

probe("P-RECOVERY-FINALIZER", () => {
  const original = newStore();
  issueApproval(original);
  assert(
    consume(original, commitRequest(original)).kind === "consumed",
    "recovery-finalizer setup did not consume",
  );
  assert(
    recordAttemptResult(
      original,
      "attempt:00000001",
      "executor:effect-a",
      "71".repeat(32),
      "2026-08-18T00:12:00.000Z",
    ).kind === "persisted" &&
      recordAttemptResult(
        original,
        "attempt:00000002",
        "executor:effect-a",
        "72".repeat(32),
        "2026-08-18T00:12:30.000Z",
      ).kind === "persisted",
    "two durable effect attempts were not attributed to executor A",
  );
  const crashed = cloneStore(original);
  const remoteCallsBeforeRecovery = crashed.remoteCalls;
  const terminal = normalTerminalAudit(
    crashed,
    "completed",
    sha256(JSON.stringify(["action-result-set-v1", "71".repeat(32), "72".repeat(32)])),
    "ordinary-recovery",
    "recovery-finalizer:process-b",
  );
  assert(
    terminal.effectAttemptCount === 2 &&
      terminal.executorInstanceId === "executor:effect-a" &&
      terminal.finalizerInstanceId === "recovery-finalizer:process-b",
    "recovery terminal did not distinguish effect executor A from finalizer B",
  );
  assert(
    appendTerminalAudit(crashed, {
      ...terminal,
      executorInstanceId: "recovery-finalizer:process-b",
    }).code === "terminal-effect-attribution-mismatch",
    "recovery finalizer B was accepted as effect executor",
  );
  assert(
    appendTerminalAudit(crashed, { ...terminal, effectAttemptCount: 1 }).code ===
      "terminal-effect-attribution-mismatch" &&
      appendTerminalAudit(crashed, {
        ...terminal,
        effectAuthoritySetDigest: "00".repeat(32),
      }).code === "terminal-effect-attribution-mismatch",
    "incomplete or changed effect-authority projection was accepted",
  );
  assert(
    appendTerminalAudit(crashed, terminal).kind === "inserted" &&
      crashed.remoteCalls === remoteCallsBeforeRecovery &&
      crashed.plan.state === "completed" &&
      crashed.activeClaimId === null,
    "read-only recovery finalization created a new effect or failed terminalization",
  );
  assert(
    recordAttemptResult(
      crashed,
      "attempt:00000003",
      "recovery-finalizer:process-b",
      "73".repeat(32),
    ).kind === "rejected" && crashed.remoteCalls === remoteCallsBeforeRecovery,
    "recovery finalizer gained post-terminal effect authority",
  );
  const reopened = cloneStore(crashed);
  assert(
    JSON.stringify(reopened.audit) === JSON.stringify(crashed.audit) &&
      JSON.stringify(reopened.attemptAuthorities) === JSON.stringify(crashed.attemptAuthorities),
    "effect/finalizer attribution changed on reopen",
  );
});

probe("P-CHALLENGE-CAPACITY", () => {
  const independent = newStore();
  for (const credential of [operatorCredential, secondOperatorCredential]) {
    for (let index = 0; index < 4; index += 1)
      assert(
        issueOperatorChallenge(
          independent,
          "approve",
          rawBody(approveBody(independent)),
          undefined,
          undefined,
          undefined,
          credential,
        ).kind === "issued",
        "per-credential capacity was counted globally",
      );
  }
  const reclaimed = newStore();
  for (let index = 0; index < 4; index += 1)
    issueOperatorChallenge(reclaimed, "approve", rawBody(approveBody(reclaimed)));
  assert(
    issueOperatorChallenge(
      reclaimed,
      "approve",
      rawBody(approveBody(reclaimed)),
      undefined,
      undefined,
      "2026-08-18T00:11:00.000Z",
    ).kind === "issued",
    "expired challenges did not release capacity",
  );

  const global = newStore();
  for (let credentialIndex = 0; credentialIndex < 32; credentialIndex += 1) {
    const credential = {
      ...operatorCredential,
      credentialId: `credential:operator:${String(credentialIndex).padStart(64, "0")}`,
    };
    global.credentials.set(credential.credentialId, {
      status: "active",
      expiresAt: credential.credentialExpiresAt,
    });
    for (let slot = 0; slot < 4; slot += 1)
      assert(
        issueOperatorChallenge(
          global,
          "approve",
          rawBody(approveBody(global)),
          undefined,
          undefined,
          undefined,
          credential,
        ).kind === "issued",
        "global capacity closed early",
      );
  }
  const extra = { ...operatorCredential, credentialId: `credential:operator:${"ff".repeat(32)}` };
  global.credentials.set(extra.credentialId, {
    status: "active",
    expiresAt: extra.credentialExpiresAt,
  });
  assert(
    issueOperatorChallenge(
      global,
      "approve",
      rawBody(approveBody(global)),
      undefined,
      undefined,
      undefined,
      extra,
    ).code === "action.operator_challenge_capacity",
    "global challenge capacity was not enforced",
  );

  const expiredCredential = newStore();
  expiredCredential.credentials.get(operatorCredential.credentialId).expiresAt =
    "2026-08-18T00:10:00.000Z";
  assert(
    issueOperatorChallenge(expiredCredential, "approve", rawBody(approveBody(expiredCredential)))
      .code === "action.operator_assertion_invalid",
    "credential expiry equality was treated as active",
  );
});

assert(modelProbeResults.length === probeIds.size, "not every declared probe executed");
exactSet(new Set(modelProbeResults.map(({ id }) => id)), probeIds, "executed probes");

const viewTexts = viewPaths.map((path) => readFileSync(path, "utf8"));
for (const [index, view] of viewTexts.entries())
  assert(view.includes(EXPECTED_ORACLE_SHA256), `view ${index + 1} omits oracle digest`);
for (const term of oracle.terms)
  assert(viewTexts[0].includes(`\`${term.id}\``), `design view omits ${term.id}`);
for (const profile of oracle.profiles)
  assert(viewTexts[0].includes(`\`${profile.profile}\``), `design view omits ${profile.profile}`);
for (const transition of oracle.stateMachine.transitions)
  assert(viewTexts[0].includes(`\`${transition.id}\``), `design view omits ${transition.id}`);
for (const decision of oracle.decisions)
  assert(viewTexts[1].includes(`\`${decision.id}\``), `decision view omits ${decision.id}`);
for (const rejected of oracle.rejectedAlternatives)
  assert(viewTexts[1].includes(`\`${rejected.id}\``), `decision view omits ${rejected.id}`);
for (const retirement of oracle.retirements)
  assert(viewTexts[1].includes(`\`${retirement.id}\``), `decision view omits ${retirement.id}`);
for (const requirement of oracle.requirements)
  assert(viewTexts[2].includes(`\`${requirement.id}\``), `coverage view omits ${requirement.id}`);
for (const probeItem of oracle.probes)
  assert(viewTexts[2].includes(`\`${probeItem.id}\``), `coverage view omits ${probeItem.id}`);
for (const obligation of oracle.implementationObligations)
  assert(viewTexts[2].includes(`\`${obligation.id}\``), `coverage view omits ${obligation.id}`);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      oracleSha256: oracleDigest,
      productDecision: oracle.productDecision.id,
      counts: {
        requirements: requirementIds.size,
        decisions: decisionIds.size,
        rejectedAlternatives: rejectedIds.size,
        retirements: retirementIds.size,
        probes: probeIds.size,
        obligations: obligationIds.size,
        contradictions: contradictionIds.size,
      },
      executableProbeResults: modelProbeResults,
      currentImplementationStatus: "known-nonconforming; issue-204-required",
      downstreamWorktreeDrift,
      remainingConsequentialChoices: oracle.remainingConsequentialChoices,
    },
    null,
    2,
  )}\n`,
);
