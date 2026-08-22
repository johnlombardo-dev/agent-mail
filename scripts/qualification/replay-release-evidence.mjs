import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capture,
  canonicalJson,
  observationThresholdValues,
  runtimePathPlaceholders,
  runtimePathPlacement,
  sha256,
  thresholdMetricRegistry,
} from "./capture-release-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(`release evidence replay failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function comparableFixture(fixture) {
  if (!fixture || typeof fixture !== "object") return fixture;
  const value = structuredClone(fixture);
  if (value.materialized) {
    delete value.materialized.path;
    delete value.materialized.retainedFrom;
  }
  if (value.generationReceipt) {
    for (const key of ["receiptPath", "receiptSha256", "artifactPath", "inventoryPath"])
      delete value.generationReceipt[key];
  }
  // Peak RSS growth is a measurement of this run, not fixture identity. Keep
  // bytes/digests comparable while validating each receipt independently.
  if (value.observation) delete value.observation.peakRssGrowthBytes;
  return value;
}

function comparableAssertions(assertions) {
  const value = structuredClone(assertions);
  for (const assertion of value) {
    if (assertion?.observed && typeof assertion.observed === "object")
      delete assertion.observed.peakRssGrowthBytes;
  }
  return value;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function finiteReceiptNumber(value, label) {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} is unavailable or invalid`,
  );
}

function canonicalOutputRoot(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} output root is required`);
  const lexical = resolve(value);
  const lexicalStat = lstatSync(lexical);
  assert(
    lexicalStat.isDirectory() && !lexicalStat.isSymbolicLink(),
    `${label} output root is invalid`,
  );
  const canonical = realpathSync(lexical);
  const canonicalStat = lstatSync(canonical);
  assert(canonicalStat.isDirectory(), `${label} output root is not a directory`);
  return canonical;
}

function assertManifestStep(step) {
  assert(step && typeof step === "object", "manifest step authority is required");
  assert(typeof step.id === "string" && step.id.length > 0, "manifest step ID is required");
  assert(typeof step.cwd === "string", "manifest step cwd is required");
  assert(
    Array.isArray(step.argv) && step.argv.every((arg) => typeof arg === "string"),
    "manifest step argv is invalid",
  );
  assert(
    step.thresholds && typeof step.thresholds === "object",
    "manifest step thresholds are required",
  );
  assert(Array.isArray(step.probes), "manifest step probes are required");
  const placements =
    {
      "fts-generate-250k": { 3: "<temp-corpus>" },
      "fts-measure-250k": {
        2: "<temp-corpus>",
        3: "<measurement-output>",
        5: "<benchmark-copy>",
      },
    }[step.id] ?? {};
  for (const [index, expected] of Object.entries(placements))
    assert(step.argv[Number(index)] === expected, "manifest runtime path placeholder is missing");
  for (const [index, arg] of step.argv.entries()) {
    const tokens = [...arg.matchAll(/<[^>]*>/gu)].map(([token]) => token);
    if (tokens.length === 0) continue;
    assert(
      tokens.length === 1 && tokens[0] === arg && Object.hasOwn(runtimePathPlaceholders, tokens[0]),
      "manifest argv placeholder is unsupported or embedded",
    );
    assert(
      runtimePathPlacement(step, index) === tokens[0],
      "manifest argv placeholder is misplaced",
    );
    if (tokens[0] === "<temp-corpus>")
      assert(step.fixture?.kind === "generated-file", "manifest temp-corpus role is invalid");
    if (tokens[0] === "<temp-corpus>")
      assert(
        step.id === "fts-generate-250k"
          ? step.fixture.generationStepId === undefined
          : step.fixture.generationStepId === "fts-generate-250k",
        "manifest temp-corpus fixture owner is invalid",
      );
  }
}

