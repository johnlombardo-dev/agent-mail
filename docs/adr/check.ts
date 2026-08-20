#!/usr/bin/env bun
/** Focused ADR documentation checks; run with `bun docs/adr/check.ts`. */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? import.meta.dir);
const files = (await readdir(root)).filter((file) => file.endsWith(".md")).sort();
const errors: string[] = [];
const ids = new Map<string, string>();
const acceptedDecisions = new Map<string, string>();
const statuses = new Set(["Accepted", "Deferred", "Evidence-only", "Superseded"]);
const index = await Bun.file(join(root, "README.md")).text();
const indexed = new Map<string, string>();
for (const match of index.matchAll(
  /^\| (ADR-\d+) \|.*\| (Accepted|Deferred|Evidence-only|Superseded) \|/gm,
)) {
  const [, id, status] = match;
  if (indexed.has(id)) errors.push(`README.md: duplicate index row ${id}`);
  indexed.set(id, status);
}

for (const file of files) {
  const path = join(root, file);
  const text = await Bun.file(path).text();
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target.startsWith("http") || target.startsWith("#")) continue;
    const targetPath = resolve(root, target);
    if (!(await Bun.file(targetPath).exists())) errors.push(`${file}: broken link ${target}`);
  }
  if (file === "README.md") continue;
  const id = text.match(/^# (ADR-\d+):/m)?.[1];
  const status = text.match(/^- Status: ([^\n]+)/m)?.[1];
  const owner = text.match(/^- Owner: ([^\n]+)/m)?.[1];
  const decision = text.match(/^- Decision: ([^\n]+)/m)?.[1];
  if (!id || !status || !owner || !decision)
    errors.push(`${file}: missing ADR ID/status/owner/decision`);
  if (id && file !== `${id}.md`) errors.push(`${file}: filename does not match ${id}`);
  if (id && !indexed.has(id)) errors.push(`${file}: ADR is not indexed`);
  if (id && indexed.get(id) !== status)
    errors.push(
      `${file}: index status ${indexed.get(id) ?? "missing"} disagrees with record status ${status ?? "missing"}`,
    );
  if (id) {
    if (ids.has(id)) errors.push(`${file}: duplicate ADR ID ${id}`);
    ids.set(id, file);
  }
  if (status && !statuses.has(status)) errors.push(`${file}: invalid status ${status}`);
  if (status === "Accepted" && decision) {
    const key = decision.toLowerCase().replace(/\s+/g, " ");
    if (acceptedDecisions.has(key))
      errors.push(`${file}: duplicate Accepted decision also in ${acceptedDecisions.get(key)}`);
    acceptedDecisions.set(key, file);
  }
  for (const line of text.split("\n")) {
    if (
      /(?:agent-mail-(?:sol|sol-luna)|agent-mail-proto|\/Volumes\/Jove\/Developer\/Projects\/agent-mail-sol-luna)/.test(
        line,
      ) &&
      !/evidence-only/i.test(line)
    ) {
      errors.push(`${file}: prototype path/identity presented without evidence-only label`);
    }
  }
}
for (const [id] of indexed)
  if (!ids.has(id)) errors.push(`README.md: indexed ADR ${id} has no record`);
if (!ids.has("ADR-001")) errors.push("missing ADR-001");
if (errors.length) {
  console.error(errors.map((error) => `FAIL ${error}`).join("\n"));
  process.exit(1);
}
console.log(
  `PASS ${files.length} markdown files; ${ids.size} unique ADR IDs; links, statuses, and evidence labels valid`,
);
