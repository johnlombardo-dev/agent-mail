import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const AVAILABLE =
  /<!--\s*readme-transcript:available\s*-->\s*\n```(?:sh|shell|bash)\s*\n([\s\S]*?)\n```/g;
const FORBIDDEN = [
  /\bbun\s+run\s+sync\b/u,
  /\blaunchctl\b/u,
  /\btailscale\b/u,
  /\bimap(flow)?\b/u,
  /\b(expunge|delete-and-expunge)\b/u,
];

function fail(message: string): never {
  console.error(`README transcript check failed: ${message}`);
  process.exit(1);
}

function commandsFrom(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
}

async function main(): Promise<void> {
  const readmePath = resolve(process.argv[2] ?? "README.md");
  const readme = await readFile(readmePath, "utf8");
  const blocks = [...readme.matchAll(AVAILABLE)].map((match) => commandsFrom(match[1]));
  if (blocks.length === 0) fail("no explicitly marked available command blocks found");

  const transcript = blocks.join("\n");
  for (const pattern of FORBIDDEN) {
    if (pattern.test(transcript)) fail(`planned or side-effectful command matches ${pattern}`);
  }

  const root = resolve(readmePath, "..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-mail-readme-"));
  try {
    const checkout = join(temporaryRoot, "checkout");
    await mkdir(checkout);
    const archive = spawnSync("git", ["archive", "HEAD"], { cwd: root, encoding: "buffer" });
    if (archive.status !== 0 || archive.error !== undefined) {
      fail(`git archive HEAD failed${archive.error ? `: ${archive.error.message}` : ""}`);
    }
    const extract = spawnSync("tar", ["-x", "-C", checkout], {
      cwd: root,
      input: archive.stdout,
      encoding: "buffer",
    });
    if (extract.status !== 0 || extract.error !== undefined)
      fail("clean checkout extraction failed");
    await writeFile(join(checkout, "README.md"), readme);

    const environment = {
      PATH: process.env.PATH ?? "",
      HOME: join(temporaryRoot, "home"),
      CI: "1",
    };
    await mkdir(environment.HOME);
    for (const [index, command] of blocks.entries()) {
      const result = spawnSync("sh", ["-c", `set -eu\n${command}`], {
        cwd: checkout,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        process.stderr.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        fail(`available block ${index + 1} exited with ${result.status ?? "a signal"}`);
      }
      console.log(`available block ${index + 1}: exit 0`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