function runtimePathObservation(root, value, runId, label, { allowMissing = false } = {}) {
  assert(typeof value === "string" && isAbsolute(value), `${label} path is not absolute`);
  assert(!value.includes("\\"), `${label} path contains a separator escape`);
  const lexical = resolve(value);
  let probe = lexical;
  const missing = [];
  let stat;
  while (true) {
    try {
      stat = lstatSync(probe);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(probe);
      assert(parent !== probe, `${label} path has no existing owner`);
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
  assert(!stat.isSymbolicLink(), `${label} path is a symlink alias`);
  const canonical = join(realpathSync(probe), ...missing);
  const relativePath = relative(root, canonical);
  assert(
    missing.length === 0 || (allowMissing && missing.length === 1),
    `${label} path is missing or has missing intermediate components`,
  );
  assert(
    relativePath &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath) &&
      relativePath.split("/").every((part) => part && part !== "." && part !== "..") &&
      relativePath.split("/")[0] === runId,
    `${label} path is not run-bound to its output root`,
  );
  const lexicalRoot = (() => {
    let ancestor = lexical;
    while (true) {
      try {
        const ancestorStat = lstatSync(ancestor);
        if (ancestorStat.isDirectory() && realpathSync(ancestor) === root) return ancestor;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return root;
      ancestor = parent;
    }
  })();
  const walk = (base, relativeValue) => {
    let current = base;
    for (const [index, part] of relativeValue.split("/").entries()) {
      current = join(current, part);
      let component;
      try {
        component = lstatSync(current);
      } catch (error) {
        assert(
          error?.code === "ENOENT" && allowMissing && index === relativeValue.split("/").length - 1,
          `${label} path component is unavailable`,
        );
        continue;
      }
      assert(!component.isSymbolicLink(), `${label} path component is a symlink alias`);
      if (index < relativeValue.split("/").length - 1)
        assert(component.isDirectory(), `${label} path component is not a directory`);
      else assert(component.isFile() && component.nlink === 1, `${label} path is not unique`);
    }
  };
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative) walk(root, canonicalRelative);
  const lexicalRelative = relative(lexicalRoot, lexical);
  if (lexicalRelative) walk(lexicalRoot, lexicalRelative);
  if (missing.length === 0) {
    assert(stat.isFile() && stat.nlink === 1, `${label} path is not a unique regular file`);
    return { canonical, identity: `${stat.dev}:${stat.ino}`, exists: true };
  }
  assert(stat.isDirectory(), `${label} path parent is not a directory`);
  return { canonical, identity: null, exists: false };
}

function expectedRuntimePath(token, receipt, step, outputRoot, label) {
  let relativePath;
  if (token === "<temp-corpus>") {
    const materialized = receipt.fixture?.materialized;
    assert(materialized, `${label} fixture input binding is missing`);
    assert(
      receipt.fixture?.id === step.fixture?.id && receipt.fixture?.kind === step.fixture?.kind,
      `${label} fixture identity diverged from manifest`,
    );
    const expectedOwner = step.fixture.generationStepId ? "prior-generator" : "generator";
    const expectedRelativePath = `${receipt.runId}/${
      step.fixture.generationStepId ? "fixtures" : "staging"
    }/${step.fixture.id}.bin`;
    assert(materialized.owner === expectedOwner, `${label} fixture input owner is invalid`);
    relativePath = materialized.retainedFrom ?? materialized.path;
    assert(relativePath === expectedRelativePath, `${label} fixture input role is invalid`);
    if (expectedOwner === "generator") {
      assert(
        materialized.retainedFrom === expectedRelativePath &&
          materialized.path === `${receipt.runId}/retained/${step.fixture.id}.sqlite` &&
          receipt.probes?.cleanup?.generatedStaging?.path === expectedRelativePath &&
          receipt.probes.cleanup.generatedStaging.removed === true &&
          receipt.probes.cleanup.generatedStaging.retainedPath === materialized.path,
        `${label} generator staging cleanup is not proven`,
      );
    }
  } else {
    relativePath = `${receipt.runId}/${
      token === "<measurement-output>" ? "measurement.json" : "benchmark-copy.sqlite"
    }`;
  }
  assert(
    typeof relativePath === "string" &&
      !isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      relativePath.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} runtime path binding is malformed`,
  );
  const expected = resolve(outputRoot, relativePath);
  const allowMissing =
    token === "<temp-corpus>" &&
    step.id === "fts-generate-250k" &&
    receipt.fixture?.materialized?.owner === "generator";
  runtimePathObservation(outputRoot, expected, receipt.runId, label, { allowMissing });
  return expected;
}

function compareManifestArgv(primary, replay, step, primaryRoot, replayRoot) {
  assert(Array.isArray(primary.argv) && Array.isArray(replay.argv), "receipt argv is missing");
  assert(primary.argv.length === step.argv.length, "primary argv length diverged");
  assert(replay.argv.length === step.argv.length, "replay argv length diverged");
  const identities = new Set();
  for (let index = 0; index < step.argv.length; index += 1) {
    const expected = step.argv[index];
    const tokens = [...expected.matchAll(/<[^>]*>/gu)].map(([token]) => token);
    if (tokens.length === 0) {
      assert(!/<[^>]*>/u.test(expected), "ordinary argv contains an unresolved placeholder");
      assert(primary.argv[index] === expected, `primary argv argument ${index} diverged`);
      assert(replay.argv[index] === expected, `replay argv argument ${index} diverged`);
      continue;
    }
    assert(tokens.length === 1 && tokens[0] === expected, "argv placeholder position is invalid");
    assert(Object.hasOwn(runtimePathPlaceholders, expected), "argv placeholder is unknown");
    const primaryExpected = expectedRuntimePath(
      expected,
      primary,
      step,
      primaryRoot,
      "primary argv",
    );
    const replayExpected = expectedRuntimePath(expected, replay, step, replayRoot, "replay argv");
    const allowMissing =
      expected === "<temp-corpus>" &&
      step.id === "fts-generate-250k" &&
      primary.fixture?.materialized?.owner === "generator";
    const primaryPath = runtimePathObservation(
      primaryRoot,
      primary.argv[index],
      primary.runId,
      "primary argv",
      { allowMissing },
    );
    const replayPath = runtimePathObservation(
      replayRoot,
      replay.argv[index],
      replay.runId,
      "replay argv",
      {
        allowMissing:
          expected === "<temp-corpus>" &&
          step.id === "fts-generate-250k" &&
          replay.fixture?.materialized?.owner === "generator",
      },
    );
    assert(
      primaryPath.canonical === resolve(primaryExpected),
      `primary ${expected} path is misplaced`,
    );
    assert(
      replayPath.canonical === resolve(replayExpected),
      `replay ${expected} path is misplaced`,
    );
    for (const identity of [primaryPath.identity, replayPath.identity].filter(Boolean)) {
      assert(!identities.has(identity), "runtime argv path reuses an existing inode");
      identities.add(identity);
    }
  }
}

function receiptPidSet(receipt, label) {
  const samples = receipt.probes?.process?.samples;
  assert(Array.isArray(samples) && samples.length >= 2, `${label} process samples are incomplete`);
  const process = receipt.process;
  assert(Number.isSafeInteger(process?.pid) && process.pid > 1, `${label} process PID is invalid`);
  assert(Number.isSafeInteger(process?.processGroup), `${label} process group is invalid`);
  assert(Math.abs(process.processGroup) === process.pid, `${label} process group is detached`);
  const pids = new Set();
  const processGroups = new Set();
  for (const sample of samples) {
    assert(Array.isArray(sample.pids), `${label} process sample PIDs are missing`);
    for (const pid of sample.pids) {
      assert(Number.isSafeInteger(pid) && pid > 1, `${label} process sample PID is invalid`);
      pids.add(pid);
    }
    for (const processGroup of sample.processGroups ?? []) {
      assert(
        Number.isSafeInteger(processGroup) && processGroup > 1,
        `${label} process sample group is invalid`,
      );
      processGroups.add(processGroup);
    }
  }
  assert(pids.has(process.pid), `${label} process PID is absent from process samples`);
  assert(
    processGroups.has(Math.abs(process.processGroup)),
    `${label} process group is absent from samples`,
  );
  for (const descendant of receipt.probes.process.descendants ?? [])
    assert(pids.has(descendant.pid), `${label} descendant PID is detached`);
  const resources = receipt.probes?.resources;
  assert(
    resources && Array.isArray(resources.pids) && Array.isArray(resources.attemptedPids),
    `${label} resource PID inventory is missing`,
  );
  const sorted = (values) => [...values].sort((left, right) => left - right);
  const sortedStrings = (values) => [...values].sort((left, right) => left.localeCompare(right));
  const samePids = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
  const sameOrdered = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const hermesPortsArray = (values, message) => {
    assert(Array.isArray(values), `${message} is missing`);
    assert(
      values.every((port) => Number.isSafeInteger(port) && port >= 6110 && port <= 6119),
      `${message} contains an invalid port`,
    );
    assert(new Set(values).size === values.length, `${message} repeats a port`);
    assert(JSON.stringify(values) === JSON.stringify(sorted(values)), `${message} is not sorted`);
    return values;
  };
  const uniquePids = (values, message) => {
    assert(
      values.every((pid) => Number.isSafeInteger(pid) && pid > 1),
      message,
    );
    assert(new Set(values).size === values.length, `${message} repeats a PID`);
  };
  const orderedPids = (values, message) => {
    uniquePids(values, message);
    assert(sameOrdered(values, sorted(values)), `${message} is not sorted`);
  };
  orderedPids(resources.pids, `${label} resource PID is invalid`);
  orderedPids(resources.attemptedPids, `${label} attempted resource PID is invalid`);
  assert(
    sameOrdered(resources.pids, resources.attemptedPids),
    `${label} top PID inventory diverges`,
  );
  const resourcePids = new Set(resources.pids);
  for (const pid of resourcePids)
    assert(pids.has(pid), `${label} resource PID is detached from process samples`);
  const resourceSamples = resources.samples;
  assert(
    Array.isArray(resourceSamples) && resourceSamples.length === samples.length,
    `${label} resource/process sample cardinality is inconsistent`,
  );
  const attemptedUnion = new Set();
  const observedUnion = new Set();
  const unavailableReasons = new Map();
  let anyObserved = false;
  const maximums = { fileDescriptors: null, sockets: null, listeners: null };
  const hermesPorts = new Set();
  for (const sample of resourceSamples) {
    assert(
      Array.isArray(sample.attemptedPids),
      `${label} resource attempted PID inventory is missing`,
    );
    assert(Array.isArray(sample.pids), `${label} resource sample PID inventory is missing`);
    orderedPids(sample.attemptedPids, `${label} resource attempted PID is invalid`);
    orderedPids(sample.pids, `${label} resource sample PID is invalid`);
    assert(
      sameOrdered(sample.pids, sample.attemptedPids),
      `${label} resource sample PID inventory is detached`,
    );
    for (const pid of sample.attemptedPids) {
      attemptedUnion.add(pid);
      assert(pids.has(pid), `${label} resource sample PID is detached from process samples`);
    }
    const results = sample.pidResults;
    assert(
      Array.isArray(results) && results.length === sample.attemptedPids.length,
      `${label} per-PID resource observations are incomplete`,
    );
    const resultPids = results.map((result) => result.pid);
    orderedPids(resultPids, `${label} per-PID resource identity is malformed`);
    assert(
      sameOrdered(resultPids, sample.attemptedPids),
      `${label} per-PID resource observations are detached`,
    );
    const observedResults = results.filter((result) => result.observed === true);
    const unavailableResults = results.filter((result) => result.observed === false);
    assert(
      observedResults.length + unavailableResults.length === results.length,
      `${label} resource observation status is invalid`,
    );
    const observedSamplePids = observedResults.map((result) => result.pid);
    const unavailableSamplePids = unavailableResults.map((result) => result.pid);
    assert(
      Array.isArray(sample.observedPids),
      `${label} observed resource PID inventory is missing`,
    );
    orderedPids(sample.observedPids, `${label} observed resource PID is invalid`);
    assert(
      sameOrdered(sample.observedPids, observedSamplePids),
      `${label} observed resource PID attribution is inconsistent`,
    );
    const unavailableRecords = sample.unavailablePids;
    assert(
      Array.isArray(unavailableRecords),
      `${label} unavailable resource PID inventory is malformed`,
    );
    assert(
      unavailableRecords.length === unavailableSamplePids.length,
      `${label} unavailable resource PID attribution is inconsistent`,
    );
    const unavailableRecordPids = unavailableRecords.map((entry) => entry.pid);
    orderedPids(unavailableRecordPids, `${label} unavailable resource PID inventory`);
    const unavailableSeen = new Set();
    for (const unavailable of unavailableRecords) {
      assert(
        Number.isSafeInteger(unavailable.pid) && unavailable.pid > 1,
        `${label} unavailable resource PID is malformed`,
      );
      assert(
        !unavailableSeen.has(unavailable.pid),
        `${label} unavailable resource PID repeats a PID`,
      );
      unavailableSeen.add(unavailable.pid);
      assert(
        unavailableSamplePids.includes(unavailable.pid),
        `${label} unavailable resource PID attribution is inconsistent`,
      );
      assert(
        typeof unavailable.reason === "string" && unavailable.reason.length > 0,
        `${label} unavailable resource reason is missing`,
      );
      if (!unavailableReasons.has(unavailable.pid))
        unavailableReasons.set(unavailable.pid, new Set());
      unavailableReasons.get(unavailable.pid).add(unavailable.reason);
    }
    assert(
      sameOrdered(unavailableSamplePids, unavailableRecordPids),
      `${label} unavailable resource PID attribution is inconsistent`,
    );
    for (const result of observedResults) {
      for (const metric of ["fileDescriptors", "sockets", "listeners"])
        assert(
          Number.isSafeInteger(result[metric]) && result[metric] >= 0,
          `${label} observed resource metric is malformed`,
        );
      hermesPortsArray(result.hermesPorts, `${label} observed Hermes ports`);
      assert(
        !Object.hasOwn(result, "reason"),
        `${label} observed resource has an unavailable reason`,
      );
      observedUnion.add(result.pid);
    }
    for (const result of unavailableResults) {
      assert(
        typeof result.reason === "string" && result.reason.length > 0,
        `${label} unavailable resource reason is missing`,
      );
      hermesPortsArray(result.hermesPorts, `${label} unavailable Hermes ports`);
      assert(result.hermesPorts.length === 0, `${label} unavailable resource has Hermes ports`);
    }
    for (const result of results) for (const port of result.hermesPorts) hermesPorts.add(port);
    anyObserved ||= observedResults.length > 0;
    assert(
      sample.observed === observedResults.length > 0,
      `${label} resource sample status is inconsistent`,
    );
    for (const metric of ["fileDescriptors", "sockets", "listeners"]) {
      const expected =
        observedResults.length > 0
          ? observedResults.reduce((sum, result) => sum + result[metric], 0)
          : null;
      assert(sample[metric] === expected, `${label} resource aggregate ${metric} is inconsistent`);
      if (expected !== null)
        maximums[metric] =
          maximums[metric] === null ? expected : Math.max(maximums[metric], expected);
    }
    hermesPortsArray(sample.hermesPorts, `${label} resource sample Hermes ports`);
    assert(
      samePids(sample.hermesPorts, [...new Set(results.flatMap((result) => result.hermesPorts))]),
      `${label} resource sample Hermes ports are inconsistent`,
    );
  }
  assert(
    sameOrdered(sorted([...attemptedUnion]), resources.pids),
    `${label} top attempted PID union is inconsistent`,
  );
  assert(Array.isArray(resources.observedPids), `${label} top observed PID inventory is missing`);
  orderedPids(resources.observedPids, `${label} top observed resource PID is invalid`);
  assert(
    sameOrdered(sorted([...observedUnion]), resources.observedPids),
    `${label} top observed PID union is inconsistent`,
  );
  assert(
    resources.observed === anyObserved,
    `${label} top resource observation status is inconsistent`,
  );
  const topUnavailable = resources.unavailablePids;
  assert(Array.isArray(topUnavailable), `${label} top unavailable resource inventory is missing`);
  const expectedUnavailable = [...attemptedUnion]
    .filter((pid) => !observedUnion.has(pid))
    .sort((left, right) => left - right);
  assert(
    topUnavailable.length === expectedUnavailable.length,
    `${label} top unavailable resource inventory is inconsistent`,
  );
  const topUnavailableSeen = new Set();
  for (const entry of topUnavailable) {
    assert(
      Number.isSafeInteger(entry.pid) && entry.pid > 1,
      `${label} top unavailable resource PID is malformed`,
    );
    assert(
      !topUnavailableSeen.has(entry.pid),
      `${label} top unavailable resource PID repeats a PID`,
    );
    topUnavailableSeen.add(entry.pid);
    assert(
      expectedUnavailable.includes(entry.pid),
      `${label} top unavailable resource PID is stale`,
    );
    assert(
      Array.isArray(entry.reasons) && entry.reasons.length > 0,
      `${label} top unavailable resource reasons are missing`,
    );
    assert(
      new Set(entry.reasons).size === entry.reasons.length &&
        entry.reasons.every((reason) => typeof reason === "string" && reason.length > 0),
      `${label} top unavailable resource reasons are malformed`,
    );
    assert(
      sameOrdered(entry.reasons, sortedStrings(entry.reasons)),
      `${label} top unavailable resource reasons are not sorted`,
    );
    assert(
      JSON.stringify([...entry.reasons].sort((left, right) => left.localeCompare(right))) ===
        JSON.stringify(
          [...(unavailableReasons.get(entry.pid) ?? [])].sort((left, right) =>
            left.localeCompare(right),
          ),
        ),
      `${label} top unavailable resource reasons diverge`,
    );
  }
  const topUnavailablePids = topUnavailable.map((entry) => entry.pid);
  orderedPids(topUnavailablePids, `${label} top unavailable resource PID inventory`);
  assert(
    sameOrdered(topUnavailablePids, expectedUnavailable),
    `${label} top unavailable resource PID inventory is inconsistent`,
  );
  for (const metric of ["fileDescriptors", "sockets", "listeners"])
    assert(
      resources[metric] === maximums[metric],
      `${label} top resource ${metric} maximum is inconsistent`,
    );
  hermesPortsArray(resources.hermesPorts, `${label} top resource Hermes ports`);
  assert(
    samePids(resources.hermesPorts, [...hermesPorts]),
    `${label} top resource Hermes ports union is inconsistent`,
  );
  assert(pids.size > 0, `${label} process PID inventory is empty`);
  return pids;
}

function validateIndependentRuntime(receipt, label, step) {
  assertManifestStep(step);
  assert(receipt.result === "pass", `${label} result is not pass`);
  const process = receipt.probes?.process;
  assert(process?.observed === true, `${label} process probe is unavailable`);
  assert(process.rssStatus === "observed", `${label} RSS probe is unavailable`);
  finiteReceiptNumber(process.peakRssBytes, `${label} peak RSS`);
  const terminal = process.samples.at(-1);
  assert(
    terminal && terminal.rootPresent === false,
    `${label} process did not reach terminal sample`,
  );
  assert(
    receipt.probes?.cleanup?.barrier === "awaited-idempotent" &&
      receipt.probes.cleanup.invocations === 1 &&
      receipt.probes.cleanup.executionRootRemoved === true &&
      receipt.probes.cleanup.termination?.completed === true &&
      receipt.probes.cleanup.termination.survivorsAfterKill?.length === 0,
    `${label} cleanup is unsettled`,
  );
  assert(
    receipt.probes?.tempRoot?.path && receipt.probes.tempRoot.removed === true,
    `${label} temporary root probe is unavailable`,
  );
  const thresholds = step?.thresholds ?? {};
  const thresholdSatisfied = (value, threshold) => {
    if (!Number.isFinite(value)) return false;
    if (threshold.operator === "<") return value < threshold.limit;
    if (threshold.operator === "<=") return value <= threshold.limit;
    if (threshold.operator === "===") return value === threshold.limit;
    if (threshold.operator === ">=") return value >= threshold.limit;
    if (threshold.operator === ">") return value > threshold.limit;
    return false;
  };
  const values = {
    processRssBytes: process.peakRssBytes,
    fileDescriptors: receipt.probes.resources?.fileDescriptors,
    sockets: receipt.probes.resources?.sockets,
    listeners: receipt.probes.resources?.listeners,
  };
  for (const [metric, threshold] of Object.entries(thresholds)) {
    if (metric === "timeoutMs" || threshold?.source === "fixture-observation") continue;
    const metricSpec = thresholdMetricRegistry[metric];
    assert(metricSpec, `${label} unknown threshold metric`);
    if (metricSpec.kind !== "kernel") continue;
    assert(
      threshold && thresholdSatisfied(values[metric], threshold),
      `${label} ${metric} threshold failed`,
    );
  }
  observationThresholdValues(step, receipt.assertions, label);
  const probes = new Set(step.probes);
  if (probes.has("streams")) {
    assert(receipt.probes?.streams?.observed === true, `${label} stream probe is unavailable`);
    for (const key of ["stdout", "stderr", "events"])
      assert(receipt.streams?.[key], `${label} ${key} stream is missing`);
  }
  if (probes.has("tempRoot"))
    assert(
      receipt.probes?.tempRoot?.path && receipt.probes.tempRoot.removed === true,
      `${label} temporary root probe is unavailable`,
    );
  if (["fileDescriptors", "sockets", "listeners", "HermesLease"].some((probe) => probes.has(probe)))
    assert(receipt.probes.resources?.observed === true, `${label} resource probe is unavailable`);
  return receiptPidSet(receipt, label);
}

function assertDistinctRegularArtifacts(primary, replay, options) {
  const primaryRoot = canonicalOutputRoot(options?.primaryOutputRoot, "primary");
  const replayRoot = canonicalOutputRoot(options?.replayOutputRoot, "replay");
  assert(primaryRoot !== replayRoot, "primary and replay output roots are aliased");
  assert(
    !primaryRoot.startsWith(`${replayRoot}/`) && !replayRoot.startsWith(`${primaryRoot}/`),
    "output roots overlap",
  );
  const identities = new Set();
  const validateRef = (root, runId, ref, label) => {
    assert(ref && typeof ref.path === "string", `${label} reference is missing`);
    assert(
      typeof ref.sha256 === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${label} digest is missing`,
    );
    assert(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, `${label} byte count is invalid`);
    assert(!isAbsolute(ref.path) && !ref.path.includes("\\"), `${label} path is unsafe`);
    const parts = ref.path.split("/");
    assert(
      parts[0] === runId && parts.every((part) => part && part !== "." && part !== ".."),
      `${label} path is not run-bound`,
    );
    const path = resolve(root, ref.path);
    assert(relative(root, path) === ref.path, `${label} path escaped output root`);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
    const realPath = realpathSync(path);
    assert(relative(root, realPath) === ref.path, `${label} path resolves outside output root`);
    const bytes = readFileSync(path);
    assert(bytes.length === ref.bytes, `${label} byte count drifted`);
    assert(sha256(bytes) === ref.sha256, `${label} digest drifted`);
    const identity = `${stat.dev}:${stat.ino}`;
    assert(!identities.has(identity), `${label} reuses another artifact inode`);
    identities.add(identity);
  };
  const refs = ["stdout", "stderr", "events"].map((key) => [
    key,
    primary.streams[key],
    replay.streams[key],
  ]);
  for (const [key, primaryRef, replayRef] of refs) {
    assert(primaryRef.path !== replayRef.path, `${key} path was reused`);
    validateRef(primaryRoot, primary.runId, primaryRef, `primary ${key}`);
    validateRef(replayRoot, replay.runId, replayRef, `replay ${key}`);
  }
  const primaryFixturePath = primary.fixture?.materialized?.path;
  const replayFixturePath = replay.fixture?.materialized?.path;
  if (primaryFixturePath || replayFixturePath) {
    assert(primaryFixturePath && replayFixturePath, "fixture materialization path is missing");
    assert(primaryFixturePath !== replayFixturePath, "fixture artifact path was reused");
    assert(primaryFixturePath.split("/")[0] === primary.runId, "primary fixture is not run-bound");
    assert(replayFixturePath.split("/")[0] === replay.runId, "replay fixture is not run-bound");
    validateRef(primaryRoot, primary.runId, primary.fixture.materialized, "primary fixture");
    validateRef(replayRoot, replay.runId, replay.fixture.materialized, "replay fixture");
  }
}

