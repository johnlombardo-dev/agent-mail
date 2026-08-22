import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type SourceTokenEvent = Readonly<{
  readonly format: "agent-mail.observation/v1";
  readonly event: "source-token";
  readonly assertionId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly token: string;
  readonly observed: number;
  readonly expected: number;
  readonly pass: boolean;
}>;

const emittedAssertions = new Set<string>();

export function composeSourceToken(parts: readonly string[], separator = " "): string {
  if (parts.length === 0 || parts.some((part) => part.length === 0))
    throw new TypeError("source-token fragments must be non-empty");
  return parts.join(separator);
}

function countOccurrences(source: string, token: string): number {
  let observed = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(token, offset);
    if (index < 0) return observed;
    observed += 1;
    offset = index + token.length;
  }
}

export async function emitSourceTokenEvent(
  input: Readonly<{
    readonly assertionId: string;
    readonly sourcePath: string;
    readonly token: string;
    readonly expected: number;
  }>,
): Promise<SourceTokenEvent> {
  if (emittedAssertions.has(input.assertionId))
    throw new Error(`duplicate source-token assertion: ${input.assertionId}`);
  if (!Number.isSafeInteger(input.expected) || input.expected < 0)
    throw new TypeError("source-token expected count must be a non-negative safe integer");
  if (isAbsolute(input.sourcePath) || input.sourcePath.includes("\\"))
    throw new TypeError("source-token source path must be candidate-relative");

  const candidateRoot = resolve(process.cwd());
  const sourceAbsolute = resolve(candidateRoot, input.sourcePath);
  if (relative(candidateRoot, sourceAbsolute) !== input.sourcePath)
    throw new TypeError("source-token source path escapes candidate");
  if (input.token.length === 0) throw new TypeError("source-token token must be non-empty");

  const bytes = await readFile(sourceAbsolute);
  const source = new TextDecoder().decode(bytes);
  const observed = countOccurrences(source, input.token);
  const event: SourceTokenEvent = Object.freeze({
    format: "agent-mail.observation/v1",
    event: "source-token",
    assertionId: input.assertionId,
    sourcePath: input.sourcePath,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    token: input.token,
    observed,
    expected: input.expected,
    pass: observed === input.expected,
  });
  emittedAssertions.add(input.assertionId);
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}
