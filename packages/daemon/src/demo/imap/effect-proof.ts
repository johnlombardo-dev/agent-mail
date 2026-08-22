import type { RemoteEffectLocalWriteResult } from "./types";

/**
 * Prove the remote/local split used by the demo without misreporting a completed
 * remote mutation as absent when the following local result write fails.
 */
export async function runRemoteEffectThenLocalWrite<T>(
  input: Readonly<{
    readonly remoteEffect: () => Promise<T>;
    readonly writeLocalResult: (result: T) => Promise<void>;
  }>,
): Promise<RemoteEffectLocalWriteResult<T>> {
  const remoteResult = await input.remoteEffect();
  try {
    await input.writeLocalResult(remoteResult);
    return Object.freeze({ kind: "persisted", remoteResult });
  } catch {
    const result: RemoteEffectLocalWriteResult<T> = {
      kind: "local-write-failed",
      remoteResult,
      safeMessage: "Remote effect completed, but the local result write failed.",
    };
    return Object.freeze(result);
  }
}
