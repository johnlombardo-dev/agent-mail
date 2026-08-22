import { describe, expect, test } from "bun:test";
import {
  activeDemoImapTestPortLeases,
  createDemoImapServer,
  leaseDemoImapTestPort,
} from "../src/demo/imap";
import { createInstalledDemoImapFlow } from "./adapter-contracts/demo-imap-runtime";

describe("demo IMAP concurrent port ownership", () => {
  test("leases exactly 6112-6114 and closes every listener, socket, timer, and lease", async () => {
    const leases = [leaseDemoImapTestPort(), leaseDemoImapTestPort(), leaseDemoImapTestPort()];
    expect(leases.map(({ port }) => port).sort((left, right) => left - right)).toEqual([
      6112, 6113, 6114,
    ]);
    expect(() => leaseDemoImapTestPort()).toThrow("all demo IMAP test ports are leased");
    const servers = leases.map((lease) =>
      createDemoImapServer({ port: lease.port, releasePort: lease.release }),
    );
    const flows = servers.map((server) => createInstalledDemoImapFlow(server));
    try {
      await Promise.all(servers.map((server) => server.start()));
      await Promise.all(flows.map((flow) => flow.connect()));
      const lists = await Promise.all(flows.map((flow) => flow.list()));
      expect(lists.every((list) => list.some(({ path }) => path === "INBOX"))).toBe(true);
      expect(servers.every((server) => server.snapshot().activeSessions === 1)).toBe(true);
    } finally {
      flows.forEach((flow) => flow.close());
      await Promise.all(servers.map((server) => server.close()));
    }
    expect(activeDemoImapTestPortLeases()).toBe(0);
    for (const server of servers) {
      expect(server.snapshot()).toMatchObject({
        listening: false,
        activeSessions: 0,
        activeSockets: 0,
        activeListeners: 0,
        pendingTimers: 0,
        childProcesses: 0,
        activeTestLeases: 0,
      });
    }
  });

  test("rejects every non-Hermes demo port before binding", () => {
    expect(() => Reflect.apply(createDemoImapServer, undefined, [{ port: 7000 }])).toThrow(
      "demo IMAP port must be 6111-6114",
    );
    expect(createDemoImapServer().host).toBe("127.0.0.1");
    expect(createDemoImapServer().port).toBe(6111);
  });
});
