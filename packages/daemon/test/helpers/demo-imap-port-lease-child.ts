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
if (directory === undefined || (mode !== "hold" && mode !== "crash")) {
  throw new Error("child requires lease directory and hold/crash mode");
}

const lease = leaseDemoImapTestPort({ directory, preferredPort: port });
console.log(JSON.stringify({ kind: "acquired", pid: process.pid, port: lease.port }));

if (mode === "crash") process.exit(73);
await new Promise<never>(() => undefined);
