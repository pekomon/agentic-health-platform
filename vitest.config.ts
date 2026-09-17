import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/*.test.ts", "services/*/test/*.test.ts", "apps/*/test/*.test.ts"],
    pool: "forks"
  }
});
