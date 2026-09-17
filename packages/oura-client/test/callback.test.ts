import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { startCallbackListener } from "../src/auth/callback.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function sendCallback(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {}
): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const pending = request({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: { host: options.host ?? `127.0.0.1:${port}` }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        status: response.statusCode
      }));
    });
    pending.on("error", reject);
    pending.end();
  });
}

const state = Buffer.alloc(32, 7).toString("base64url");

describe("loopback callback listener", () => {
  it("rejects malformed attempts without consuming the legitimate code", async () => {
    const port = await unusedPort();
    const attempt = await startCallbackListener(`http://127.0.0.1:${port}/callback`, state);
    try {
      const rejected = [
        "/callback?code=code",
        "/callback?code=code&state=short",
        `/callback?code=code&state=${state}&state=${state}`,
        `/callback?code=code&code=second&state=${state}`,
        `/callback?code=code&error=access_denied&state=${state}`,
        `/callback?error=access_denied&state=${state}&error=access_denied`,
        `/other?code=code&state=${state}`
      ];
      for (const path of rejected) {
        const response = await sendCallback(port, path);
        expect(response).toMatchObject({ status: 200, body: "Authentication response received. You may close this window." });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain("code");
        expect(response.body).not.toContain(state);
      }
      await sendCallback(port, `/callback?code=accepted&scope=daily%20workout&state=${state}`, { method: "POST" });
      await sendCallback(port, `/callback?code=accepted&scope=daily%20workout&state=${state}`, { host: `localhost:${port}` });

      await sendCallback(port, `/callback?code=accepted&scope=daily%20workout&state=${state}`);
      await expect(attempt.wait()).resolves.toEqual({ kind: "code", code: "accepted", grantedScopes: ["daily", "workout"] });
    } finally {
      await attempt.close();
    }
  });

  it("consumes a valid denial and ignores replayed callbacks", async () => {
    const port = await unusedPort();
    const attempt = await startCallbackListener(`http://127.0.0.1:${port}/callback`, state);
    try {
      await sendCallback(port, `/callback?error=access_denied&state=${state}`);
      await expect(attempt.wait()).resolves.toEqual({ kind: "denied" });
      await sendCallback(port, `/callback?code=replayed&state=${state}`);
      await expect(attempt.wait()).resolves.toEqual({ kind: "denied" });
    } finally {
      await attempt.close();
    }
  });

  it("closes the listener and accepted request resources", async () => {
    const port = await unusedPort();
    const attempt = await startCallbackListener(`http://127.0.0.1:${port}/callback`, state);
    await attempt.close();
    await expect(sendCallback(port, `/callback?code=code&state=${state}`)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("refuses non-loopback listener configuration before binding", async () => {
    await expect(startCallbackListener("http://0.0.0.0:8788/callback", state)).rejects.toThrow("Invalid loopback callback configuration.");
    await expect(startCallbackListener("http://[::1]:8788/callback", state)).rejects.toThrow("Invalid loopback callback configuration.");
  });
});
