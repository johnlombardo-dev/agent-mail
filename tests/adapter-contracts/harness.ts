/**
 * Private, test-only adapter contract runner.
 *
 * The `production` label is supplied by the caller. It identifies which
 * evidence slot a run belongs to; it does not turn an in-memory fixture into
 * live-provider evidence.
 */

export type AdapterKind = "fake" | "production";

export type CapabilityMetadata =
  | {
      readonly name: string;
      readonly status: "available";
    }
  | {
      readonly name: string;
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface AdapterContractCase<TAdapter> {
  readonly id: string;
  readonly requires?: readonly string[];
  readonly productionRequired?: boolean;
  readonly run: (adapter: TAdapter) => void | Promise<void>;
}

export interface AdapterContractSuite<TAdapter> {
  readonly name: string;
  readonly cases: readonly AdapterContractCase<TAdapter>[];
}

export interface AdapterFactoryInput<TAdapter> {
  readonly factory: () => TAdapter | Promise<TAdapter>;
  readonly kind: AdapterKind;
  readonly capabilities: readonly CapabilityMetadata[];
  readonly retainedEvidencePath?: string;
}

export interface CaseFailure {
  readonly name: string;
  readonly message: string;
}

export type ObservedCaseOutcome = "passed" | "failed" | "skipped";

export type AdapterCaseResult =
  | {
      readonly kind: "passed";
      readonly caseId: string;
    }
  | {
      readonly kind: "failed";
      readonly caseId: string;
      readonly failure: CaseFailure;
    }
  | {
      readonly kind: "skipped";
      readonly caseId: string;
      readonly missingCapabilities: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: "production-gap";
      readonly caseId: string;
      readonly observed: "passed";
      readonly reason: string;
    }
  | {
      readonly kind: "production-gap";
      readonly caseId: string;
      readonly observed: "failed";
      readonly failure: CaseFailure;
      readonly reason: string;
    }
  | {
      readonly kind: "production-gap";
      readonly caseId: string;
      readonly observed: "skipped";
      readonly missingCapabilities: readonly string[];
      readonly reason: string;
    };

export interface SkippedCapabilityEvidence {
  readonly caseId: string;
  readonly capabilities: readonly string[];
  readonly reason: string;
}

export interface ProductionRequiredGap {
  readonly caseId: string;
  readonly reason: string;
  readonly observed: ObservedCaseOutcome;
}

export type AdapterRunStatus = "passed" | "failed" | "incomplete" | "empty";

export interface AdapterContractEvidence {
  readonly suiteName: string;
  readonly adapterKind: AdapterKind;
  readonly status: AdapterRunStatus;
  readonly retainedEvidencePath?: string;
  readonly executedCases: readonly string[];
  readonly passedCases: readonly string[];
  readonly failedCases: readonly string[];
  readonly skippedCases: readonly string[];
  readonly skippedCapabilities: readonly SkippedCapabilityEvidence[];
  readonly productionRequiredGaps: readonly ProductionRequiredGap[];
  readonly caseResults: readonly AdapterCaseResult[];
  readonly factoryFailure?: CaseFailure;
}

export type ProductionEvidence =
  | {
      readonly status: "available";
      readonly adapterKind: "production";
      readonly result: AdapterContractEvidence;
    }
  | {
      readonly status: "gap";
      readonly adapterKind: "production";
      readonly reason: "production-factory-not-provided";
    };

export type SemanticParityStatus = "matched" | "mismatched" | "not-established";

export interface SemanticParityDifference {
  readonly caseId: string;
  readonly fake: ObservedCaseOutcome | "not-executed";
  readonly production: ObservedCaseOutcome | "not-executed";
}

export interface SemanticParityEvidence {
  readonly status: SemanticParityStatus;
  readonly comparedCases: readonly string[];
  readonly differences: readonly SemanticParityDifference[];
  readonly reason?: "production-factory-not-provided" | "empty-suite" | "adapter-factory-failed";
}

export interface AdapterContractParityEvidence {
  readonly suiteName: string;
  readonly fake: AdapterContractEvidence;
  readonly production: AdapterContractEvidence | null;
  readonly productionEvidence: ProductionEvidence;
  readonly semanticParity: SemanticParityEvidence;
}

export interface AdapterContractRunOptions<TAdapter> extends AdapterFactoryInput<TAdapter> {
  readonly suite: AdapterContractSuite<TAdapter>;
}

export interface AdapterContractParityOptions<TAdapter> {
  readonly suite: AdapterContractSuite<TAdapter>;
  readonly fake: Omit<AdapterFactoryInput<TAdapter>, "kind">;
  readonly production?: Omit<AdapterFactoryInput<TAdapter>, "kind">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeFailure(value: unknown): CaseFailure {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (typeof value === "string") {
    return { name: "ThrownValue", message: value };
  }

  if (isRecord(value)) {
    const name = typeof value.name === "string" ? value.name : "ThrownValue";
    const message =
      typeof value.message === "string" ? value.message : "The case threw a non-Error value.";
    return { name, message };
  }

  return { name: "ThrownValue", message: "The case threw a non-Error value." };
}

function validateSuite<TAdapter>(suite: AdapterContractSuite<TAdapter>): void {
  if (suite.name.trim() === "") {
    throw new Error("Adapter contract suites need a non-empty name.");
  }

  const seen = new Set<string>();
  for (const contractCase of suite.cases) {
    if (contractCase.id.trim() === "") {
      throw new Error("Adapter contract cases need non-empty ids.");
    }
    if (seen.has(contractCase.id)) {
      throw new Error(`Adapter contract case id is duplicated: ${contractCase.id}`);
    }
    seen.add(contractCase.id);
  }
}

function validateFactoryInput<TAdapter>(input: AdapterFactoryInput<TAdapter>): void {
  if (input.retainedEvidencePath !== undefined && input.retainedEvidencePath.trim() === "") {
    throw new Error("A retained evidence path must be non-empty when supplied.");
  }

  const seen = new Set<string>();
  for (const capability of input.capabilities) {
    if (capability.name.trim() === "") {
      throw new Error("Adapter capabilities need non-empty names.");
    }
    if (seen.has(capability.name)) {
      throw new Error(`Adapter capability is duplicated: ${capability.name}`);
    }
    seen.add(capability.name);
    if (capability.status === "unavailable" && capability.reason.trim() === "") {
      throw new Error(`Unavailable capability needs a reason: ${capability.name}`);
    }
  }
}

function capabilityState(
  capabilities: readonly CapabilityMetadata[],
  name: string,
): CapabilityMetadata | undefined {
  return capabilities.find((capability) => capability.name === name);
}

function observedOutcome(result: AdapterCaseResult): ObservedCaseOutcome {
  switch (result.kind) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "production-gap":
      return result.observed;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function resultForCase(
  results: readonly AdapterCaseResult[],
  caseId: string,
): AdapterCaseResult | undefined {
  return results.find((result) => result.caseId === caseId);
}

function runStatus(
  caseCount: number,
  results: readonly AdapterCaseResult[],
  factoryFailure: CaseFailure | undefined,
): AdapterRunStatus {
  if (
    factoryFailure !== undefined ||
    results.some((result) => observedOutcome(result) === "failed")
  ) {
    return "failed";
  }
  if (caseCount === 0) {
    return "empty";
  }
  if (
    results.some((result) => result.kind === "production-gap") ||
    !results.some((result) => observedOutcome(result) === "passed")
  ) {
    return "incomplete";
  }
  return "passed";
}

export async function runAdapterContract<TAdapter>(
  options: AdapterContractRunOptions<TAdapter>,
): Promise<AdapterContractEvidence> {
  validateSuite(options.suite);
  validateFactoryInput(options);

  const executedCases: string[] = [];
  const passedCases: string[] = [];
  const failedCases: string[] = [];
  const skippedCases: string[] = [];
  const skippedCapabilities: SkippedCapabilityEvidence[] = [];
  const productionRequiredGaps: ProductionRequiredGap[] = [];
  const caseResults: AdapterCaseResult[] = [];

  let adapter: TAdapter;
  try {
    adapter = await options.factory();
  } catch (error: unknown) {
    const factoryFailure = describeFailure(error);
    return {
      suiteName: options.suite.name,
      adapterKind: options.kind,
      status: "failed",
      retainedEvidencePath: options.retainedEvidencePath,
      executedCases,
      passedCases,
      failedCases,
      skippedCases,
      skippedCapabilities,
      productionRequiredGaps,
      caseResults,
      factoryFailure,
    };
  }

  for (const contractCase of options.suite.cases) {
    const required = contractCase.requires ?? [];
    const missing = required.flatMap((name) => {
      const state = capabilityState(options.capabilities, name);
      if (state?.status === "available") {
        return [];
      }
      return [name];
    });

    if (missing.length > 0) {
      const reasons = missing.map((name) => {
        const state = capabilityState(options.capabilities, name);
        if (state?.status === "unavailable") {
          return `${name}: ${state.reason}`;
        }
        return `${name}: capability was not declared`;
      });
      const reason = reasons.join("; ");
      skippedCapabilities.push({ caseId: contractCase.id, capabilities: missing, reason });
      skippedCases.push(contractCase.id);

      if (contractCase.productionRequired === true) {
        const result: AdapterCaseResult = {
          kind: "production-gap",
          caseId: contractCase.id,
          observed: "skipped",
          missingCapabilities: missing,
          reason: `Production-required case was skipped: ${reason}`,
        };
        caseResults.push(result);
        productionRequiredGaps.push({
          caseId: contractCase.id,
          observed: "skipped",
          reason: result.reason,
        });
      } else {
        caseResults.push({
          kind: "skipped",
          caseId: contractCase.id,
          missingCapabilities: missing,
          reason,
        });
      }
      continue;
    }

    executedCases.push(contractCase.id);
    try {
      await contractCase.run(adapter);
      if (contractCase.productionRequired === true && options.kind === "fake") {
        const result: AdapterCaseResult = {
          kind: "production-gap",
          caseId: contractCase.id,
          observed: "passed",
          reason: "A fake adapter cannot satisfy production-required evidence.",
        };
        caseResults.push(result);
        productionRequiredGaps.push({
          caseId: contractCase.id,
          observed: "passed",
          reason: result.reason,
        });
      } else {
        caseResults.push({ kind: "passed", caseId: contractCase.id });
        passedCases.push(contractCase.id);
      }
    } catch (error: unknown) {
      const failure = describeFailure(error);
      failedCases.push(contractCase.id);
      if (contractCase.productionRequired === true && options.kind === "fake") {
        const result: AdapterCaseResult = {
          kind: "production-gap",
          caseId: contractCase.id,
          observed: "failed",
          failure,
          reason: "A fake adapter cannot satisfy production-required evidence.",
        };
        caseResults.push(result);
        productionRequiredGaps.push({
          caseId: contractCase.id,
          observed: "failed",
          reason: result.reason,
        });
      } else {
        caseResults.push({ kind: "failed", caseId: contractCase.id, failure });
      }
    }
  }

  return {
    suiteName: options.suite.name,
    adapterKind: options.kind,
    status: runStatus(options.suite.cases.length, caseResults, undefined),
    retainedEvidencePath: options.retainedEvidencePath,
    executedCases,
    passedCases,
    failedCases,
    skippedCases,
    skippedCapabilities,
    productionRequiredGaps,
    caseResults,
  };
}

function semanticParity(
  caseIds: readonly string[],
  fake: AdapterContractEvidence,
  production: AdapterContractEvidence | null,
): SemanticParityEvidence {
  if (production === null) {
    return {
      status: "not-established",
      comparedCases: [],
      differences: [],
      reason: "production-factory-not-provided",
    };
  }
  if (caseIds.length === 0) {
    return { status: "not-established", comparedCases: [], differences: [], reason: "empty-suite" };
  }
  if (fake.factoryFailure !== undefined || production.factoryFailure !== undefined) {
    return {
      status: "not-established",
      comparedCases: [],
      differences: [],
      reason: "adapter-factory-failed",
    };
  }

  const comparedCases: string[] = [];
  const differences: SemanticParityDifference[] = [];
  for (const caseId of caseIds) {
    const fakeResult = resultForCase(fake.caseResults, caseId);
    const productionResult = resultForCase(production.caseResults, caseId);
    if (fakeResult !== undefined && productionResult !== undefined) {
      comparedCases.push(caseId);
    }
    const fakeOutcome = fakeResult === undefined ? "not-executed" : observedOutcome(fakeResult);
    const productionOutcome =
      productionResult === undefined ? "not-executed" : observedOutcome(productionResult);
    if (fakeOutcome !== productionOutcome) {
      differences.push({ caseId, fake: fakeOutcome, production: productionOutcome });
    }
  }
  return {
    status: differences.length === 0 ? "matched" : "mismatched",
    comparedCases,
    differences,
  };
}

export async function runAdapterContractParity<TAdapter>(
  options: AdapterContractParityOptions<TAdapter>,
): Promise<AdapterContractParityEvidence> {
  const fake = await runAdapterContract({ ...options.fake, kind: "fake", suite: options.suite });
  const production =
    options.production === undefined
      ? null
      : await runAdapterContract({
          ...options.production,
          kind: "production",
          suite: options.suite,
        });

  const productionEvidence: ProductionEvidence =
    production === null
      ? {
          status: "gap",
          adapterKind: "production",
          reason: "production-factory-not-provided",
        }
      : {
          status: "available",
          adapterKind: "production",
          result: production,
        };

  return {
    suiteName: options.suite.name,
    fake,
    production,
    productionEvidence,
    semanticParity: semanticParity(
      options.suite.cases.map((contractCase) => contractCase.id),
      fake,
      production,
    ),
  };
}

/** Descriptive alias for callers that prefer the plural harness name. */
export const runAdapterContracts = runAdapterContractParity;
