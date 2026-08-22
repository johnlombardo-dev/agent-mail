import {
  CORPUS_VERSION,
  MAX_GENERATED_SIZE,
  scenarioCategories,
  type CorpusOptions,
  type ScenarioCategory,
  type ScenarioMix,
} from "./types";

export type CorpusOptionErrorCode =
  | "options-not-object"
  | "unknown-key"
  | "missing-field"
  | "invalid-field"
  | "unsupported-version";

export class CorpusOptionsError extends TypeError {
  readonly code: CorpusOptionErrorCode;

  constructor(code: CorpusOptionErrorCode, message: string) {
    super(message);
    this.name = "CorpusOptionsError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new CorpusOptionsError(
      "invalid-field",
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  return value;
}

function parseString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new CorpusOptionsError("invalid-field", `${name} must be a non-empty trimmed string`);
  return value;
}

function isScenarioCategory(value: string): value is ScenarioCategory {
  return scenarioCategories.some((category) => category === value);
}

function parseMix(value: unknown): ScenarioMix {
  if (value === undefined) throw new CorpusOptionsError("missing-field", "scenarioMix is required");
  if (Array.isArray(value)) {
    if (value.length === 0)
      throw new CorpusOptionsError("invalid-field", "scenarioMix list must select a category");
    const result: Partial<Record<ScenarioCategory, number>> = {};
    for (const item of value) {
      if (typeof item !== "string" || !isScenarioCategory(item))
        throw new CorpusOptionsError(
          "invalid-field",
          "scenarioMix list contains an unknown category",
        );
      result[item] = (result[item] ?? 0) + 1;
    }
    return Object.freeze(result);
  }
  if (!isRecord(value))
    throw new CorpusOptionsError("invalid-field", "scenarioMix must be an object");
  const result: Partial<Record<ScenarioCategory, number>> = {};
  for (const key of Object.keys(value)) {
    if (!isScenarioCategory(key))
      throw new CorpusOptionsError("invalid-field", `scenarioMix has unknown category ${key}`);
    const weight = value[key];
    if (typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 0)
      throw new CorpusOptionsError(
        "invalid-field",
        `scenarioMix weight for ${key} must be a non-negative integer`,
      );
    result[key] = weight;
  }
  if (Object.values(result).every((weight) => weight === 0))
    throw new CorpusOptionsError("invalid-field", "scenarioMix must select a category");
  const normalized: Partial<Record<ScenarioCategory, number>> = {};
  for (const category of scenarioCategories) {
    const weight = result[category];
    if (weight !== undefined) normalized[category] = weight;
  }
  return Object.freeze(normalized);
}

/** Parse the untrusted execution boundary once; generation then consumes this typed value. */
export function parseCorpusOptions(input: unknown): CorpusOptions {
  if (!isRecord(input))
    throw new CorpusOptionsError("options-not-object", "corpus options must be an object");
  const allowedKeys = new Set([
    "scenarioVersion",
    "seed",
    "size",
    "scenarioMix",
    "root",
    "locale",
    "timezone",
    "wallClock",
  ]);
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined)
    throw new CorpusOptionsError("unknown-key", `unknown corpus option ${unknownKey}`);
  if (!Object.hasOwn(input, "scenarioVersion"))
    throw new CorpusOptionsError("missing-field", "scenarioVersion is required");
  if (!Object.hasOwn(input, "seed"))
    throw new CorpusOptionsError("missing-field", "seed is required");
  if (!Object.hasOwn(input, "size"))
    throw new CorpusOptionsError("missing-field", "size is required");
  const scenarioVersion = parseString(input.scenarioVersion, "scenarioVersion");
  if (scenarioVersion !== CORPUS_VERSION)
    throw new CorpusOptionsError(
      "unsupported-version",
      `unsupported scenarioVersion ${scenarioVersion}`,
    );
  const seed = parseString(input.seed, "seed");
  const size = parsePositiveInteger(input.size, "size", MAX_GENERATED_SIZE);
  const scenarioMix = parseMix(input.scenarioMix);
  const context: { root?: string; locale?: string; timezone?: string; wallClock?: string } = {};
  for (const key of ["root", "locale", "timezone", "wallClock"] as const) {
    const value = input[key];
    if (value !== undefined) context[key] = parseString(value, key);
  }
  return Object.freeze({ scenarioVersion, seed, size, scenarioMix, ...context });
}
