import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelRefusalError, ModelTimeoutError } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall, modelError, modelResponder } from "@openai/agents/testing";

import { runCli } from "../src/main.js";
import { runRecommendCommand } from "../src/recommend.js";
import { replayScenario } from "../../../services/health-agent/evals/replay.js";
import { SCENARIO_IDS } from "../../../services/health-agent/evals/scenarios.js";

const args = (scenarioId = "well_recovered_runner", json = false) => [
  "--synthetic", scenarioId, "--model", "scripted-model", ...(json ? ["--json"] : [])
];

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) };
}

function scriptedModel(draft: unknown) {
  return new ScriptedModel([
    [functionCall("get_user_profile", {}, { callId: "profile" })],
    [functionCall("get_current_context", {}, { callId: "context" })],
    [functionCall("get_sleep_history", { days: 14 }, { callId: "sleep" })],
    [functionCall("get_recovery_history", { days: 14 }, { callId: "recovery" })],
    [functionCall("get_recent_training", { days: 14 }, { callId: "training" })],
    [assistantMessage(JSON.stringify(draft))]
  ]);
}

describe("health recommend", () => {
  it("runs the declared health bin through a symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "ahp-cli-bin-"));
    const link = join(directory, "health");
    symlinkSync(resolve("apps/cli/dist/main.js"), link);
    const child = spawnSync(process.execPath, [link, "recommend"], { cwd: process.cwd(), encoding: "utf8" });
    expect(child.status).toBe(6);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("POLICY_BLOCKED");
  });

  it("preserves auth and inspect routing and blocks the default with zero model work", async () => {
    const auth = capture();
    expect(await runCli(["auth", "status", "extra"], auth.out, auth.err)).toBe(2);
    expect(auth.stdout).toEqual(["Usage: health auth <login|status|logout>"]);
    const inspect = capture();
    expect(await runCli(["inspect"], inspect.out, inspect.err)).toBe(2);
    expect(inspect.stdout).toEqual(["Usage: health inspect --days <1..14> [--show-values]"]);

    const blocked = capture();
    const getApiKey = vi.fn(() => { throw new Error("model key was read"); });
    const createModel = vi.fn(() => { throw new Error("model was created"); });
    const recommend = vi.fn();
    expect(await runCli(["recommend"], blocked.out, blocked.err, { getApiKey, createModel, recommend })).toBe(6);
    expect(blocked.stdout).toEqual([]);
    expect(blocked.stderr).toEqual([expect.stringContaining("POLICY_BLOCKED")]);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(recommend).not.toHaveBeenCalled();
  });

  it("runs the existing agent for all five canonical scenarios and renders validated output", async () => {
    for (const scenarioId of SCENARIO_IDS) {
      const replay = await replayScenario(scenarioId);
      const model = scriptedModel(replay.draft);
      const io = capture();
      const createModel = vi.fn(() => model);
      expect(await runRecommendCommand(args(scenarioId), io.out, io.err, {
        getApiKey: () => "fabricated-key", createModel
      })).toBe(0);
      expect(io.stderr).toEqual([]);
      expect(io.stdout).toHaveLength(1);
      expect(io.stdout[0]).toContain("SYNTHETIC training recommendation");
      expect(io.stdout[0]).toContain(`fabricated scenario ${scenarioId}`);
      expect(io.stdout[0]).toContain("Activity:");
      expect(io.stdout[0]).toContain("Intensity:");
      expect(io.stdout[0]).toContain("Rationale:");
      expect(io.stdout[0]).toContain("Evidence:");
      expect(io.stdout[0]).toContain("date ");
      expect(io.stdout[0]).toContain("source ");
      expect(io.stdout[0]).toContain("Confidence:");
      expect(io.stdout[0]).toContain("Limitations:");
      if (scenarioId === "missing_data") expect(io.stdout[0]).toContain("missing not_recorded");
      expect(createModel).toHaveBeenCalledWith("scripted-model", "fabricated-key");
      model.assertComplete();
    }
  });

  it("emits only the exact JSON envelope on stdout", async () => {
    const replay = await replayScenario("well_recovered_runner");
    if (!replay.finalResult.ok) throw new Error("invalid fabricated replay");
    const io = capture();
    const model = scriptedModel(replay.draft);
    expect(await runRecommendCommand(args("well_recovered_runner", true), io.out, io.err, {
      getApiKey: () => "fabricated-key", createModel: () => model
    })).toBe(0);
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    const envelope = JSON.parse(io.stdout[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual(["schemaVersion", "mode", "recommendation"]);
    expect(envelope).toEqual({ schemaVersion: 1, mode: "synthetic", recommendation: replay.finalResult.value });
    model.assertComplete();
  });

  it("rejects malformed arguments before key lookup or model creation", async () => {
    const cases = [
      ["--synthetic", "unknown", "--model", "scripted-model"],
      ["--synthetic"],
      ["--synthetic", "--model", "scripted-model"],
      ["--synthetic", "well_recovered_runner"],
      ["--synthetic", "well_recovered_runner", "--model", ""],
      ["--synthetic", "well_recovered_runner", "--model", "one", "--model", "two"],
      ["--synthetic", "well_recovered_runner", "--synthetic", "missing_data", "--model", "one"],
      [...args(), "--json", "--json"],
      [...args(), "--unknown"],
      [...args(), "extra"],
      ["--json"],
      ["--model", "scripted-model"],
      ["--synthetic", "well_recovered_runner", "--model", "x".repeat(129)]
    ];
    for (const argv of cases) {
      const io = capture();
      const getApiKey = vi.fn(() => "fabricated-key");
      const createModel = vi.fn();
      expect(await runRecommendCommand(argv, io.out, io.err, { getApiKey, createModel })).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr).toEqual(["Usage: health recommend --synthetic <scenario-id> --model <id> [--json]"]);
      expect(getApiKey).not.toHaveBeenCalled();
      expect(createModel).not.toHaveBeenCalled();
    }
  });

  it("maps missing model configuration, model failure, invalid output, and cancellation", async () => {
    const missingKey = capture();
    expect(await runRecommendCommand(args(), missingKey.out, missingKey.err, { getApiKey: () => undefined })).toBe(2);
    expect(missingKey.stdout).toEqual([]);

    const model = new ScriptedModel();
    const failed = capture();
    expect(await runRecommendCommand(args(), failed.out, failed.err, {
      getApiKey: () => "fabricated-key", createModel: () => model,
      recommend: async () => ({ ok: false, error: { code: "MODEL_UNAVAILABLE" } })
    })).toBe(5);
    expect(failed.stdout).toEqual([]);
    expect(failed.stderr).toEqual(["The model is unavailable."]);

    const invalid = capture();
    expect(await runRecommendCommand(args(), invalid.out, invalid.err, {
      getApiKey: () => "fabricated-key", createModel: () => model,
      recommend: async () => ({ ok: true, value: { activity: "RUNNING", rationale: "partial" } as never })
    })).toBe(5);
    expect(invalid.stdout).toEqual([]);
    expect(invalid.stderr).toEqual(["The model did not produce a valid recommendation."]);

    const controller = new AbortController();
    controller.abort();
    const cancelled = capture();
    const createModel = vi.fn();
    expect(await runRecommendCommand(args(), cancelled.out, cancelled.err, {
      signal: controller.signal, createModel
    })).toBe(130);
    expect(cancelled.stdout).toEqual([]);
    expect(cancelled.stderr).toEqual(["Recommendation was cancelled."]);
    expect(createModel).not.toHaveBeenCalled();
  });

  it("maps refusal, run-limit, and cancellation from an active agent run", async () => {
    const refusal = capture();
    expect(await runRecommendCommand(args(), refusal.out, refusal.err, {
      getApiKey: () => "fabricated-key",
      createModel: () => new ScriptedModel([modelError(new ModelRefusalError("fabricated refusal"))])
    })).toBe(5);
    expect(refusal.stdout).toEqual([]);
    expect(refusal.stderr).toEqual(["The model declined to produce a recommendation."]);

    const runLimit = capture();
    expect(await runRecommendCommand(args(), runLimit.out, runLimit.err, {
      getApiKey: () => "fabricated-key",
      createModel: () => new ScriptedModel([modelError(new ModelTimeoutError({ timeoutMs: 1_000 }))])
    })).toBe(5);
    expect(runLimit.stdout).toEqual([]);
    expect(runLimit.stderr).toEqual(["The recommendation run reached its limit."]);

    const controller = new AbortController();
    const activeCancellation = capture();
    let modelStartedResolve: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => { modelStartedResolve = resolve; });
    const activeModel = new ScriptedModel([modelResponder((call) => new Promise((_, reject) => {
      const signal = call.request.signal;
      modelStartedResolve?.();
      if (signal === undefined) {
        reject(new Error("missing model signal"));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }))]);
    const pending = runRecommendCommand(args(), activeCancellation.out, activeCancellation.err, {
      signal: controller.signal,
      getApiKey: () => "fabricated-key",
      createModel: () => activeModel
    });
    await modelStarted;
    controller.abort();
    expect(await pending).toBe(130);
    expect(activeCancellation.stdout).toEqual([]);
    expect(activeCancellation.stderr).toEqual(["Recommendation was cancelled."]);
    expect(activeModel.calls.length).toBeGreaterThan(0);
  });

  it("does not expose model-key or environment canaries in errors", async () => {
    const canary = "fake-secret-and-health-canary";
    const io = capture();
    expect(await runRecommendCommand(args(), io.out, io.err, {
      getApiKey: () => canary,
      createModel: () => { throw new Error(canary); }
    })).toBe(5);
    expect(io.stdout).toEqual([]);
    expect(JSON.stringify(io.stderr)).not.toContain(canary);
  });

  it("runs the built root CLI offline with a policy block and no provider import", () => {
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('@ahp/oura-client') || specifier === '@ahp/health-agent') throw new Error('agent or provider imported');
        return next(specifier, context);
      }});
      const { runCli } = await import('./apps/cli/dist/main.js');
      process.exitCode = await runCli(['recommend'],
        text => process.stdout.write(text + '\\n'),
        text => process.stderr.write(text + '\\n'),
        { getApiKey: () => { throw new Error('key read'); }, createModel: () => { throw new Error('model created'); } });
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "", OURA_CLIENT_SECRET: "fake-provider-canary" }
    });
    expect(child.status).toBe(6);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("POLICY_BLOCKED");
    expect(child.stderr).not.toContain("canary");
    const rootScript = spawnSync("npm", ["run", "--silent", "health", "--", "recommend"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "", OURA_CLIENT_SECRET: "fake-provider-canary" }
    });
    expect(rootScript.status).toBe(6);
    expect(rootScript.stdout).toBe("");
    expect(rootScript.stderr).toContain("POLICY_BLOCKED");
  });

  it("runs the built CLI artifact through a fake model with no Oura import", () => {
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('@ahp/oura-client')) throw new Error('provider imported');
        return next(specifier, context);
      }});
      const { runCli } = await import('./apps/cli/dist/main.js');
      const { replayScenario } = await import('./services/health-agent/dist/evals/replay.js');
      const { ScriptedModel, assistantMessage, functionCall } = await import('@openai/agents/testing');
      const draft = (await replayScenario('well_recovered_runner')).draft;
      const model = new ScriptedModel([
        [functionCall('get_user_profile', {}, {callId:'profile'})],
        [functionCall('get_current_context', {}, {callId:'context'})],
        [functionCall('get_sleep_history', {days:14}, {callId:'sleep'})],
        [functionCall('get_recovery_history', {days:14}, {callId:'recovery'})],
        [functionCall('get_recent_training', {days:14}, {callId:'training'})],
        [assistantMessage(JSON.stringify(draft))]
      ]);
      process.exitCode = await runCli(['recommend', '--synthetic', 'well_recovered_runner', '--model', 'fake-model', '--json'],
        text => process.stdout.write(text + '\\n'),
        text => process.stderr.write(text + '\\n'),
        { getApiKey: () => 'fake-key', createModel: () => model });
      model.assertComplete();
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "", OURA_CLIENT_SECRET: "fake-provider-canary" }
    });
    expect(child.status).toBe(0);
    expect(child.stderr).not.toContain("canary");
    expect(JSON.parse(child.stdout)).toMatchObject({ schemaVersion: 1, mode: "synthetic" });
    expect(child.stdout).not.toContain("canary");
  });
});
