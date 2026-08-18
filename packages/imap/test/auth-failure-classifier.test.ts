import { describe, expect, test } from "bun:test";
import {
  classifyImapAuthenticationFailure,
  type ImapAuthenticationFault,
} from "../src/auth-failure-classifier";
import fixtures from "./fixtures/auth-failure-production-labeled.json";

const account = "agent-mail@example.com";
const authFixtures = [
  fixtures.authenticationFailure,
  fixtures.authorizationFailure,
  fixtures.oauthFailure,
  fixtures.credentialTextFailure,
  fixtures.responseOnlyFailure,
] as const;

describe("production-shaped IMAP authentication classification", () => {
  test("maps every captured authentication variant to the one auth_required fault", () => {
    for (const captured of authFixtures) {
      const fault = classifyImapAuthenticationFailure(captured, { account });
      expect(fault).not.toBeNull();
      expect(fault).toMatchObject<ImapAuthenticationFault>({
        category: "authentication",
        code: "auth_required",
        safeMessage: "Credentials were rejected.",
        authReason: "provider-rejected",
      });
      expect(fault?.diagnostics).toHaveLength(1);
      expect(fault?.diagnostics[0]).toMatchObject({
        account,
        message: "IMAP authentication was rejected.",
      });
    }
  });

  test("retains only safe account and server category metadata", () => {
    const fault = classifyImapAuthenticationFailure(fixtures.authenticationFailure, { account });
    expect(fault).not.toBeNull();
    const serialized = JSON.stringify(fault);
    expect(serialized).toContain(account);
    expect(serialized).toContain("AUTHENTICATIONFAILED");
    expect(serialized).not.toContain("fixture-secret");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("password=");
    expect(serialized).not.toContain("authorization:");
    expect(serialized).not.toContain("response");
  });

  test("does not turn an adjacent transient timeout into auth_required", () => {
    const fault = classifyImapAuthenticationFailure(fixtures.networkTimeout, { account });
    expect(fault).toBeNull();
    expect(fault?.category).not.toBe("authentication");
  });

  test("keeps invalid-password rejection out of the transient network category", () => {
    const fault = classifyImapAuthenticationFailure(fixtures.invalidPasswordWithNetworkCode, {
      account,
    });
    expect(fault).toMatchObject({ category: "authentication", code: "auth_required" });
    expect(fault?.category).not.toBe("transient");
  });

  test("rejects credential-looking account identities from diagnostic output", () => {
    const fault = classifyImapAuthenticationFailure(fixtures.credentialTextFailure, {
      account: "password=fixture-secret",
    });
    expect(fault?.diagnostics[0]?.account).toBe("unknown-account");
    expect(JSON.stringify(fault)).not.toContain("fixture-secret");
  });
});
