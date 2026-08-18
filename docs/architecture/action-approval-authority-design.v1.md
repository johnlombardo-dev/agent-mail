# Action approval authority v1

Status: frozen design for issue #203

Normative oracle: `action-approval-authority-oracle.v1.json`

Oracle SHA-256: `227affdce102226e2c1dcec3cf549145d35a9615cc3ef6bb144850239ed51425`

The JSON oracle is normative. This document is a checked human view. Policy A is fully determined: a human-present operator approves one exact frozen preview, then a distinct unattended agent principal may consume that approval once and commit. No consequential product choice remains.

## Domain language

| ID               | Term               | Exact meaning                                                                                                                                   |
| ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TERM-PLAN`      | FrozenActionPlan   | Server-owned immutable action, ordered targets and MODSEQ preconditions, creation/expiry, version, canonical preview, and digest.               |
| `TERM-CREATOR`   | Creator            | Authenticated operator or unattended agent that creates the plan. Creation confers no approval.                                                 |
| `TERM-APPROVER`  | Approver           | Human-present `operator-interactive` principal that verifies and approves the exact preview.                                                    |
| `TERM-COMMITTER` | Committer          | Distinct `agent-unattended` principal that atomically consumes the approval and claims the plan.                                                |
| `TERM-EXECUTOR`  | Executor           | Internal `internal-action-executor` daemon capability. It is not a public principal.                                                            |
| `TERM-APPROVAL`  | ApprovalArtifact   | Immutable HMAC-sealed authority for one plan version, preview, target set, intent, time window, nonce, and commit scope.                        |
| `TERM-RECEIPT`   | ConsumptionReceipt | Immutable proof that one committer consumed one approval in the same transaction that created the claim.                                        |
| `TERM-PRESENCE`  | HumanPresence      | Fresh request-bound evidence verified by the authenticator from a non-exportable operator credential. A prompt or static token is not presence. |

Approval is the domain act. Authorization remains generic access control. The former “authorize” names are retired so a route ceremony cannot be mistaken for independent authority.

## Principal and credential matrix

| Profile                    | Principal         | Credential and presence                                                                                         | Create | Inspect | Approve | Commit | Execute |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- | -----: | ------: | ------: | -----: | ------: |
| `operator-interactive`     | Human operator    | A1 credential; bounded non-approval session for create/inspect, fresh request-bound presence for approve/cancel |    Yes |     Yes |     Yes |  Never |   Never |
| `agent-unattended`         | Unattended agent  | Machine-held credential; authentication presence variant is unattended                                          |    Yes |     Yes |   Never |    Yes |   Never |
| `internal-action-executor` | Daemon capability | No public credential, route, scope, or CLI command                                                              |  Never |   Never |   Never |  Never |     Yes |

Action scopes are closed per profile:

| Profile                    | Permitted action scopes                                            | Structurally rejected action scopes                    |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `operator-interactive`     | `mail:action.create`, `mail:action.inspect`, `mail:action.approve` | `mail:action.commit`, retired `mail:action.authorize`  |
| `agent-unattended`         | `mail:action.create`, `mail:action.inspect`, `mail:action.commit`  | `mail:action.approve`, retired `mail:action.authorize` |
| `internal-action-executor` | None                                                               | Every public action scope                              |

Configuration rejects a credential mapped to more than one profile, either profile containing a forbidden scope, duplicate credential IDs, profile inference from requested scopes, or a static bearer mapped to `operator-interactive`. Consume independently rejects equal approver/committer principal IDs, equal credential IDs, or a committer profile other than `agent-unattended`. This second check prevents a malformed configuration from weakening the invariant.

## Trusted authority sources

| Authority field                                                      | Trusted source                                                         | Public request status                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| Creator, approver, committer principal/credential/profile/auth event | Authenticated request context                                          | Never caller-supplied                     |
| Operator human presence and ceremony                                 | Authenticator verification                                             | Never caller-supplied                     |
| Executor profile and instance                                        | Internal daemon capability/process incarnation                         | No public representation                  |
| Plan ID and version                                                  | Stored plan                                                            | Echo-only for stale/path checks           |
| Preview digest                                                       | Server canonicalization of stored plan                                 | Echo-only; recomputed at consume          |
| Frozen targets and target digest                                     | Stored targets, server canonicalization                                | Never caller-supplied                     |
| Normalized intent                                                    | Stored action kind plus target digest                                  | Never caller-supplied                     |
| Issue/expiry time                                                    | Daemon clock, plan expiry, credential expiry, fixed 600-second ceiling | Never caller-supplied                     |
| Nonce                                                                | Server cryptographic random source, 32 bytes                           | Never caller-supplied                     |
| Authorization scope                                                  | Server constant `mail:action.commit`                                   | Never caller-supplied                     |
| Seal key ID and seal                                                 | Daemon approval keyring and HMAC-SHA-256                               | Never caller-supplied or publicly exposed |
| Approval, receipt, and claim IDs                                     | Server namespaced UUIDs                                                | Approval ID is echo-only on commit        |

The authenticated context is decoded from `unknown`, bounded, frozen, and passed out-of-band to the service. Its common fields are principal ID, credential ID, profile, scopes, auth event ID, authentication time, and credential expiry. Operator context additionally contains a human-presence challenge ID, verification interval, exact request method/concrete path/raw-body digest, authority-instance ID, challenge commitment, assertion signature proof, and display code. Agent context carries only `kind=unattended`.

Approval and cancellation each require a user-presence verification no more than 60 seconds old. Verification covers the exact operation method, concrete path, and SHA-256 of the final raw bounded HTTP body. The service independently recomputes all three. One challenge ID can authorize only one approve or cancel write across both operations.

## A1 macOS operator authenticator

The user selected `A1-MACOS-SECURE-ENCLAVE`. The native `agent-mail-operator-broker` creates a P-256 key using Security.framework with `kSecAttrTokenIDSecureEnclave`, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, and `SecAccessControl` flags `userPresence` plus `privateKeyUsage`. Private key bytes never leave the Secure Enclave. Missing Secure Enclave support, missing/removed device credentials, broker failure, or denied/locked-out device-owner authentication blocks approve and cancel. There is no software key, passphrase, static bearer, prompt-only, agent-token, or weaker-accessibility fallback.

Each signature receives a fresh `LAContext` with `touchIDAuthenticationAllowableReuseDuration = 0`; the broker discards the context after that one call. The wire signature is canonical low-S, 64-byte IEEE-P1363 P-256 ECDSA/SHA-256 encoded as unpadded base64url. DER, padded, high-S, zero, out-of-range, or wrong-length signatures fail.

Enrollment is local and interactive. The broker generates the Secure Enclave key, signs the exact enrollment commitment after device-owner presence, verifies it with the exported public key, and passes only the public SPKI plus proof to an owner-locked provisioning adapter. The exact `agent-mail-operator-broker enroll|rotate|revoke|recover --private-root ...` commands and signed commitments are frozen in the oracle. They accept no authority-bearing flags or noninteractive mode. Rotation proves the current and replacement keys. Revocation makes the configuration record inactive before invalidating that credential's live authority. Recovery uses fresh device-owner authentication, changes the authority instance, revokes every old credential, and invalidates all live authority before admission resumes.

Configuration is strict mode-0600 `<privateRoot>/config/operator-credentials.v1.json`; v1 fixes the principal to `principal:local-operator`, derives credential ID from the SPKI SHA-256, and maps it only to `operator-interactive`. Every credential expires exactly 365 days after enrollment; equality is expired, expiry is immutable, and rotation/recovery creates a new credential and lifetime. Updates use same-directory fsync plus atomic rename under the authority lock. The daemon instance ID lives outside the database and binds enrollment and every challenge to one installation.

Operator create/inspect uses `POST /v1/operator-sessions` on loopback only. A fresh `open-session` A1 ceremony signs the strict body `{requestedScopes:["mail:action.create","mail:action.inspect"]}`. Success returns a random 32-byte bearer whose digest alone lives in daemon memory for at most 600 seconds and no later than credential expiry. It dies on restart or any operator configuration change and can authenticate only create/inspect. It is absent from Tailscale and the agent operation registry and is never accepted as approve/cancel presence or commit authority.

The challenge RPC exists only on an owner-only mode-0600 Unix-domain socket in a mode-0700 directory and is not in the public operation registry or Tailscale listener. It verifies the peer UID. One connection carries one strict canonical UTF-8 JSON line, including the protocol version, followed by write-half close; the complete frame is at most 4096 bytes. CR, extra lines/bytes, invalid UTF-8, missing LF, or another request fails. The request carries the credential selector, operation, method, path, and base64url of the exact final request body. Decoded body bytes are capped at 2048. The daemon parses the target body strictly, reconstructs its method/path/body digest, and issues an immutable 60-second challenge containing a 32-byte nonce, daemon-owned principal/profile/instance, and display code. Success and error response shapes are exact in the oracle. Limits are 128 available globally, four per credential, and ten issued per credential per rolling minute.

The challenge commitment field order and assertion schema are exact in the oracle. The broker signs the stored commitment. Before signing, the CLI displays the full preview plus a five-group confirmation code; the OS reason is exactly `Agent Mail <APPROVE|CANCEL> plan <planId> preview <previewDigest> code <operatorDisplayCode>`. The user compares the same plan ID, full preview digest, and code in both surfaces. The code also derives from operation, plan ID, version, and preview digest, so an opaque Touch ID prompt is insufficient.

Public approve/cancel admission is two-phase. Before reading the body, HTTP admission caps/parses only the assertion header, resolves an available challenge, and checks method/path. This is provisional, not an authenticated principal. It then hashes the registered-size-limited stream incrementally while retaining at most the operation limit, strictly parses after EOF, and passes the raw digest to the service. The service reconstructs method/path/digest, verifies instance/credential/time/revocation and the public-key signature, then consumes the challenge in the same `BEGIN IMMEDIATE` transaction as approval issue or cancellation. This reconciles request-bound presence with authenticate-before-read without unbounded materialization.

The approval HMAC keyring is exact canonical JSON at `<privateRoot>/secrets/action-approval-seal-keyring.v1.json`, below a mode-0700 directory with a mode-0600 file. Each `approval-seal-key:<UUIDv4>` stores one canonical unpadded base64url encoding of exactly 32 OS-CSPRNG bytes and status `active` or `verify-only`. Initial creation is allowed only with a new database; a missing or malformed keyring beside an existing database blocks admission. Atomic writes use owner-only `O_EXCL` temporary creation, file fsync, rename, and directory fsync. Rotation demotes the old active key. Removal accepts only an existing `verify-only` key and closes dependent available approvals; active or missing removal rejects without mutation. Key bytes are categorically excluded from database backups, backup manifests, exports, logs, diagnostics, and crash reports.

All authority admission and configuration mutations share `<privateRoot>/locks/action-authority.lock`: process-shared file lock first, in-process RW lock second, then file reads/revision capture, `BEGIN IMMEDIATE`, revision/file-identity recheck, DB work, commit, and capability return before releasing the read locks. Credential/key mutation holds the exclusive locks, atomically replaces the file, then closes affected DB authority before release. No lock ordering lets revocation or key removal linearize first while a later consume returns an executor capability.

## Exact bindings and seal

All canonical forms are UTF-8 JSON arrays without whitespace. Existing strict identifiers are preserved. Integers are JSON safe integers and times are canonical millisecond UTC strings.

1. Sort targets by bytewise UTF-8 `accountId`, bytewise UTF-8 `mailboxId`, numeric `uidValidity`, numeric `uid`, then numeric MODSEQ.
2. `canonicalTargetSet = JSON.stringify(["action-target-set-v1", [[accountId,mailboxId,uidValidity,uid,modseq], ...]])`.
3. `targetDigest = lowercaseHex(SHA-256(canonicalTargetSet))`.
4. `normalizedIntent = JSON.stringify(["action-intent-v1", action.kind, targetDigest])`.
5. `previewBytes = JSON.stringify(["action-preview-v1", planId, planVersion, action.kind, canonicalTargetSet, normalizedIntent, createdAt, planExpiresAt])`.
6. `previewDigest = lowercaseHex(SHA-256(previewBytes))`.
7. The approval commitment is `["action-approval-authority-v1", ...orderedFields]`. The oracle projects every immutable field except the seal exactly once: approver/auth event, challenge, user-presence time, exact request binding, authority instance, operator-configuration revision, challenge/signature digests, display code, plan bindings, times, nonce, scope, `sealKeyId`, keyring revision, and `sealAlgorithm`. `sealKeyId` occurs once. The seal is excluded because it is the HMAC-SHA-256 output.

`expiresAt` is the earliest of plan expiry, approver credential expiry, and issue time plus 600 seconds. Equality is expired: consume requires `now < expiresAt` for both plan and approval.

The approval stores exact canonical target bytes as well as their digest. Consume recomputes the target bytes, target digest, intent, preview digest, commitment, and seal. A change in any one value fails closed.

## Authority states and transitions

Approval and plan state remain separate. The approval states are `absent`, `available`, `consumed`, `expired`, `cancelled`, and `invalidated`. Consumption is permanent even when the plan later becomes partial, failed, expired, rejected, or uncertain.

| Transition             | From               | Event and exact guard                                                                                                                  | To / atomic result                                                                        |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `T-SESSION`            | absent             | Fresh signed `open-session` challenge for the exact create/inspect pair                                                                | memory-only bounded session; challenge consumed atomically                                |
| `T-ISSUE`              | absent             | Trusted pending v1 plan; exact bindings; `operator-interactive`; valid signed POST/path/raw-body A1 challenge; no approval for version | available; atomically consume challenge and insert immutable approval                     |
| `T-CONSUME`            | available          | Every consume check passes; distinct current `agent-unattended` committer                                                              | consumed; atomically insert receipt and claim and move pending version n to executing n+1 |
| `T-EXPIRE`             | available          | `now >= approval.expiresAt` before consume                                                                                             | expired; close approval and increment pending version, or expire the plan                 |
| `T-CANCEL`             | available          | Same operator principal; independently signed DELETE/path/raw-body A1 challenge; approval unconsumed                                   | cancelled; atomically consume challenge, insert closure, and increment plan version       |
| `T-INVALIDATE`         | available          | Seal/key/provenance/plan mismatch, revocation, configuration invalidation, or explicit database restore                                | invalidated; close and increment a still-pending plan version                             |
| `T-RESTORE-QUARANTINE` | consumed/executing | Explicit database restore finds a matching receipt and claim                                                                           | terminal `restore-quarantined`; preserve proof and prohibit recovery/dispatch             |
| `T-REPLAY`             | consumed           | Any later commit                                                                                                                       | remain consumed; stable `action.approval_consumed`                                        |
| `T-EXECUTE`            | consumed           | Matching receipt/claim, current #202 dispatch authority, no unresolved target attempt                                                  | remain consumed; persist attempt authority before adapter permission                      |
| `T-TERMINAL`           | consumed           | Existing result/finalization rule reaches terminal state                                                                               | remain consumed; append terminal attribution linked to receipt/result digest              |

Forbidden transitions include absent-to-consumed, any closed state back to available, consumed-to-available, available-to-consumed outside the receipt-plus-claim transaction, any public state to executor capability, and any partial/uncertain outcome to reusable approval.

## Atomic consume and closure races

Commit decodes its strict body and authenticated context before opening `BEGIN IMMEDIATE`. Under the write lock it:

1. Validates the current `agent-unattended` profile, exact commit scope, authentication lifetime, active credential, and forbidden-scope rule.
2. Reads the plan, proposal, creator, authority version, approval, all closure tables, and sealing-key metadata.
3. Returns the existing closure error first. A consumed approval always returns the same receipt-backed 409.
4. Requires trusted-v1 pending state, exact path/body/store plan ID, exact version, and unexpired plan and approval.
5. Recomputes every canonical binding and seal, checks approver credential status, and enforces distinct principal and credential IDs.
6. Inserts the consumption receipt, action claim, and receipt/claim link, then updates pending version n to executing n+1 using an optimistic predicate.
7. Commits before returning an internal executor capability containing only the plan, claim, receipt, new version, and executor profile.

Any failure rolls back and returns no executor capability. Consume and cancellation use the same write lock and mutually exclusive closure guards. Exactly one wins; the loser observes a stable consumed or cancelled state. Concurrent commits likewise produce exactly one receipt, one claim, one executing transition, and at most one executor start.

## Restart, uncertainty, and restore

| Boundary                             | Required result                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Restart before consume               | Available approval survives only while unexpired and its key, credential provenance, and bindings verify.                                  |
| Crash before transaction commit      | Rollback leaves no receipt or claim; approval can still be consumed if current.                                                            |
| Crash after consume, before dispatch | On ordinary restart, receipt, claim, and executing state reopen together; recovery resumes through that authority without consuming again. |
| Crash after dispatch                 | Approval stays consumed. Existing #202 uncertainty and read-only reconciliation rules apply.                                               |
| Partial or uncertain result          | Every attempt/result stays linked to the original receipt; outcome cannot restore authority.                                               |
| Ordinary reopen                      | Creator through terminal-result attribution reconstructs from durable rows without request logs.                                           |
| Any explicit database restore        | Invalidate every restored available challenge/unconsumed approval and terminally quarantine every restored consumed/executing plan.        |
| Approval seal-key rotation           | Old HMAC keys remain verify-only until their approvals close or expire; early removal invalidates affected unconsumed approvals.           |

Ordinary restart and explicit restore are distinct. Restart may preserve unexpired authority under the same instance/configuration. Every explicit restore invalidates unconsumed authority regardless of key availability and changes each still-pending plan from version n to n+1 exactly once so only a regenerated preview can receive a replacement approval. A restored consumed/executing snapshot becomes terminal `restore-quarantined`, retains receipt/claim/audit proof, and is excluded from every recovery candidate; only read-only reconciliation is allowed. Its audit row carries the exact restore-event ID/time, `(receipt_id,plan_id,claim_id)` link, durable-attempt-derived executor disposition and sentinel, and `SHA-256(JSON.stringify(["action-restore-quarantine-v1",restoreEventId,planId,receiptId,claimId,restoredAt]))`. Restore runs this one transaction before any listener, challenge RPC, worker, or recovery actor starts.

## Exact storage and migration view

The logical migration is `action-approval-authority-v1`, after action-result-reconciliation in the dependency-complete action chain. Application assembly assigns its next contiguous global schema version. All 13 authority tables are SQLite `STRICT`; every listed column is `NOT NULL`, foreign keys stay enabled, and no authority table has an update/delete cascade. Terminal audit rows exist only for receipt-backed executing or terminal plans.

| Table                                       | Key / uniqueness                                              | Required role                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `operator_presence_challenges`              | `challenge_id`; unique nonce                                  | Immutable instance/credential/operation/method/path/raw-body/display-code challenge and commitment.                                     |
| `operator_presence_challenge_consumptions`  | `challenge_id`                                                | One-use signature proof atomically joined to one approval issue or cancellation.                                                        |
| `operator_presence_challenge_expirations`   | `challenge_id`                                                | Durable 60-second expiry closure.                                                                                                       |
| `operator_presence_challenge_invalidations` | `challenge_id`                                                | Durable revocation/instance/configuration/database-restore closure.                                                                     |
| `action_plan_authority_versions`            | `plan_id`                                                     | Exact pairs `trusted-v1`/`trusted-create` or `legacy-untrusted`/`legacy-pre-authority`, with reason/time.                               |
| `action_plan_creators`                      | `plan_id`                                                     | Immutable creator principal, credential, profile, auth event, and creation time.                                                        |
| `action_approvals`                          | `approval_id`; unique plan+version, nonce, ceremony           | Exact immutable artifact fields, canonical targets, A1 instance/challenge/assertion/request provenance, times, scope, key ID, and seal. |
| `action_approval_consumptions`              | `receipt_id`; unique approval, plan+claim, receipt+plan+claim | Immutable committer provenance and `(plan_id,claim_id)` composite FK, the sole receipt-to-claim link.                                   |
| `action_approval_expirations`               | `approval_id`                                                 | Durable expiry closure and resulting version.                                                                                           |
| `action_approval_cancellations`             | `approval_id`                                                 | Durable same-operator cancellation provenance and reason.                                                                               |
| `action_approval_invalidations`             | `approval_id`                                                 | Durable seal/key/revocation/plan/legacy/restore invalidation reason.                                                                    |
| `action_attempt_authorities`                | plan+attempt                                                  | Receipt, claim, fixed internal executor profile, instance, and attribution time before adapter permission.                              |
| `action_plan_terminal_audit`                | `plan_id`; FK receipt+plan+claim to consumption               | Exact receipt/plan/claim attribution, terminal state/time, executor disposition/instance, restore event, and result digest.             |

Every authority table has strict SQLite type, byte-length, namespace, enum, canonical-time, foreign-key, and update/delete immutability guards. Challenge triggers allow one consumption/expiry/invalidation and require the matching approval/cancellation write in the same transaction. Approval triggers allow one closure. Consumption rechecks actor separation and exact plan/claim/version bindings. Attempt attribution must match its receipt, claim, plan, and attempt.

Migration never invents provenance. Every existing plan gets `legacy-untrusted`; it gets no synthetic creator, approver, presence, seal, or receipt. Legacy pending plans cannot approve or commit. Legacy executing plans start no undispatched effect, although already-dispatched attempts may reconcile read-only. Legacy terminal plans remain inspectable with an explicit untrusted provenance status. The deployment removes scope-only reads at the same time: there is no feature flag, dual-read interval, lazy upgrade, or compatibility route.

## Public HTTP and CLI contract

| Operation       | Profile / scope                           | Strict request                                  | Response authority                                                                           |
| --------------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Create          | operator or agent / `mail:action.create`  | Existing create body, no identity               | Adds version, preview/target digests, normalized intent, safe creator, absent approval state |
| Inspect         | operator or agent / `mail:action.inspect` | `{planId}`                                      | Constructive approval state, safe provenance/closure/receipt, terminal audit                 |
| Approve         | operator / `mail:action.approve`          | `{planId,planVersion,previewDigest}`            | Safe available approval projection                                                           |
| Cancel approval | same operator / `mail:action.approve`     | `{planId,approvalId,planVersion,previewDigest}` | Safe cancelled projection and new plan version                                               |
| Commit          | distinct agent / `mail:action.commit`     | `{planId,planVersion,previewDigest,approvalId}` | Existing result plus safe consumption receipt                                                |
| Open session    | owner-local A1 / none                     | `{requestedScopes:[create,inspect]}`            | One memory-only 32-byte bearer, never approval or commit authority                           |

Approve is `POST /v1/action-plans/{planId}/approvals`, CLI `action-plans-approve`. Its retained raw body bytes are exactly the strict `{planId,planVersion,previewDigest}` serialization. Cancel is `DELETE /v1/action-plans/{planId}/approvals/{approvalId}`, CLI `action-plans-approval-cancel`, with exact raw `{planId,approvalId,planVersion,previewDigest}` bytes. Each receives a separate A1 challenge and `Authorization: AgentMail-Operator <base64url(assertion-json)>`; neither accepts a bearer operator credential. Commit remains `POST /v1/action-plans/{planId}/commit` but replaces transient authorization ID with approval ID plus exact version and preview digest.

Public provenance contains principal ID and profile. Credential ID, auth event ID, ceremony, nonce, key ID, seal, executor instance, and all raw credential material remain internal. The exact error codes, statuses, fixed messages, and safe detail objects live in the oracle. Authority conflicts use HTTP 409; authentication/profile failures use 403; malformed/extra fields use 400.

The interactive CLI renders plan ID, version, action, every target and MODSEQ, preview digest, intent, plan expiry, and the 600-second maximum approval lifetime through the shared safe human-output context. It prompts exactly:

```text
Approve this frozen action plan for one unattended commit within 10 minutes and no later than <planExpiresAt>? [y/N]
```

Only exact case-insensitive `y` or `yes` proceeds. Non-TTY input, EOF, timeout, blank input, or another response sends no approval request. After confirmation, the CLI serializes once, requests the local challenge, renders the display code, requires a fresh zero-reuse OS presence prompt showing the same plan/code, and transmits the identical bytes. Cancellation repeats the whole process with `CANCEL`, DELETE, its exact path/body, and a distinct challenge. There is no `--yes`, `--force`, environment, stdin, saved-answer, JSON identity, static token, cached `LAContext`, or structured-output bypass. Structured mode may inspect an approval but cannot mint one.

## Boundary closure

| Surface            | Only allowed delegation       | Authority consequence                                                                    |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Direct service     | `ApprovalAuthorityRepository` | Strictly decodes unknown request plus trusted binding; no caller identity/scope evidence |
| Composed HTTP      | `ApprovalAuthorityService`    | Two-phase assertion admission and bounded raw-body hashing; no repository shortcut       |
| CLI                | Composed HTTP                 | Retains exact bytes and has no service/storage import                                    |
| Storage repository | SQLite `BEGIN IMMEDIATE`      | Accepts prepared service authority only; no public/scope-only shapes                     |
| Restart recovery   | Internal executor             | Requires an existing matching consumed receipt and claim; never consumes an approval     |

Direct/HTTP/CLI do not merely return the same modeled result: the checker traces distinct boundary functions and proves their only delegate. Storage is the single atomic mutation boundary. Recovery is intentionally asymmetric and cannot manufacture a consume.

## Audit view

The durable chain is:

```text
plan -> creator + authority-version -> approval -> instance + challenge + signed challenge consumption -> one closure
     -> receipt + claim -> attempt authority -> dispatch/result -> terminal audit
```

The public safe projection includes principal IDs, profiles, approval/receipt/claim IDs, issue/expiry/consume times, and terminal state/time. Storage may retain opaque credential/auth-event/ceremony/key/executor-instance IDs for audit, but never bearer values, private signing keys, HMAC key bytes, or biometric/passcode data.
