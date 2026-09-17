import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AuthLock = { release(): Promise<void> };

export class FileAuthLock {
  constructor(private readonly clientId: string, private readonly directory = join(tmpdir(), "agentic-health-platform")) {}

  async acquire(): Promise<AuthLock | null> {
    const namespace = createHash("sha256").update(this.clientId).digest("hex");
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const path = join(this.directory, `oura-auth-${namespace}.lock`);
      await mkdir(path, { mode: 0o700 });
      // The nonce makes a delayed old release unable to unlink a replacement
      // owner's metadata after manual stale-lock cleanup.
      const metadataPath = join(path, `owner-${randomUUID()}.json`);
      const handle = await open(metadataPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      }
      finally { await handle.close(); }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await unlink(metadataPath);
            // rmdir only removes this now-empty lock directory. A replacement
            // owner writes its metadata before it can treat acquisition as done.
            await rmdir(path);
          } catch (error: unknown) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
            throw error;
          }
        }
      };
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return null;
      throw error;
    }
  }
}
