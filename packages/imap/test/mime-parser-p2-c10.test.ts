import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseStagedEml, safeParseStagedEml, type MimeStreamPart } from "../src/mime-parser";

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

  test("accepts the signed #300 bare-address rendering without changing source bytes", async () => {
    const source = [
      "Message-ID: <demo-1@example.test>",
      "Date: Sun, 23 Aug 2026 02:00:00 GMT",
      "From: sender@example.test",
      "To: recipient@example.test",
      "Subject: Synthetic 1",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "signed #300 body",
      "",
    ].join("\r\n");
    const path = await fixture("signed-300.eml", source);
    const parsed = await parseStagedEml({ sourcePath: path });

    expect(parsed.addresses).toEqual([
      {
        ordinal: 1,
        role: "from",
        position: 1,
        address: "sender@example.test",
        displayName: null,
        groupName: null,
      },
      {
        ordinal: 2,
        role: "to",
        position: 1,
        address: "recipient@example.test",
        displayName: null,
        groupName: null,
      },
    ]);
    expect(await readFile(path)).toEqual(Buffer.from(source));
  });

  test("parses all twelve signed #300-style UTF-8 subjects without changing bytes", async () => {
    const subjects = [
      "Synthetic 1",
      "אבג",
      "Ελληνικά",
      "日本語",
      "مرحبا",
      "שלום \u200fΕλληνικά",
      "日本語 \u202eBidi",
      "Résumé",
      "中文消息",
      "東京レポート",
      "Καλημέρα κόσμε",
      "Mix אבג Ελληνικά 日本語",
    ] as const;
    for (const [index, subject] of subjects.entries()) {
      const source = [
        `Message-ID: <demo-${index + 1}@example.test>`,
        "Date: Sun, 23 Aug 2026 02:00:00 GMT",
        "From: sender@example.test",
        "To: recipient@example.test",
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        `signed #300 body ${index + 1}`,
        "",
      ].join("\r\n");
      const path = await fixture(`signed-300-${index + 1}.eml`, source);
      const parsed = await parseStagedEml({ sourcePath: path });
      const subjectHeader = parsed.headers.find((header) => header.normalizedName === "subject");
      expect(subjectHeader?.value).toBe(subject);
      expect(subjectHeader?.normalizedValue).toBe(subject);
      expect(await readFile(path)).toEqual(Buffer.from(source));
    }
  });

  test("correlates duplicate decoded occurrences and unfolds legal header folds", async () => {
    const source = [
      "X-Duplicate: one",
      "X-Duplicate: two",
      "X-Duplicate: three",
      "X-Folded: alpha ",
      "\t beta",
      "  gamma",
      "Subject: folded",
      "",
      "body",
      "",
    ].join("\r\n");
    const path = await fixture("headers-and-duplicates.eml", source);
    const parsed = await parseStagedEml({ sourcePath: path });
    expect(parsed.headers.filter((header) => header.normalizedName === "x-duplicate")).toEqual([
      {
        ordinal: 1,
        name: "X-Duplicate",
        normalizedName: "x-duplicate",
        value: "one",
        normalizedValue: "one",
      },
      {
        ordinal: 2,
        name: "X-Duplicate",
        normalizedName: "x-duplicate",
        value: "two",
        normalizedValue: "two",
      },
      {
        ordinal: 3,
        name: "X-Duplicate",
        normalizedName: "x-duplicate",
        value: "three",
        normalizedValue: "three",
      },
    ]);
    expect(parsed.headers.find((header) => header.normalizedName === "x-folded")).toEqual({
      ordinal: 4,
      name: "X-Folded",
      normalizedName: "x-folded",
      value: "alpha  beta gamma",
      normalizedValue: "alpha beta gamma",
    });
  });

  test("preserves MailParser names and normalizes its empty optional names", async () => {
    const namedPath = await fixture(
      "named-group.eml",
      [
        'From: Jane "" <jane@example.test>',
        'To: Jane "   " <space@example.test>',
        "Cc: Jane =?UTF-8?Q?=20?= <encoded@example.test>",
        "Bcc: Team: Jane =?UTF-8?Q?=20?= <member@example.test>;",
        "Subject: named",
        "",
        "body",
        "",
      ].join("\r\n"),
    );
    const named = await parseStagedEml({ sourcePath: namedPath });
    expect(named.addresses).toContainEqual({
      ordinal: 1,
      role: "from",
      position: 1,
      address: "jane@example.test",
      displayName: "Jane",
      groupName: null,
    });
    expect(named.addresses).toContainEqual({
      ordinal: 2,
      role: "to",
      position: 1,
      address: "space@example.test",
      displayName: "Jane",
      groupName: null,
    });
    expect(named.addresses).toContainEqual({
      ordinal: 3,
      role: "cc",
      position: 1,
      address: "encoded@example.test",
      displayName: "Jane  ",
      groupName: null,
    });
    expect(named.addresses).toContainEqual({
      ordinal: 4,
      role: "bcc",
      position: 1,
      address: "member@example.test",
      displayName: "Jane  ",
      groupName: "Team",
    });

    const emptyPath = await fixture(
      "empty-address-names.eml",
      [
        'From: "" <first@example.test>',
        'To: first@example.test, "   " <second@example.test>',
        'Cc: Team: "" <member@example.test>;',
        'Bcc: "": anonymous@example.test;',
        "Subject: empty",
        "",
        "body",
        "",
      ].join("\r\n"),
    );
    const empty = await parseStagedEml({ sourcePath: emptyPath });
    expect(empty.addresses).toEqual([
      {
        ordinal: 1,
        role: "from",
        position: 1,
        address: "first@example.test",
        displayName: null,
        groupName: null,
      },
      {
        ordinal: 2,
        role: "to",
        position: 1,
        address: "first@example.test",
        displayName: null,
        groupName: null,
      },
      {
        ordinal: 3,
        role: "to",
        position: 2,
        address: "second@example.test",
        displayName: null,
        groupName: null,
      },
      {
        ordinal: 4,
        role: "cc",
        position: 1,
        address: "member@example.test",
        displayName: null,
        groupName: "Team",
      },
      {
        ordinal: 5,
        role: "bcc",
        position: 1,
        address: "anonymous@example.test",
        displayName: null,
        groupName: null,
      },
    ]);
  });

  test("rejects hostile nonempty metadata and required empty addresses", async () => {
    const invalidSources = [
      ["nul", 'From: "bad\u0000name" <sender@example.test>'],
      ["c0", 'From: "bad\u0001name" <sender@example.test>'],
      ["c1", 'From: "bad\u0080name" <sender@example.test>'],
      ["over-limit", `From: "${"x".repeat(17_000)}" <sender@example.test>`],
      ["malformed", "From: not-an-address <"],
      ["empty-address", "From: <>"],
    ] as const;
    for (const [name, from] of invalidSources) {
      const path = await fixture(
        `${name}.eml`,
        [from, "To: recipient@example.test", "Subject: invalid", "", "body", ""].join("\r\n"),
      );
      const result = await safeParseStagedEml({ sourcePath: path });
      expect(result.kind, name).toBe("error");
      if (result.kind === "error") expect(result.error.code).toMatch(/metadata-limit|parser-error/);
    }
  });

  test("rejects malformed header boundaries and decoded/raw value limits", async () => {
    const invalidSources = [
      ["bad-name", "Bad Name: value\r\nSubject: valid"],
      ["missing-separator", "NoSeparator\r\nSubject: valid"],
      ["obs-fold-without-wsp", "Subject: one\r\ncontinuation"],
      ["bare-cr", "Subject: one\rmore"],
      ["bare-lf", "Subject: one\nmore"],
      ["nul", "Subject: bad\u0000value"],
      ["c0", "Subject: bad\u0001value"],
      ["c1", "Subject: bad\u0080value"],
      ["empty-decoded", "Subject: "],
      ["overlimit-decoded", `Subject: ${"x".repeat(17_000)}`],
      ["empty-raw-fallback", "X-Fallback:"],
      ["overlimit-raw-fallback", `X-Fallback: ${"x".repeat(17_000)}`],
    ] as const;
    for (const [name, headers] of invalidSources) {
      const path = await fixture(`${name}.eml`, `${headers}\r\n\r\nbody\r\n`);
      const result = await safeParseStagedEml({ sourcePath: path });
      expect(result.kind, name).toBe("error");
      if (result.kind === "error")
        expect(result.error.code).toMatch(/header-limit|malformed-header|metadata-limit/);
    }
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

    const lineCountPath = await fixture(
      "header-count.eml",
      ["Subject: one", "X-Second: two", "", "body", ""].join("\r\n"),
    );
    const lineCount = await safeParseStagedEml({
      sourcePath: lineCountPath,
      limits: { maxHeaderLines: 1 },
    });
    expect(lineCount.kind).toBe("error");
    if (lineCount.kind === "error") expect(lineCount.error.code).toBe("header-limit");
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