function provenanceObservations(receipt) {
  return {
    process: receipt.process,
    processProbe: receipt.probes.process,
    resources: receipt.probes.resources,
    termination: receipt.probes.cleanup.termination,
    cleanup: receipt.probes.cleanup,
    streams: receipt.probes.streams,
    monotonic: receipt.monotonic,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    observedOutcome: receipt.observedOutcome,
  };
}

function validateProvenanceEnvelope(root, receipt, step, label) {
  const outputRoot = canonicalOutputRoot(root, label);
  const provenance = receipt.provenance;
  assert(
    provenance?.format === "agent-mail.capture-provenance/v1",
    `${label} envelope reference is missing`,
  );
  assert(
    typeof provenance.path === "string" && provenance.path.split("/")[0] === receipt.runId,
    `${label} envelope path is not run-bound`,
  );
  assert(
    provenance.path === `${receipt.runId}/${receipt.manifestStepId}.provenance.json`,
    `${label} envelope path is not canonical`,
  );
  assert(
    !isAbsolute(provenance.path) && !provenance.path.includes("\\"),
    `${label} envelope path is unsafe`,
  );
  assert(
    provenance.path.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} envelope path traverses`,
  );
  const envelopePath = resolve(outputRoot, provenance.path);
  assert(
    relative(outputRoot, envelopePath) === provenance.path,
    `${label} envelope escaped output root`,
  );
  const envelopeStat = lstatSync(envelopePath);
  assert(
    envelopeStat.isFile() && !envelopeStat.isSymbolicLink(),
    `${label} envelope is not regular`,
  );
  const envelopeRealPath = realpathSync(envelopePath);
  assert(
    relative(outputRoot, envelopeRealPath) === provenance.path,
    `${label} envelope resolves outside output root`,
  );
  const envelopeBytes = readFileSync(envelopePath);
  assert(envelopeBytes.length === provenance.bytes, `${label} envelope byte count drifted`);
  assert(sha256(envelopeBytes) === provenance.sha256, `${label} envelope digest drifted`);
  const envelope = JSON.parse(envelopeBytes.toString("utf8"));
  assert(envelope.format === provenance.format, `${label} envelope format drifted`);
  assert(
    envelope.runId === receipt.runId && envelope.role === receipt.role,
    `${label} envelope identity drifted`,
  );
  const core = structuredClone(receipt);
  delete core.provenance;
  const receiptDigest = sha256(canonicalJson(core));
  assert(
    envelope.receiptSha256 === receiptDigest && provenance.receiptSha256 === receiptDigest,
    `${label} receipt digest is detached`,
  );
  const observations = provenanceObservations(receipt);
  assert(
    canonicalJson(envelope.observations) === canonicalJson(observations),
    `${label} observations drifted`,
  );
  const observationsDigest = sha256(canonicalJson(observations));
  assert(
    envelope.observationsSha256 === observationsDigest &&
      provenance.observationsSha256 === observationsDigest,
    `${label} observation digest is detached`,
  );
  const expectedAuthority = {
    candidate: receipt.candidate,
    manifestStepId: receipt.manifestStepId,
    cwd: receipt.cwd,
    argv: receipt.argv,
    sources: receipt.sources,
    runnerSources: receipt.runnerSources,
    fixture: receipt.fixture,
    assertions: receipt.assertions,
    probes: step.probes,
    thresholds: step.thresholds,
  };
  assert(
    canonicalJson(envelope.authority) === canonicalJson(expectedAuthority),
    `${label} manifest authority drifted`,
  );
  assert(envelope.roots?.output?.path === outputRoot, `${label} output root identity drifted`);
  assert(
    envelope.roots.output.dev === lstatSync(outputRoot).dev &&
      envelope.roots.output.ino === lstatSync(outputRoot).ino,
    `${label} output root inode drifted`,
  );
  assert(envelope.roots?.temporary?.removed === true, `${label} temporary root was not removed`);
  assert(
    typeof envelope.roots.temporary.path === "string" &&
      Number.isSafeInteger(envelope.roots.temporary.dev) &&
      Number.isSafeInteger(envelope.roots.temporary.ino),
    `${label} temporary root identity is missing`,
  );
  const artifactRefs = {
    stdout: receipt.streams.stdout,
    stderr: receipt.streams.stderr,
    events: receipt.streams.events,
    ...(receipt.fixture?.materialized?.path ? { fixture: receipt.fixture.materialized } : {}),
  };
  const identities = new Set([`${envelopeStat.dev}:${envelopeStat.ino}`]);
  for (const [key, ref] of Object.entries(artifactRefs)) {
    const artifact = envelope.artifacts?.[key];
    assert(artifact, `${label} ${key} provenance is missing`);
    assert(
      artifact.path === ref.path && artifact.bytes === ref.bytes && artifact.sha256 === ref.sha256,
      `${label} ${key} provenance reference drifted`,
    );
    assert(
      artifact.capturedAt === receipt.completedAt && !Number.isNaN(Date.parse(artifact.capturedAt)),
      `${label} ${key} capture timestamp is invalid`,
    );
    const path = resolve(outputRoot, ref.path);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} ${key} is not regular`);
    const bytes = readFileSync(path);
    assert(
      bytes.length === ref.bytes && sha256(bytes) === ref.sha256,
      `${label} ${key} bytes drifted`,
    );
    assert(artifact.dev === stat.dev && artifact.ino === stat.ino, `${label} ${key} inode drifted`);
    assert(
      artifact.birthtimeMs === stat.birthtimeMs &&
        artifact.ctimeMs === stat.ctimeMs &&
        artifact.mtimeMs === stat.mtimeMs,
      `${label} ${key} filesystem timestamps drifted`,
    );
    const identity = `${stat.dev}:${stat.ino}`;
    assert(!identities.has(identity), `${label} ${key} reuses the envelope inode`);
    identities.add(identity);
  }
  return { identity: `${envelopeStat.dev}:${envelopeStat.ino}`, path: envelopePath };
}

