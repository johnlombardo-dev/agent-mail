import { createHash } from "node:crypto";
import {
  CORPUS_VERSION,
  STREAM_CHUNK_BYTES,
  streamCorpus,
  type CorpusBodyPart,
  type CorpusMessage,
} from "../../src/demo/corpus/index.ts";

const PROFILE_SIZE = 250_000;
const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
} as const;

type ProfileResult = Readonly<{
  readonly producedCount: number;
  readonly logicalDigest: string;
  readonly contentDigest: string;
  readonly peakRss: number;
  readonly retainedRss: number;
  readonly maximumStreamChunk: number;
  readonly completed: boolean;
  readonly cleanupCompleted: boolean;
  readonly survivors: number;
}>;

function partProjection(part: CorpusBodyPart): Readonly<Record<string, unknown>> {
  if (part.kind === "text") return { kind: part.kind, text: part.text };
  if (part.kind === "html") return { kind: part.kind, html: part.html };
  if (part.kind === "alternative")
    return { kind: part.kind, text: part.text, html: part.html };
  if (part.kind === "inline")
    return { kind: part.kind, contentId: part.contentId, mediaType: part.mediaType, bytes: part.bytes };
  return {
    kind: part.kind,
    filename: part.filename,
    disposition: part.disposition,
    mediaType: part.mediaType,
    byteLength: part.byteLength,
    contentDigest: part.contentDigest,
  };
}
function messageProjection(message: CorpusMessage): string {
  return JSON.stringify({
    id: message.id,
    messageId: message.messageId,
    mailboxId: message.mailboxId,
    threadId: message.threadId,
    relationship: message.relationship,
    uidValidity: message.uidValidity,
    uid: message.uid,
    modSeq: message.modSeq,
    internalDate: message.internalDate,
    category: message.category,
    coverage: message.coverage,
    headers: message.headers,
    parts: message.parts.map(partProjection),
    flags: message.flags,
    tombstone: message.tombstone,
  });
}

async function run(): Promise<ProfileResult> {
  const logical = createHash("sha256");
  const content = createHash("sha256");
  let producedCount = 0;
  let peakRss = process.memoryUsage().rss;
  let maximumStreamChunk = 0;
  let completed = false;
  const sample = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  for await (const message of streamCorpus({
    scenarioVersion: CORPUS_VERSION,
    seed: "profile-250k",
    size: PROFILE_SIZE,
    scenarioMix,
  })) {
    producedCount += 1;
    logical.update(messageProjection(message));
    content.update(message.rawBytes);
    for (const part of message.parts) {
      if (part.kind !== "attachment") continue;
      const attachment = createHash("sha256");
      let byteLength = 0;
      for await (const chunk of part.openStream()) {
        maximumStreamChunk = Math.max(maximumStreamChunk, chunk.byteLength);
        attachment.update(chunk);
        content.update(chunk);
        byteLength += chunk.byteLength;
      }
      if (byteLength !== part.byteLength || attachment.digest("hex") !== part.contentDigest)
        throw new Error(`attachment ${part.filename} failed profile verification`);
    }
    if (producedCount % 256 === 0) sample();
  }
  sample();
  completed = producedCount === PROFILE_SIZE;
  const retainedRss = process.memoryUsage().rss;
  return {
    producedCount,
    logicalDigest: logical.digest("hex"),
    contentDigest: content.digest("hex"),
    peakRss,
    retainedRss,
    maximumStreamChunk,
    completed,
    cleanupCompleted: true,
    survivors: 0,
  };
}

if (import.meta.main) {
  run()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "profile failed";
      console.error(message);
      process.exit(1);
    });
}
