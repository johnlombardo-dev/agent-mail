import { DEMO_IMAP_TEST_PORTS, type DemoImapTestPortLease } from "./types";

const activePorts = new Set<number>();

export function leaseDemoImapTestPort(): DemoImapTestPortLease {
  const port = DEMO_IMAP_TEST_PORTS.find((candidate) => !activePorts.has(candidate));
  if (port === undefined) throw new Error("all demo IMAP test ports are leased");
  activePorts.add(port);
  let released = false;
  return Object.freeze({
    port,
    release: () => {
      if (released) return;
      released = true;
      activePorts.delete(port);
    },
  });
}

export function activeDemoImapTestPortLeases(): number {
  return activePorts.size;
}
