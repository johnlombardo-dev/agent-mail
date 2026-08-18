import { describe, expect, test } from "bun:test";
import { calculateRetryDecision, calculateRetryDelay } from "../src/retry-delay-policy";

const calculate = (retryAttempt: number, retryBaseMs: number, retryCapMs: number, retryJitterRatio: number, random: number) =>
  calculateRetryDelay({ retryAttempt, retryBaseMs, retryCapMs, retryJitterRatio, random: () => random });

describe("P3-C17 capped retry-delay policy", () => {
  test("keeps jittered delays within the configured bounds across attempts and configs", () => {
    for (const retryBaseMs of [1, 7, 1_000, Math.floor(Number.MAX_SAFE_INTEGER / 2)]) {
      for (const retryCapMs of [retryBaseMs, Number.MAX_SAFE_INTEGER]) {
        for (const retryJitterRatio of [0, 0.25, 1]) {
          for (const retryAttempt of [0, 1, 2, 8, Number.MAX_SAFE_INTEGER]) {
            const nominal = Math.min(retryCapMs, retryBaseMs * 2 ** Math.min(retryAttempt, 52));
            const minimum = nominal * (1 - retryJitterRatio);
            expect(calculate(retryAttempt, retryBaseMs, retryCapMs, retryJitterRatio, 0)).toBeGreaterThanOrEqual(minimum);
            expect(calculate(retryAttempt, retryBaseMs, retryCapMs, retryJitterRatio, 1)).toBeLessThanOrEqual(retryCapMs);
          }
        }
      }
    }
  });

  test("is deterministic and caps without numeric overflow at extreme attempts", () => {
    const input = { retryAttempt: Number.MAX_SAFE_INTEGER, retryBaseMs: 1, retryCapMs: Number.MAX_SAFE_INTEGER, retryJitterRatio: 1, random: () => 1 };
    const delay = calculateRetryDelay(input);
    expect(delay).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(calculateRetryDelay({ ...input, random: () => 1 }));
  });

  test("rejects invalid random/configuration values", () => {
    expect(() => calculate(0, 1, 1, 0, -0.01)).toThrow(RangeError);
    expect(() => calculate(0, 1, 1, 0, 1.01)).toThrow(RangeError);
    expect(() => calculate(0, 2, 1, 0, 0)).toThrow(RangeError);
    expect(() => calculate(0, 1, 1, 0, Number.NaN)).toThrow(RangeError);
  });

  test("maps every typed history to one decision and never samples random for non-transient history", () => {
    let randomCalls = 0;
    const input = {
      retryBaseMs: 10,
      retryCapMs: 100,
      retryJitterRatio: 0.5,
      random: () => {
        randomCalls += 1;
        return 0.5;
      },
    };
    const nonTransient = [
      ["success", 0],
      ["authentication-failure", 0],
      ["permanent-failure", 0],
      ["invariant-failure", 0],
    ] as const;
    for (const [kind, expectedAttempt] of nonTransient) {
      expect(calculateRetryDecision({ ...input, history: { kind } })).toEqual({
        retryable: false,
        delayMs: null,
        nextRetryAttempt: expectedAttempt,
        reason: kind,
      });
    }
    expect(randomCalls).toBe(0);

    expect(calculateRetryDecision({ ...input, history: { kind: "transient-failure", retryAttempt: 2 } })).toEqual({
      retryable: true,
      delayMs: 40,
      nextRetryAttempt: 3,
    });
    expect(randomCalls).toBe(1);

    const extreme = calculateRetryDecision({
      ...input,
      history: { kind: "transient-failure", retryAttempt: Number.MAX_SAFE_INTEGER },
    });
    expect(extreme.retryable).toBe(true);
    expect(extreme.nextRetryAttempt).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(extreme.nextRetryAttempt)).toBe(true);
  });
});
