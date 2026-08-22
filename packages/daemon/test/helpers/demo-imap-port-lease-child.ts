import {
  leaseDemoImapTestPort,
  type DemoImapTestPort,
} from "../../src/demo/imap";

function testPort(value: string | undefined): DemoImapTestPort {
  if (value === "6112") return 6112;
  if (value === "6113") return 6113;
  if (value === "6114") return 6114;
  throw new Error("child requires a Hermes demo IMAP test port");
}

const directory = process.argv[2];
const port = testPort(process.argv[3]);
const mode = process.argv[4];
if (
  directory === undefined ||
  (mode !== "hold" && mode !== "crash" && mode !== "worker")
) {
  throw new Error("child requires lease directory and hold/crash/worker mode");
}

if (mode === "worker") {
  const worker = process.argv[5];
  if (worker === undefined || !/^\d{1,2}$/u.test(worker)) {
    throw new Error("lease worker requires a bounded worker number");
  }
  let held: ReturnType<typeof leaseDemoImapTestPort> | null = null;
  let commandQueue = Promise.resolve();
  process.on("message", (message: unknown) => {
    commandQueue = commandQueue.then(async () => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        process.send?.({ kind: "error", worker, detail: "invalid worker command" });
        return;
      }
      const kind = Reflect.get(message, "kind");
      const round = Reflect.get(message, "round");
      if (!Number.isSafeInteger(round) || typeof round !== "number" || round < 0 || round > 100) {
        process.send?.({ kind: "error", worker, detail: "invalid worker round" });
        return;
      }
      if (kind === "contend") {
        if (held !== null) {
          process.send?.({ kind: "error", worker, detail: "worker already owns a lease" });
          return;
        }
        try {
          held = leaseDemoImapTestPort({ directory, preferredPort: port });
          process.send?.({ kind: "result", worker, round, acquired: true, pid: process.pid });
        } catch (error: unknown) {
          if (!(error instanceof Error) || !error.message.endsWith("is leased")) {
            process.send?.({
              kind: "error",
              worker,
              detail: error instanceof Error ? error.message : "unknown lease error",
            });
            return;
          }
          process.send?.({ kind: "result", worker, round, acquired: false, pid: process.pid });
        }
        return;
      }
      if (kind === "release") {
        held?.release();
        held = null;
        process.send?.({ kind: "released", worker, round });
        return;
      }
      process.send?.({ kind: "error", worker, detail: "unknown worker command" });
    });
  });
  process.send?.({ kind: "ready", worker });
  await new Promise<never>(() => undefined);
}

const lease = leaseDemoImapTestPort({ directory, preferredPort: port });
console.log(JSON.stringify({ kind: "acquired", pid: process.pid, port: lease.port }));

if (mode === "crash") process.exit(73);
await new Promise<never>(() => undefined);
