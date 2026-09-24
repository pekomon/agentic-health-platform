#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RecommendCommandDependencies } from "./recommend.js";
import { RECOMMEND_POLICY_TEXT } from "./policy.js";

type Output = (text: string) => void;

export async function runCli(
  argv: readonly string[],
  stdout: Output,
  stderr: Output,
  recommendDependencies: RecommendCommandDependencies = {}
): Promise<number> {
  const [area, ...arguments_] = argv;
  if (area === "recommend") {
    if (arguments_.length === 0) { stderr(RECOMMEND_POLICY_TEXT); return 6; }
    const { runRecommendCommand } = await import("./recommend.js");
    return runRecommendCommand(arguments_, stdout, stderr, recommendDependencies);
  }
  if (area === "auth") {
    const { runAuthCommand } = await import("./auth.js");
    return runAuthCommand(arguments_, stdout);
  }
  if (area === "inspect") {
    const { runInspectCommand } = await import("./inspect.js");
    return runInspectCommand(arguments_, stdout);
  }
  stderr("Usage: health <auth|inspect|recommend> ...");
  return 2;
}

function isDirectInvocation(argument: string | undefined): boolean {
  if (argument === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(resolve(argument));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  try {
    process.exitCode = await runCli(
      process.argv.slice(2),
      (text) => process.stdout.write(`${text}\n`),
      (text) => process.stderr.write(`${text}\n`),
      { signal: controller.signal }
    );
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
