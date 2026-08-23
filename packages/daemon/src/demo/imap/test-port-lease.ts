import { createSocket, type Socket } from "node:dgram";
import { DEMO_IMAP_TEST_PORTS, type DemoImapPortLease, type DemoImapTestPort } from "./types";

const activeLeases = new Set<Socket>();

function isTestPort(value: number): value is DemoImapTestPort {
  return DEMO_IMAP_TEST_PORTS.some((candidate) => candidate === value);
}

async function acquire(port: DemoImapTestPort): Promise<Socket | null> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(port, "127.0.0.1");
    });
    activeLeases.add(socket);
    return socket;
  } catch {
    socket.close();
    return null;
  }
}

export async function leaseDemoImapTestPort(
  preferredPort?: DemoImapTestPort,
): Promise<DemoImapPortLease> {
  if (preferredPort !== undefined && !isTestPort(preferredPort))
    throw new RangeError("demo IMAP test port must be 6112, 6113, or 6114");
  const ports = preferredPort === undefined ? DEMO_IMAP_TEST_PORTS : [preferredPort];
  for (const port of ports) {
    const socket = await acquire(port);
    if (socket === null) continue;
    let released = false;
    return Object.freeze({
      port,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        activeLeases.delete(socket);
        await new Promise<void>((resolve) => socket.close(() => resolve()));
      },
    });
  }
  throw new Error(
    preferredPort === undefined
      ? "all demo IMAP test ports are leased"
      : `demo IMAP test port ${preferredPort} is leased`,
  );
}

export function activeDemoImapTestPortLeases(): number {
  return activeLeases.size;
}
