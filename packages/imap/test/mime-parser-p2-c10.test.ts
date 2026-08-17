import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  parseStagedEml,
  safeParseStagedEml,
  type MimeStreamPart,
} from "../src/mime-parser";

const temporaryDirectories: string[] = [];

async function fixture(name: string, value: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, value, { mode: 0o600 });
  return path;
}

async function consume(part: MimeStreamPart): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of part.content) {
    if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
    else throw new TypeError("part stream emitted a non-byte chunk");
  }
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("staged MIME parser", () => {
  test("normalizes ordered headers and addresses while streaming attachment parts", async () => {
    const path = await fixture(
      "multipart.eml",
      [
        "From: José Example <jose@example.test>",
        "To: Team <team@example.test>",
        "Subject: =?UTF-8?B?5pel5pys?= report",
        "Content-Type: multipart/mixed; boundary=outer",
        "",
        "--outer",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hello from the archive",
        "--outer",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment; filename=report.txt",
        "Content-ID: <part-1@example.test>",
        "Content-Transfer-Encoding: base64",
        "",
        "YXR0YWNobWVudA==",
        "--outer--",
        "",
      ].join("\r\n"),
    );
    const parts: MimeStreamPart[] = [];
    const contents: Uint8Array[] = [];
    const parsed = await parseStagedEml({
      sourcePath: path,
      onPart: async (part) => {
        parts.push(part);
        contents.push(await consume(part));
      },
    });

    expect(parsed.headers.map((header) => header.normalizedName)).toEqual([
      "from",
      "to",
      "subject",
      "content-type",
    ]);
    expect(parsed.headers[2]?.normalizedValue).toContain("日本");
    expect(parsed.addresses).toEqual([
      {
        ordinal: 1,
        role: "from",
        position: 1,
        address: "jose@example.test",
        displayName: "José Example",
        groupName: null,
      },
      {
        ordinal: 2,
        role: "to",
        position: 1,
        address: "team@example.test",
        displayName: "Team",
        groupName: null,
      },
    ]);
    expect(parts.map((part) => part.kind).sort()).toEqual(["attachment", "body"]);
    expect(parts.every((part) => part.provenance.untrusted)).toBe(true);
    expect(contents.map((content) => new TextDecoder().decode(content)).sort()).toEqual([
      "attachment",
      "hello from the archive",
    ]);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "report.txt",
      contentType: "text/plain",
      contentId: "<part-1@example.test>",
      size: 10,
    });
  });

  test("returns a typed safe error for malformed headers", async () => {
    const path = await fixture("malformed.eml", "Subject broken\r\n\r\nbody\r\n");
    const result = await safeParseStagedEml({ sourcePath: path });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("malformed-header");
  });

  test("rejects excessive headers and nested MIME parts before retaining content", async () => {
    const path = await fixture(
      "nested.eml",
      [
        "Content-Type: multipart/mixed; boundary=outer",
        "",
        "--outer",
        "Content-Type: multipart/mixed; boundary=inner",
        "",
        "--inner",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment; filename=x.bin",
        "",
        "payload",
        "--inner--",
        "--outer--",
        "",
      ].join("\r\n"),
    );
    const nested = await safeParseStagedEml({
      sourcePath: path,
      limits: { maxNestingDepth: 1 },
    });
    expect(nested.kind).toBe("error");
    if (nested.kind === "error") expect(nested.error.code).toBe("nesting-limit");

    const headerPath = await fixture("headers.eml", `X-Long: ${"x".repeat(100)}\r\n\r\nbody`);
    const headers = await safeParseStagedEml({
      sourcePath: headerPath,
      limits: { maxHeaderBytes: 32 },
    });
    expect(headers.kind).toBe("error");
    if (headers.kind === "error") expect(headers.error.code).toBe("header-limit");
  });

  test("returns from a closed nested multipart to its parent boundary", async () => {
    const path = await fixture(
      "valid-nested.eml",
      [
        "Content-Type: multipart/mixed; boundary=outer",
        "",
        "--outer",
        "Content-Type: multipart/alternative; boundary=inner",
        "",
        "--inner",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "nested text",
        "--inner--",
        "--outer",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment; filename=outer.bin",
        "",
        "outer attachment",
        "--outer--",
        "",
      ].join("\r\n"),
    );
    const contents: string[] = [];

    const parsed = await parseStagedEml({
      sourcePath: path,
      onPart: async (part) => {
        contents.push(new TextDecoder().decode(await consume(part)));
      },
    });

    expect(contents.sort()).toEqual(["nested text", "outer attachment"]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.bodyParts).toHaveLength(1);
  });

  test("streams a child-generated large attachment without a raw buffer API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-large-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "large.eml");
    const child = Bun.spawn([
      "bun",
      "-e",
      `const data = Buffer.alloc(4 * 1024 * 1024, 97).toString("base64"); await Bun.write(${JSON.stringify(path)}, "Content-Type: application/octet-stream\\r\\nContent-Disposition: attachment; filename=large.bin\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" + data + "\\r\\n");`,
    ]);
    expect(await child.exited).toBe(0);
    expect((await lstat(path)).size).toBeGreaterThan(5_000_000);
    let chunks = 0;
    let bytes = 0;
    const digest = createHash("sha256");
    const parsed = await parseStagedEml({
      sourcePath: path,
      onPart: async (part) => {
        for await (const chunk of part.content) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError("non-byte chunk");
          chunks += 1;
          bytes += chunk.byteLength;
          digest.update(chunk);
        }
      },
    });
    expect(chunks).toBeGreaterThan(8);
    expect(bytes).toBe(4 * 1024 * 1024);
    expect(parsed.attachments[0]?.size).toBe(bytes);
    expect(parsed.attachments[0]?.checksum).toBe(digest.digest("hex"));
  });

  test("stops a child-generated large inline body before MailParser can buffer it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-body-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "large-body.eml");
    const child = Bun.spawn([
      "bun",
      "-e",
      `const body = "a".repeat(4 * 1024 * 1024); await Bun.write(${JSON.stringify(path)}, "Content-Type: text/plain; charset=utf-8\\r\\n\\r\\n" + body);`,
    ]);
    expect(await child.exited).toBe(0);
    expect((await lstat(path)).size).toBeGreaterThan(4_000_000);
    const observed: number[] = [];
    const result = await safeParseStagedEml({
      sourcePath: path,
      limits: { maxDecodedTextBytes: 32 * 1024 },
      onSourceBytes: (bytes) => observed.push(bytes),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("decoded-text-limit");
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.at(-1)).toBeLessThan(256 * 1024);
  });
});
