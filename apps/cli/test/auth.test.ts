import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { runAuthCommand } from "../src/auth.js";
import type { TokenStore } from "@ahp/oura-client/auth";

const store: TokenStore = { read: async () => null, write: async () => undefined, clear: async () => undefined };
const environment = { OURA_CLIENT_ID: "test-client", OURA_CLIENT_SECRET: "test-secret" };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("health auth", () => {
  it("prints static usage for invalid arguments", async () => {
    const lines: string[] = [];
    expect(await runAuthCommand(["status", "extra"], (line) => lines.push(line), { store, environment })).toBe(2);
    expect(lines).toEqual(["Usage: health auth <login|status|logout>"]);
  });

  it("reports local unauthenticated state without a network operation", async () => {
    const lines: string[] = [];
    expect(await runAuthCommand(["status"], (line) => lines.push(line), { store, environment })).toBe(0);
    expect(lines).toEqual(["Oura authentication: unauthenticated."]);
  });

  it("clears only local credentials and gives honest remote-revocation guidance", async () => {
    let cleared = 0;
    const lines: string[] = [];
    expect(await runAuthCommand(["logout"], (line) => lines.push(line), { environment, store: { ...store, clear: async () => { cleared++; } } })).toBe(0);
    expect(cleared).toBe(1);
    expect(lines).toEqual(["Oura authentication: unauthenticated. Remove authorization in Oura separately if desired."]);
  });

  it("maps store failures and cancellation to static output and stable exit categories without canaries", async () => {
    const denied: string[] = [];
    const deniedStore: TokenStore = { ...store, read: async () => { throw new Error("canary Keychain diagnostic"); } };
    expect(await runAuthCommand(["status"], (line) => denied.push(line), { environment, store: deniedStore })).toBe(3);
    expect(denied).toEqual(["Credential storage is unavailable."]);
    expect(JSON.stringify(denied)).not.toContain("canary");

    const port = await unusedPort();
    const controller = new AbortController();
    const cancelled: string[] = [];
    expect(await runAuthCommand(["login"], (line) => cancelled.push(line), {
      environment: { ...environment, OURA_REDIRECT_URI: `http://127.0.0.1:${port}/callback` },
      store,
      signal: controller.signal,
      openBrowser: async () => { controller.abort(); }
    })).toBe(130);
    expect(cancelled).toEqual(["Authentication was cancelled."]);
  });

  it("gives only static, manual-cleanup guidance when a lock is held or stale", async () => {
    const lines: string[] = [];
    expect(await runAuthCommand(["logout"], (line) => lines.push(line), {
      environment, store, lock: { acquire: async () => null }
    })).toBe(3);
    expect(lines).toEqual(["Another authentication operation is in progress. If it ended unexpectedly, confirm no authentication process is running, then manually remove the stale local auth lock before retrying."]);
  });
});