function existingRegularPath(path, label) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  return {
    absolute: resolve(path),
    canonical: realpathSync(path),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function candidateOutputPath(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStat = lstatSync(parent);
  assert(
    parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    "receipt output parent is invalid",
  );
  const canonicalParent = realpathSync(parent);
  return { absolute, canonical: join(canonicalParent, absolute.slice(parent.length + 1)) };
}

function assertSafeReceiptOutput(primary, primaryPath, primaryOutputRoot, receiptPath, step) {
  assert(receiptPath, "--receipt is required");
  const primaryFile = existingRegularPath(primaryPath, "primary receipt");
  const primaryEnvelope = validateProvenanceEnvelope(primaryOutputRoot, primary, step, "primary");
  const output = candidateOutputPath(receiptPath);
  const protectedTargets = [
    primaryFile,
    existingRegularPath(primaryEnvelope.path, "primary provenance envelope"),
  ];
  for (const target of protectedTargets) {
    assert(
      output.absolute !== target.absolute,
      "receipt output would overwrite a primary artifact",
    );
    assert(
      output.canonical !== target.canonical,
      "receipt output is a lexical or symlink alias of a primary artifact",
    );
  }
  let existing;
  try {
    existing = lstatSync(output.absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) {
    assert(
      existing.dev !== primaryFile.dev || existing.ino !== primaryFile.ino,
      "receipt output reuses the primary inode",
    );
    fail("receipt output already exists");
  }
  return output.absolute;
}

export function writeExclusiveReceipt(path, bytes) {
  let descriptor;
  let created = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    const file = fstatSync(descriptor);
    assert(
      file.isFile() && file.size === bytes.length,
      "receipt output changed during exclusive write",
    );
    const pathStat = lstatSync(path);
    assert(
      !pathStat.isSymbolicLink() && pathStat.dev === file.dev && pathStat.ino === file.ino,
      "receipt output identity changed during write",
    );
  } catch (error) {
    if (created) {
      try {
        const pathStat = lstatSync(path);
        if (descriptor !== undefined) {
          const file = fstatSync(descriptor);
          if (pathStat.dev === file.dev && pathStat.ino === file.ino) unlinkSync(path);
        }
      } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function compareReceipts(primary, replay, options = {}) {
  assertManifestStep(options.step);
  assert(
    options.primaryOutputRoot && options.replayOutputRoot,
    "primary and replay output roots are required",
  );
  assert(Array.isArray(options.runnerSources), "runner source authority is required");
  assert(primary.format === "agent-mail.executable-receipt/v2", "primary receipt format");
  assert(replay.format === primary.format, "replay receipt format");
  assert(primary.role === "primary" && replay.role === "independent-replay", "receipt roles");
  assert(
    primary.manifestStepId === options.step.id && replay.manifestStepId === options.step.id,
    "manifest step diverged",
  );
  assert(
    primary.cwd === options.step.cwd && replay.cwd === options.step.cwd,
    "manifest cwd diverged",
  );
  const expectedSources = (options.step.sources ?? []).map(
    ({ role, path, gitBlob, sha256: digest }) => ({ role, path, gitBlob, sha256: digest }),
  );
  assert(
    canonicalJson(primary.sources) === canonicalJson(expectedSources),
    "primary source authority diverged",
  );
  assert(
    canonicalJson(replay.sources) === canonicalJson(expectedSources),
    "replay source authority diverged",
  );
  const expectedRunnerSources = options.runnerSources.map(
    ({ role, path, gitBlob, sha256: digest }) => ({
      role,
      path,
      gitBlob,
      sha256: digest,
    }),
  );
  assert(
    canonicalJson(primary.runnerSources ?? []) === canonicalJson(expectedRunnerSources) &&
      canonicalJson(replay.runnerSources ?? []) === canonicalJson(expectedRunnerSources),
    "runner source authority diverged",
  );
  assert(primary.runId !== replay.runId, "replay reused the primary run ID");
  const primaryPids = validateIndependentRuntime(primary, "primary receipt", options.step);
  const replayPids = validateIndependentRuntime(replay, "replay receipt", options.step);
  const primaryEnvelope = validateProvenanceEnvelope(
    options.primaryOutputRoot,
    primary,
    options.step,
    "primary",
  );
  const replayEnvelope = validateProvenanceEnvelope(
    options.replayOutputRoot,
    replay,
    options.step,
    "replay",
  );
  assert(
    primaryEnvelope.identity !== replayEnvelope.identity,
    "replay reused the primary provenance envelope",
  );
  assert(
    primary.process?.pid !== replay.process?.pid &&
      primary.process?.processGroup !== replay.process?.processGroup,
    "replay reused the primary process identity",
  );
  assert(
    [...primaryPids].every((pid) => !replayPids.has(pid)),
    "replay reused a primary process PID",
  );
  assert(
    primary.probes.tempRoot.path !== replay.probes.tempRoot.path,
    "replay reused the primary checkout/temp root",
  );
  for (const key of ["commit", "tree", "manifestPath", "manifestSha256"]) {
    assert(primary.candidate[key] === replay.candidate[key], `candidate ${key} diverged`);
  }
  for (const key of ["manifestStepId", "cwd"])
    assert(primary[key] === replay[key], `${key} diverged`);
  compareManifestArgv(
    primary,
    replay,
    options.step,
    canonicalOutputRoot(options.primaryOutputRoot, "primary"),
    canonicalOutputRoot(options.replayOutputRoot, "replay"),
  );
  assert(
    canonicalJson(primary.sources) === canonicalJson(replay.sources),
    "replay source bindings diverged",
  );
  assert(
    canonicalJson(primary.probes.resources.hermesPorts) ===
      canonicalJson(replay.probes.resources.hermesPorts),
    "replay Hermes port summary diverged",
  );
  assert(
    canonicalJson(comparableFixture(primary.fixture)) ===
      canonicalJson(comparableFixture(replay.fixture)),
    "replay fixture diverged",
  );
  assert(
    canonicalJson(comparableAssertions(primary.assertions)) ===
      canonicalJson(comparableAssertions(replay.assertions)),
    "replay assertions diverged",
  );
  assertDistinctRegularArtifacts(primary, replay, options);
  return {
    candidateCommit: primary.candidate.commit,
    candidateTree: primary.candidate.tree,
    stepId: primary.manifestStepId,
    primaryRunId: primary.runId,
    replayRunId: replay.runId,
    primaryResult: primary.result,
    replayResult: replay.result,
    primaryDurationNs: primary.monotonic.durationNs,
    replayDurationNs: replay.monotonic.durationNs,
    primaryPeakRssBytes: primary.probes.process.peakRssBytes,
    replayPeakRssBytes: replay.probes.process.peakRssBytes,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token.startsWith("--")) args[token.slice(2)] = argv[++index];
    else fail(`unexpected argument ${token}`);
  }
  return args;
}

async function selfTest() {
  const root = mkdtempSync("/tmp/agent-mail-replay-self-test-");
  let replayCheckout;
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "replay@example.invalid"]);
    git(root, ["config", "user.name", "replay self-test"]);
    writeFileSync(
      join(root, "tiny-receipt.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "const temp = args.find((arg) => arg.endsWith('.bin'));",
        "if (temp) {",
        "  mkdirSync(dirname(temp), { recursive: true });",
        "  writeFileSync(temp, 'tiny-corpus');",
        "  writeFileSync(`${temp}.inventory.json`, JSON.stringify({ logicalChecksum: '0'.repeat(64) }));",
        "}",
        "for (const output of args.filter((arg) => arg.endsWith('measurement.json') || arg.endsWith('benchmark-copy.sqlite'))) {",
        "  mkdirSync(dirname(output), { recursive: true });",
        "  writeFileSync(output, 'tiny-output');",
        "}",
        "process.stdout.write('tiny-pass\\n');",
        "setTimeout(() => {}, 1500);",
        "",
      ].join("\n"),
    );
    git(root, ["add", "tiny-receipt.mjs"]);
    git(root, ["commit", "-qm", "tiny command"]);
    const source = execFileSync("git", ["cat-file", "blob", "HEAD:tiny-receipt.mjs"], {
      cwd: root,
    });
    const manifest = {
      format: "agent-mail.release-evidence-execution-manifest/v2",
      schemaVersion: 2,
      ownerIssueId: 176,
      replay: {
        required: true,
        compare: ["candidate", "argv", "sources", "fixture", "assertions"],
      },
      attackInventory: Array.from({ length: 40 }, (_, index) => `tiny-attack-${index + 1}`),
      steps: [
        {
          id: "fts-generate-250k",
          ownerIssueId: 176,
          gate: "capacity",
          obligationIds: ["F17"],
          cwd: ".",
          argv: ["node", "tiny-receipt.mjs", "250000", "<temp-corpus>", "1162026"],
          sources: [
            {
              role: "entrypoint",
              path: "tiny-receipt.mjs",
              gitBlob: git(root, ["rev-parse", "HEAD:tiny-receipt.mjs"]),
              sha256: sha256(source),
            },
          ],
          assertions: [{ id: "tiny-exit-zero", kind: "exitCode", expected: 0 }],
          observations: ["stdout", "stderr", "exitCode", "durationNs"],
          thresholds: { timeoutMs: 5000 },
          probes: ["process", "streams", "tempRoot"],
          fixture: { kind: "generated-file", id: "tiny-fixture", recipe: "tiny-corpus" },
        },
        {
          id: "fts-measure-250k",
          ownerIssueId: 176,
          gate: "capacity",
          obligationIds: ["F17"],
          cwd: ".",
          argv: [
            "node",
            "tiny-receipt.mjs",
            "<temp-corpus>",
            "<measurement-output>",
            "1500",
            "<benchmark-copy>",
          ],
          sources: [
            {
              role: "entrypoint",
              path: "tiny-receipt.mjs",
              gitBlob: git(root, ["rev-parse", "HEAD:tiny-receipt.mjs"]),
              sha256: sha256(source),
            },
          ],
          assertions: [{ id: "tiny-measure-exit-zero", kind: "exitCode", expected: 0 }],
          observations: ["stdout", "stderr", "exitCode", "durationNs"],
          thresholds: { timeoutMs: 5000 },
          probes: ["streams", "tempRoot"],
          fixture: {
            kind: "generated-file",
            id: "tiny-fixture",
            recipe: "generated-corpus-from-prior-step",
            generationStepId: "fts-generate-250k",
          },
        },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    git(root, ["add", "manifest.json"]);
    git(root, ["commit", "-qm", "tiny manifest"]);
    const primaryRoot = mkdtempSync(join(tmpdir(), "agent-mail-replay-primary-"));
    const replayRoot = mkdtempSync(join(tmpdir(), "agent-mail-replay-replay-"));
    const generationStep = manifest.steps[0];
    const measureStep = manifest.steps[1];
    const primaryGeneration = await capture({
      manifestPath,
      root,
      outputRoot: primaryRoot,
      role: "primary",
      stepId: generationStep.id,
    });
    const primaryGenerationReceiptPath = join(primaryRoot, "generation.receipt.json");
    writeFileSync(primaryGenerationReceiptPath, JSON.stringify(primaryGeneration, null, 2) + "\n");
    replayCheckout = mkdtempSync(join(tmpdir(), "agent-mail-replay-checkout-"));
    rmSync(replayCheckout, { recursive: true, force: true });
    git(root, ["clone", "-q", root, replayCheckout]);
    const replayGeneration = await capture({
      manifestPath: join(replayCheckout, "manifest.json"),
      root: replayCheckout,
      outputRoot: replayRoot,
      role: "independent-replay",
      stepId: generationStep.id,
    });
    const replayGenerationReceiptPath = join(replayRoot, "generation.receipt.json");
    writeFileSync(replayGenerationReceiptPath, JSON.stringify(replayGeneration, null, 2) + "\n");
    const primary = await capture({
      manifestPath,
      root,
      outputRoot: primaryRoot,
      role: "primary",
      stepId: measureStep.id,
      generationReceiptPath: primaryGenerationReceiptPath,
      generationOutputRoot: primaryRoot,
    });
    const replay = await capture({
      manifestPath: join(replayCheckout, "manifest.json"),
      root: replayCheckout,
      outputRoot: replayRoot,
      role: "independent-replay",
      stepId: measureStep.id,
      generationReceiptPath: replayGenerationReceiptPath,
      generationOutputRoot: replayRoot,
    });
    const generationComparison = compareReceipts(primaryGeneration, replayGeneration, {
      primaryOutputRoot: primaryRoot,
      replayOutputRoot: replayRoot,
      step: generationStep,
      runnerSources: manifest.runner?.sources ?? [],
    });
    const comparison = compareReceipts(primary, replay, {
      primaryOutputRoot: primaryRoot,
      replayOutputRoot: replayRoot,
      step: measureStep,
      runnerSources: manifest.runner?.sources ?? [],
    });
    const manifestAttacks = [
      ["unknown runtime placeholder", "<unknown-path>"],
      ["embedded runtime placeholder", "prefix<temp-corpus>"],
      ["misplaced runtime placeholder", "<temp-corpus>"],
      ["omitted required runtime placeholder", "input.bin"],
      ["wrong runtime placeholder role", "<benchmark-copy>"],
    ];
    let manifestRejected = 0;
    for (const [name, value] of manifestAttacks) {
      const forgedStep = structuredClone(measureStep);
      if (name === "misplaced runtime placeholder")
        forgedStep.argv = [
          "node",
          value,
          "input.bin",
          "<measurement-output>",
          "1500",
          "<benchmark-copy>",
        ];
      else forgedStep.argv[2] = value;
      let accepted = false;
      try {
        compareReceipts(primary, replay, {
          primaryOutputRoot: primaryRoot,
          replayOutputRoot: replayRoot,
          step: forgedStep,
          runnerSources: manifest.runner?.sources ?? [],
        });
        accepted = true;
      } catch {}
      assert(!accepted, `${name} was accepted`);
      manifestRejected += 1;
    }
    const reorderOrInvalidate = (values, invalidValue) =>
      values.length > 1
        ? values.slice().reverse()
        : values.length === 1
          ? [values[0], values[0]]
          : [invalidValue];
    const attacks = [
      ["reused run ID", (value) => (value.runId = primary.runId)],
      ["reused temp root", (value) => (value.probes.tempRoot.path = primary.probes.tempRoot.path)],
      ["reused process PID", (value) => (value.process.pid = primary.process.pid)],
      [
        "reused process group",
        (value) => (value.process.processGroup = primary.process.processGroup),
      ],
      ["source drift", (value) => (value.sources[0].sha256 = "0".repeat(64))],
      ["argv drift", (value) => (value.argv = ["node", "forged.mjs"])],
      ["primary runtime path reuse", (value) => (value.argv[2] = primary.argv[2])],
      ["runtime path escape", (value) => (value.argv[2] = join(replayRoot, "../escaped-fixture"))],
      [
        "runtime ordinary argument normalization",
        (value) => (value.argv[1] = "./tiny-receipt.mjs"),
      ],
      ["assertion drift", (value) => (value.assertions[0].pass = false)],
      [
        "fixture path reuse",
        (value) => (value.fixture.materialized.path = primary.fixture.materialized.path),
      ],
      ["stream path reuse", (value) => (value.streams.stdout.path = primary.streams.stdout.path)],
      ["RSS unavailable", (value) => (value.probes.process.rssStatus = "notApplicable")],
      [
        "cleanup survivor",
        (value) => (value.probes.cleanup.termination.survivorsAfterKill = [1234]),
      ],
      ["artifact digest drift", (value) => (value.streams.stdout.sha256 = "0".repeat(64))],
      ["artifact missing", (value) => (value.streams.stderr.path = `${value.runId}/missing`)],
      ["artifact traversal", (value) => (value.streams.events.path = "../events.jsonl")],
      ["resource PID retyping", (value) => (value.probes.resources.pids = [1234])],
      [
        "resource aggregate forged zero",
        (value) => {
          const sample = value.probes.resources.samples.find((candidate) => candidate.observed);
          sample.fileDescriptors = 0;
          value.probes.resources.fileDescriptors = 0;
        },
      ],
      [
        "resource PID result duplication",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.pidResults.push(structuredClone(sample.pidResults[0]));
        },
      ],
      [
        "resource attempted PID fallback",
        (value) => delete value.probes.resources.samples[0].attemptedPids,
      ],
      [
        "resource PID result stale",
        (value) => (value.probes.resources.samples[0].pidResults[0].pid = 999999),
      ],
      [
        "resource unavailable reason missing",
        (value) => {
          const unavailable = value.probes.resources.unavailablePids[0];
          if (unavailable) unavailable.reasons = [""];
          else
            value.probes.resources.unavailablePids = [
              { pid: value.probes.resources.pids[0], reasons: [""] },
            ];
        },
      ],
      [
        "resource top union omission",
        (value) => {
          if (value.probes.resources.observedPids.length > 0)
            value.probes.resources.observedPids.pop();
          else value.probes.resources.observedPids = [1234];
        },
      ],
      [
        "resource top pids reorder",
        (value) =>
          (value.probes.resources.pids = reorderOrInvalidate(value.probes.resources.pids, 1234)),
      ],
      [
        "resource top attempted pids reorder",
        (value) =>
          (value.probes.resources.attemptedPids = reorderOrInvalidate(
            value.probes.resources.attemptedPids,
            1234,
          )),
      ],
      [
        "resource top observed pids reorder",
        (value) =>
          (value.probes.resources.observedPids = reorderOrInvalidate(
            value.probes.resources.observedPids,
            1234,
          )),
      ],
      [
        "resource top unavailable pids reorder",
        (value) => {
          const entries = value.probes.resources.unavailablePids;
          value.probes.resources.unavailablePids =
            entries.length > 1
              ? entries.slice().reverse()
              : [{ pid: value.probes.resources.pids[0], reasons: ["forged"] }];
        },
      ],
      [
        "resource sample pids reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.pids = reorderOrInvalidate(sample.pids, 1234);
        },
      ],
      [
        "resource sample attempted pids reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.attemptedPids = reorderOrInvalidate(sample.attemptedPids, 1234);
        },
      ],
      [
        "resource sample observed pids reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.observedPids = reorderOrInvalidate(sample.observedPids, 1234);
        },
      ],
      [
        "resource sample unavailable pids reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.unavailablePids =
            sample.unavailablePids.length > 1
              ? sample.unavailablePids.slice().reverse()
              : [{ pid: sample.attemptedPids[0], reason: "forged" }];
        },
      ],
      [
        "resource sample pidResults reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.pidResults = reorderOrInvalidate(sample.pidResults, { pid: 1234 });
        },
      ],
      [
        "resource coordinated PID reorder",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.pids = reorderOrInvalidate(sample.pids, 1234);
          sample.attemptedPids = reorderOrInvalidate(sample.attemptedPids, 1234);
          sample.observedPids = reorderOrInvalidate(sample.observedPids, 1234);
          sample.pidResults = reorderOrInvalidate(sample.pidResults, { pid: 1234 });
        },
      ],
      [
        "resource sample observed PID omission",
        (value) => delete value.probes.resources.samples[0].observedPids,
      ],
      [
        "resource sample unavailable PID omission",
        (value) => delete value.probes.resources.samples[0].unavailablePids,
      ],
      ["resource top observed PID omission", (value) => delete value.probes.resources.observedPids],
      [
        "resource top unavailable PID omission",
        (value) => delete value.probes.resources.unavailablePids,
      ],
      [
        "resource per-PID Hermes omission",
        (value) => delete value.probes.resources.samples[0].pidResults[0].hermesPorts,
      ],
      [
        "resource sample Hermes omission",
        (value) => delete value.probes.resources.samples[0].hermesPorts,
      ],
      ["resource top Hermes omission", (value) => delete value.probes.resources.hermesPorts],
      [
        "resource Hermes noninteger",
        (value) => (value.probes.resources.samples[0].pidResults[0].hermesPorts = [6110.5]),
      ],
      [
        "resource Hermes out of range",
        (value) => (value.probes.resources.samples[0].pidResults[0].hermesPorts = [6109]),
      ],
      [
        "resource Hermes duplicate",
        (value) => (value.probes.resources.samples[0].pidResults[0].hermesPorts = [6110, 6110]),
      ],
      [
        "resource Hermes unsorted",
        (value) => (value.probes.resources.samples[0].pidResults[0].hermesPorts = [6111, 6110]),
      ],
      [
        "resource coordinated Hermes forgery",
        (value) => {
          const sample = value.probes.resources.samples.find((candidate) =>
            candidate.pidResults.some((result) => result.observed),
          );
          const result = sample?.pidResults.find((candidate) => candidate.observed);
          if (sample && result) {
            result.hermesPorts = [6110];
            sample.hermesPorts = [6110];
            value.probes.resources.hermesPorts = [6110];
          } else {
            value.probes.resources.hermesPorts = [6110];
          }
        },
      ],
      [
        "resource top unavailable reason drift",
        (value) => {
          const unavailable = value.probes.resources.unavailablePids[0];
          if (unavailable) unavailable.reasons = ["forged reason"];
          else
            value.probes.resources.unavailablePids = [
              { pid: value.probes.resources.pids[0], reasons: ["forged reason"] },
            ];
        },
      ],
      [
        "resource all-dead fabricated zero",
        (value) => {
          const sample = value.probes.resources.samples[0];
          sample.observed = false;
          sample.fileDescriptors = 0;
          sample.sockets = 0;
          sample.listeners = 0;
        },
      ],
      [
        "provenance receipt digest drift",
        (value) => (value.provenance.receiptSha256 = "0".repeat(64)),
      ],
      [
        "provenance path reuse",
        (value) =>
          (value.provenance.path = `${primary.runId}/${primary.manifestStepId}.provenance.json`),
      ],
      ["provenance digest drift", (value) => (value.provenance.sha256 = "0".repeat(64))],
      [
        "provenance observation drift",
        (value) => (value.provenance.observationsSha256 = "0".repeat(64)),
      ],
    ];
    let authorityRejected = 0;
    for (const invalidOptions of [
      { step: measureStep, runnerSources: manifest.runner?.sources ?? [] },
      { primaryOutputRoot: primaryRoot, replayOutputRoot: replayRoot },
      { primaryOutputRoot: primaryRoot, replayOutputRoot: replayRoot, step: measureStep },
    ]) {
      try {
        compareReceipts(primary, replay, invalidOptions);
      } catch {
        authorityRejected += 1;
      }
    }
    assert(authorityRejected === 3, "root or manifest authority omission was accepted");
    let aliasRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: primaryRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      aliasRejected = true;
    }
    assert(aliasRejected, "aliased output roots were accepted");
    const replayEnvelopePath = join(replayRoot, replay.provenance.path);
    const replayEnvelopeBytes = readFileSync(replayEnvelopePath);
    rmSync(replayEnvelopePath);
    let missingEnvelopeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      missingEnvelopeRejected = true;
    }
    assert(missingEnvelopeRejected, "missing provenance envelope was accepted");
    writeFileSync(replayEnvelopePath, replayEnvelopeBytes);
    const primaryEnvelopeBytes = readFileSync(join(primaryRoot, primary.provenance.path));
    writeFileSync(replayEnvelopePath, primaryEnvelopeBytes);
    let substitutedEnvelopeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      substitutedEnvelopeRejected = true;
    }
    assert(substitutedEnvelopeRejected, "substituted provenance envelope was accepted");
    writeFileSync(replayEnvelopePath, replayEnvelopeBytes);
    const replayRunDirectory = join(replayRoot, replay.runId);
    const symlinkPath = join(replayRunDirectory, "symlink");
    symlinkSync(join(primaryRoot, primary.streams.stdout.path), symlinkPath);
    const symlinkForged = structuredClone(replay);
    symlinkForged.streams.stderr.path = `${replay.runId}/symlink`;
    symlinkForged.streams.stderr.bytes = primary.streams.stdout.bytes;
    symlinkForged.streams.stderr.sha256 = primary.streams.stdout.sha256;
    let symlinkRejected = false;
    try {
      compareReceipts(primary, symlinkForged, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      symlinkRejected = true;
    }
    assert(symlinkRejected, "symlink artifact alias was accepted");
    const hardlinkPath = join(replayRunDirectory, "hardlink");
    linkSync(join(primaryRoot, primary.streams.stdout.path), hardlinkPath);
    const hardlinkForged = structuredClone(replay);
    hardlinkForged.streams.stderr.path = `${replay.runId}/hardlink`;
    hardlinkForged.streams.stderr.bytes = primary.streams.stdout.bytes;
    hardlinkForged.streams.stderr.sha256 = primary.streams.stdout.sha256;
    let hardlinkRejected = false;
    try {
      compareReceipts(primary, hardlinkForged, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      hardlinkRejected = true;
    }
    assert(hardlinkRejected, "hard-linked artifact alias was accepted");
    const runtimePath = join(replayRoot, replay.runId, "measurement.json");
    const runtimeBytes = readFileSync(runtimePath);
    unlinkSync(runtimePath);
    symlinkSync(join(primaryRoot, primary.streams.stdout.path), runtimePath);
    let symlinkRuntimeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      symlinkRuntimeRejected = true;
    }
    assert(symlinkRuntimeRejected, "symlink runtime path alias was accepted");
    unlinkSync(runtimePath);
    linkSync(join(primaryRoot, primary.streams.stdout.path), runtimePath);
    let hardlinkRuntimeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: measureStep,
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      hardlinkRuntimeRejected = true;
    }
    assert(hardlinkRuntimeRejected, "hard-linked runtime path alias was accepted");
    unlinkSync(runtimePath);
    writeFileSync(runtimePath, runtimeBytes);
    let missingOutputRejected = 0;
    for (const [name, path] of [
      ["measurement output", runtimePath],
      ["benchmark copy", join(replayRoot, replay.runId, "benchmark-copy.sqlite")],
    ]) {
      const bytes = readFileSync(path);
      unlinkSync(path);
      let accepted = false;
      try {
        compareReceipts(primary, replay, {
          primaryOutputRoot: primaryRoot,
          replayOutputRoot: replayRoot,
          step: measureStep,
          runnerSources: manifest.runner?.sources ?? [],
        });
        accepted = true;
      } catch {}
      assert(!accepted, `${name} absence was accepted`);
      writeFileSync(path, bytes);
      missingOutputRejected += 1;
    }
    let rejected = 0;
    for (const [name, mutate] of attacks) {
      const forged = structuredClone(replay);
      mutate(forged);
      let accepted = false;
      try {
        compareReceipts(primary, forged, {
          primaryOutputRoot: primaryRoot,
          replayOutputRoot: replayRoot,
          step: measureStep,
          runnerSources: manifest.runner?.sources ?? [],
        });
        accepted = true;
      } catch {}
      const attackName = typeof name === "string" ? name : "unknown";
      assert(!accepted, `${attackName} attack was accepted`);
      rejected += 1;
    }
    rmSync(primaryRoot, { recursive: true, force: true });
    rmSync(replayRoot, { recursive: true, force: true });
    rmSync(replayCheckout, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        format: "agent-mail.executable-receipt/v2",
        accepted: true,
        attacks: rejected + authorityRejected + manifestRejected + missingOutputRejected + 4,
        comparison,
      }),
    );
  } finally {
    if (replayCheckout) rmSync(replayCheckout, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  assert(args.primary, "--primary receipt is required");
  assert(args.manifest, "--manifest is required");
  assert(args["primary-output-root"], "--primary-output-root is required");
  assert(args["output-root"], "--output-root is required");
  const primary = JSON.parse(readFileSync(resolve(args.primary), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  const stepId = args.step ?? primary.manifestStepId;
  const step = manifest.steps?.find((candidate) => candidate.id === stepId);
  assert(step, `manifest step ${stepId} is missing`);
  const primaryOutputRoot = canonicalOutputRoot(args["primary-output-root"], "primary");
  const replayOutputRoot = canonicalOutputRoot(args["output-root"], "replay");
  const receiptPath = assertSafeReceiptOutput(
    primary,
    resolve(args.primary),
    primaryOutputRoot,
    args.receipt,
    step,
  );
  const receipt = await capture({
    manifestPath: args.manifest,
    root: args.root ? resolve(args.root) : resolve(here, "../.."),
    outputRoot: resolve(args["output-root"]),
    role: "independent-replay",
    stepId,
  });
  const comparison = compareReceipts(primary, receipt, {
    primaryOutputRoot,
    replayOutputRoot,
    step,
    runnerSources: manifest.runner?.sources ?? [],
  });
  writeExclusiveReceipt(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
  console.log(JSON.stringify({ receiptPath, comparison }));
}

if (import.meta.main) await main();
