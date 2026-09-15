import { createOpenAIModel, DEFAULT_MODEL_CONFIG, recommendSynthetic } from "../src/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RECOMMENDATION_INSTRUCTIONS } from "../src/instructions.js";
import { evaluateScenario } from "./assertions.js";
import { SCENARIO_IDS } from "./scenarios.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const modelId = argument("--model");
const repetitions = Number(argument("--repetitions") ?? "1");
const apiKey = process.env.OPENAI_API_KEY;
if (modelId === undefined || !Number.isInteger(repetitions) || repetitions < 1 || apiKey === undefined) {
  throw new Error("Usage: npm run eval:synthetic -- --model <id> --repetitions <positive integer> (requires OPENAI_API_KEY)");
}

const model = createOpenAIModel({ modelId, ...DEFAULT_MODEL_CONFIG }, apiKey);
const results = [];
const packageLockHash = createHash("sha256").update(readFileSync("package-lock.json")).digest("hex");
const instructionHash = createHash("sha256").update(RECOMMENDATION_INSTRUCTIONS).digest("hex");
const modelHash = createHash("sha256").update(modelId).digest("hex");
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (const scenarioId of SCENARIO_IDS) {
    const toolSequence: string[] = [];
    const result = await recommendSynthetic({ scenarioId, modelId }, { model, onToolCall: (name) => toolSequence.push(name) });
    // Structural checks are already performed by the finalizer. The human rubric
    // remains required for free-text claim entailment.
    const report = evaluateScenario({ fixtureId: scenarioId, deliveredCalls: toolSequence, draft: null, finalResult: result });
    results.push({ scenarioId, repetition, ok: result.ok && report.passed, error: result.ok ? null : result.error.code, toolSequence, checks: report.checks });
  }
}
process.stdout.write(`${JSON.stringify({ modelId, modelHash, repetitions, packageLockHash, instructionHash, scenarioVersion: 1, results })}\n`);
