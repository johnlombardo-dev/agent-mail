import { createOperationRegistry, defineOperation } from "@agent-mail/contracts";
import { z } from "zod";
import { createHttpApp, type HttpCredentialResolution } from "../../src/http";

const limit = 64 * 1024;
const iterations = 200;
const operation = defineOperation({
  key: "synthetic.memory",
  route: "/v1/synthetic/memory",
  method: "POST",
  cliName: "synthetic-memory",
  scope: "synthetic:memory",
  request: z.strictObject({ value: z.string() }),
  response: z.strictObject({ ok: z.literal(true) }),
  streaming: "none",
  strictness: "strict",
});
const registry = createOperationRegistry([operation] as const);
const app = createHttpApp({
  registry,
  maxRequestBodyBytes: limit,
  authenticate: (): HttpCredentialResolution => ({
    kind: "authenticated",
    principal: { subject: "operator", scopes: [operation.scope] },
  }),
  handlers: { [operation.key]: () => ({ ok: true }) },
});

function oversizedChunkedBody(): ReadableStream<Uint8Array> {
  let first = true;
  return new ReadableStream({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new Uint8Array(limit));
      } else {
        controller.enqueue(new Uint8Array(1));
      }
    },
  });
}

const baselineRssBytes = process.memoryUsage().rss;
let peakRssBytes = baselineRssBytes;
const statuses: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const response = await app.request(
    new Request("http://localhost/v1/synthetic/memory", {
      method: "POST",
      headers: {
        authorization: "Bearer correct",
        "content-type": "application/json",
      },
      body: oversizedChunkedBody(),
    }),
  );
  statuses.push(response.status);
  await response.arrayBuffer();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}
const finalRssBytes = process.memoryUsage().rss;
console.log(
  JSON.stringify({
    baselineRssBytes,
    peakRssBytes,
    finalRssBytes,
    peakGrowthBytes: Math.max(0, peakRssBytes - baselineRssBytes),
    retainedGrowthBytes: Math.max(0, finalRssBytes - baselineRssBytes),
    iterations,
    limit,
    statuses,
  }),
);
