import {
  CORPUS_VERSION,
  DEFAULT_REFERENCE_SIZE,
  MAX_GENERATED_SIZE,
  scenarioCategories,
  type CorpusOptions,
  type ScenarioCategory,
  type ScenarioMix,
} from "./types";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  return value;
}

function parseString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  return value;
}

function isScenarioCategory(value: string): value is ScenarioCategory {
  return scenarioCategories.some((category) => category === value);
}

function parseMix(value: unknown): ScenarioMix {
  if (value === undefined) return Object.freeze({});
  if (Array.isArray(value)) {
    if (value.length === 0) throw new TypeError("scenarioMix list must select a category");
    const result: Partial<Record<ScenarioCategory, number>> = {};
    for (const item of value) {
      if (typeof item !== "string" || !isScenarioCategory(item))
        throw new TypeError("scenarioMix list contains an unknown category");
      result[item] = (result[item] ?? 0) + 1;
    }
    return Object.freeze(result);
  }
  if (!isRecord(value)) throw new TypeError("scenarioMix must be an object");
  const result: Partial<Record<ScenarioCategory, number>> = {};
  for (const key of Object.keys(value)) {
    if (!isScenarioCategory(key)) throw new TypeError(`scenarioMix has unknown category ${key}`);
    const weight = value[key];
    if (typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 0)
      throw new TypeError(`scenarioMix weight for ${key} must be a non-negative integer`);
    result[key] = weight;
  }
  if (Object.values(result).every((weight) => weight === 0))
    throw new TypeError("scenarioMix must select a category");
  const normalized: Partial<Record<ScenarioCategory, number>> = {};
  for (const category of scenarioCategories) {
    const weight = result[category];
    if (weight !== undefined) normalized[category] = weight;
  }
  return Object.freeze(normalized);
}

/** Parse the untrusted execution boundary once; generation then consumes this typed value. */
export function parseCorpusOptions(input: unknown): CorpusOptions {
  if (!isRecord(input)) throw new TypeError("corpus options must be an object");
  const scenarioVersion = parseString(input.scenarioVersion ?? CORPUS_VERSION, "scenarioVersion");
  const seed = parseString(input.seed ?? "reference", "seed");
  const size = parsePositiveInteger(
    input.size ?? DEFAULT_REFERENCE_SIZE,
    "size",
    MAX_GENERATED_SIZE,
  );
  const scenarioMix = parseMix(input.scenarioMix);
  const context: { root?: string; locale?: string; timezone?: string; wallClock?: string } = {};
  for (const key of ["root", "locale", "timezone", "wallClock"] as const) {
    const value = input[key];
    if (value !== undefined) context[key] = parseString(value, key);
  }
  return Object.freeze({ scenarioVersion, seed, size, scenarioMix, ...context });
}
