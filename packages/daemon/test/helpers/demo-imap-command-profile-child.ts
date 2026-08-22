import { createConnection } from "node:net";
import {
  createDemoImapServer,
  DEMO_IMAP_ADMISSION_LIMITS,
  leaseDemoImapTestPort,
} from "../../src/demo/imap";

const commandCount = 6_000;
const responseMarker = " OK NOOP completed\r\n";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(1);
  }
}

const lease = leaseDemoImapTestPort();
const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
await server.start();

const socket = createConnection({ host: server.host, port: server.port });
let setupTranscript = "";
let responseTail = "";
let responses = 0;
let commandPhase = false;
let socketFailure: Error | null = null;
socket.on("data", (chunk) => {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  if (!commandPhase) {
    setupTranscript += text;
    return;
  }
  responseTail += text;
  for (;;) {
    const marker = responseTail.indexOf(responseMarker);
    if (marker < 0) break;
    responses += 1;
    responseTail = responseTail.slice(marker + responseMarker.length);
  }
  if (responseTail.length > responseMarker.length) {
    responseTail = responseTail.slice(-responseMarker.length);
  }
});
socket.on("error", (error) => {
  socketFailure = error;
});

try {
  await waitFor(
    () => setupTranscript.includes("Agent Mail demo ready") || socketFailure !== null,
    "profile greeting stalled",
  );
  if (socketFailure !== null) throw socketFailure;
  socket.write('A1 LOGIN "demo-user" "demo-pass"\r\n');
  await waitFor(
    () => setupTranscript.includes("A1 OK") || socketFailure !== null,
    "profile authentication stalled",
  );
  if (socketFailure !== null) throw socketFailure;

  commandPhase = true;
  setupTranscript = "";
  const baselineRss = process.memoryUsage.rss();
  let peakRss = baselineRss;
  let sent = 0;
  while (sent < commandCount) {
    const batchSize = Math.min(DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands, commandCount - sent);
    socket.write(
      Array.from({ length: batchSize }, (_, offset) => `C${sent + offset} NOOP\r\n`).join(""),
    );
    sent += batchSize;
    await waitFor(() => responses === sent || socketFailure !== null, "profile batch stalled");
    if (socketFailure !== null) throw socketFailure;
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }

  const retainedCommands = server.snapshot().commands.length;
  socket.destroy();
  await server.close();
  const finalSnapshot = server.snapshot();
  console.log(
    JSON.stringify({
      kind: "profile",
      responses,
      retainedCommands,
      rssGrowthBytes: Math.max(0, peakRss - baselineRss),
      activeSessions: finalSnapshot.activeSessions,
      activeSockets: finalSnapshot.activeSockets,
      activeListeners: finalSnapshot.activeListeners,
      pendingTimers: finalSnapshot.pendingTimers,
      activeTestLeases: finalSnapshot.activeTestLeases,
    }),
  );
} finally {
  socket.destroy();
  await server.close();
}
