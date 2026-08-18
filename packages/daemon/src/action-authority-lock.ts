import { chmod, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Ordered in-process authority linearization. Production callers place this
 * behind their owner-only file lock; the revision is rechecked immediately
 * before and after the SQLite mutation so revocation/key removal cannot race
 * a capability return.
 */
export class AuthorityLinearizationError extends Error {
  readonly code = "authority-revision-race" as const;
}

export type AuthorityLockCoordinator = Readonly<{
  readonly revision: () => number;
  readonly setRevision: (revision: number) => void;
  readonly run: <T>(expectedRevision: number, operation: () => T | Promise<T>) => Promise<T>;
}>;

export function createAuthorityLockCoordinator(initialRevision = 1): AuthorityLockCoordinator {
  let revision = initialRevision;
  let tail: Promise<void> = Promise.resolve();
  const run = async <T>(expectedRevision: number, operation: () => T | Promise<T>): Promise<T> => {
    let release: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = tail.then(() => acquired);
    await previous;
    try {
      if (revision !== expectedRevision)
        throw new AuthorityLinearizationError("authority configuration revision changed");
      const result = await operation();
      if (revision !== expectedRevision)
        throw new AuthorityLinearizationError(
          "authority configuration changed during authority admission",
        );
      return result;
    } finally {
      if (release !== undefined) release();
    }
  };
  return Object.freeze({
    revision: () => revision,
    setRevision: (next) => {
      if (!Number.isSafeInteger(next) || next < revision)
        throw new AuthorityLinearizationError("authority revision cannot move backwards");
      revision = next;
    },
    run,
  });
}

export type AuthorityFileLock = Readonly<{
  readonly runShared: <T>(operation: () => T | Promise<T>) => Promise<T>;
  readonly runExclusive: <T>(operation: () => T | Promise<T>) => Promise<T>;
}>;

type AdvisoryFlock = Readonly<{ readonly release: () => Promise<void> }>;

/**
 * Bun does not expose Darwin's flock(2) directly.  Keep the descriptor in a
 * tiny owner process so the advisory lock spans the whole async operation;
 * the marker protocol below remains the in-process/shared-reader admission
 * layer.  The helper is intentionally fail-closed when the platform helper
 * cannot be started.
 */
async function acquireAdvisoryFlock(lockPath: string, exclusive: boolean): Promise<AdvisoryFlock> {
  const helper = Bun.spawn(
    [
      "/usr/bin/perl",
      "-MFcntl=:DEFAULT",
      "-MFcntl=:flock",
      "-e",
      'sysopen(my $f,$ARGV[0],O_CREAT|O_RDWR|O_NOFOLLOW,0600) or die; flock($f,$ARGV[1] ? LOCK_EX : LOCK_SH) or die; $|=1; print "locked\\n"; while (<STDIN>) {}',
      lockPath,
      exclusive ? "1" : "0",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = helper.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      if (output.includes("\n")) break;
    }
    if (!output.startsWith("locked\n")) throw new Error("authority advisory lock helper failed");
  } catch (error: unknown) {
    helper.kill();
    await helper.exited;
    throw error;
  }
  return Object.freeze({
    release: async () => {
      await helper.stdin.end();
      await helper.exited;
    },
  });
}

/** Owner-only cross-process shared/exclusive lock used before SQLite BEGIN IMMEDIATE. */
export function createAuthorityFileLock(lockPath: string): AuthorityFileLock {
  if (lockPath.length === 0 || lockPath.includes("\0"))
    throw new TypeError("authority lock path is invalid");
  const directory = `${lockPath}.d`;
  const gatePath = join(directory, "gate");
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  const ensure = async () => {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const lockHandle = await open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await lockHandle.close();
    await chmod(lockPath, 0o600);
    const lockInfo = await lstat(lockPath);
    if (
      !lockInfo.isFile() ||
      lockInfo.isSymbolicLink() ||
      (lockInfo.mode & 0o777) !== 0o600 ||
      (owner !== undefined && lockInfo.uid !== owner)
    )
      throw new Error("authority lock file is unsafe");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (owner !== undefined && info.uid !== owner)
    )
      throw new Error("authority lock directory is unsafe");
  };
  const acquireGate = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    for (;;) {
      let gate: Awaited<ReturnType<typeof open>> | undefined;
      try {
        gate = await open(gatePath, "wx", 0o600);
        await gate.writeFile(`${process.pid}\n`, "utf8");
        await gate.sync();
        return gate;
      } catch (error: unknown) {
        await gate?.close().catch(() => undefined);
        const existing = await lstat(gatePath).catch(() => undefined);
        if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile()))
          throw new Error("authority lock gate is unsafe");
        let stale = false;
        try {
          const text = await readFile(gatePath, "utf8");
          const pid = Number.parseInt(text.trim(), 10);
          if (!Number.isSafeInteger(pid) || pid <= 0) stale = true;
          else {
            try {
              process.kill(pid, 0);
            } catch {
              stale = true;
            }
          }
        } catch {
          stale = true;
        }
        if (stale) {
          await unlink(gatePath).catch(() => undefined);
          continue;
        }
        void error;
        await wait(5);
      }
    }
  };
  const withShared = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    await ensure();
    const advisory = await acquireAdvisoryFlock(lockPath, false);
    const token = join(directory, `shared-${process.pid}-${randomUUID()}`);
    // The gate closes the check/create race between readers and writers. A
    // writer owns the gate while publishing its marker; a reader owns it
    // while publishing its reader marker, then readers may run together.
    let gate: Awaited<ReturnType<typeof open>> | undefined;
    try {
      gate = await acquireGate();
    } catch (error: unknown) {
      await advisory.release();
      throw error;
    }
    try {
      if ((await readdir(directory)).some((entry) => entry.startsWith("exclusive-"))) {
        await gate.close();
        await unlink(gatePath).catch(() => undefined);
        gate = undefined;
        await advisory.release();
        return withShared(operation);
      }
      const handle = await open(token, "wx", 0o600);
      await handle.close();
      await gate.close();
      await unlink(gatePath);
      gate = undefined;
    } catch (error: unknown) {
      await gate?.close().catch(() => undefined);
      await unlink(gatePath).catch(() => undefined);
      await advisory.release();
      throw error;
    }
    try {
      return await operation();
    } finally {
      await unlink(token).catch(() => undefined);
      await advisory.release();
    }
  };
  const withExclusive = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    await ensure();
    const advisory = await acquireAdvisoryFlock(lockPath, true);
    const token = join(directory, `exclusive-${process.pid}-${randomUUID()}`);
    let gate: Awaited<ReturnType<typeof open>> | undefined;
    try {
      gate = await acquireGate();
    } catch (error: unknown) {
      await advisory.release();
      throw error;
    }
    try {
      const handle = await open(token, "wx", 0o600);
      await handle.close();
      await gate.close();
      await unlink(gatePath);
      gate = undefined;
    } catch (error: unknown) {
      await gate?.close().catch(() => undefined);
      await unlink(gatePath).catch(() => undefined);
      await advisory.release();
      throw error;
    }
    try {
      while ((await readdir(directory)).some((entry) => entry.startsWith("shared-"))) await wait(5);
      return await operation();
    } finally {
      await unlink(token).catch(() => undefined);
      await advisory.release();
    }
  };
  return Object.freeze({ runShared: withShared, runExclusive: withExclusive });
}
