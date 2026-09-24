import { parseArgs } from "node:util";

import {
  createOpenAIModel,
  DEFAULT_MODEL_CONFIG,
  isSyntheticScenarioId,
  recommendSynthetic,
  type RecommendationErrorCode,
  type SyntheticRecommendationRequest
} from "@ahp/health-agent";
import { DailyTrainingRecommendationSchema } from "@ahp/health-domain";

import { formatSyntheticRecommendation } from "./format.js";
import { RECOMMEND_POLICY_TEXT } from "./policy.js";

type Output = (text: string) => void;
type Model = Parameters<typeof recommendSynthetic>[1]["model"];
export type RecommendCommandDependencies = {
  getApiKey?: () => string | undefined;
  createModel?: (modelId: string, apiKey: string) => Model;
  recommend?: typeof recommendSynthetic;
  signal?: AbortSignal;
};

const USAGE = "Usage: health recommend --synthetic <scenario-id> --model <id> [--json]";

function errorText(code: RecommendationErrorCode): string {
  const messages: Record<RecommendationErrorCode, string> = {
    INVALID_OUTPUT: "The model did not produce a valid recommendation.",
    UNGROUNDED_EVIDENCE: "The recommendation cited unavailable evidence.",
    CONSTRAINT_VIOLATION: "The recommendation violated a training constraint.",
    CONFLICTING_EVIDENCE: "The recommendation contained conflicting evidence.",
    INSUFFICIENT_CONTEXT: "The recommendation lacks required context.",
    MODEL_UNAVAILABLE: "The model is unavailable.",
    MODEL_REFUSAL: "The model declined to produce a recommendation.",
    RUN_LIMIT: "The recommendation run reached its limit.",
    POLICY_BLOCKED: RECOMMEND_POLICY_TEXT
  };
  return messages[code];
}

type Parsed = { scenarioId: SyntheticRecommendationRequest["scenarioId"]; modelId: string; json: boolean } | "blocked" | null;

function parseRecommendArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0) return "blocked";
  if (argv.length > 6 || argv.some((argument) => argument.length > 256)) return null;
  try {
    const parsed = parseArgs({
      args: [...argv], allowPositionals: false, strict: true, tokens: true,
      options: {
        synthetic: { type: "string" },
        model: { type: "string" },
        json: { type: "boolean", default: false }
      }
    });
    const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (new Set(names).size !== names.length) return null;
    const scenarioId = parsed.values.synthetic;
    const modelId = parsed.values.model;
    if (scenarioId === undefined || modelId === undefined) return null;
    if (!isSyntheticScenarioId(scenarioId)) return null;
    if (!/^[^\s\x00-\x1f\x7f]{1,128}$/.test(modelId)) return null;
    return { scenarioId, modelId, json: parsed.values.json ?? false };
  } catch {
    return null;
  }
}

export async function runRecommendCommand(
  argv: readonly string[],
  stdout: Output,
  stderr: Output,
  dependencies: RecommendCommandDependencies = {}
): Promise<number> {
  const parsed = parseRecommendArgs(argv);
  if (parsed === "blocked") { stderr(RECOMMEND_POLICY_TEXT); return 6; }
  if (parsed === null) { stderr(USAGE); return 2; }
  if (dependencies.signal?.aborted) { stderr("Recommendation was cancelled."); return 130; }
  let apiKey: string | undefined;
  try { apiKey = (dependencies.getApiKey ?? (() => process.env.OPENAI_API_KEY))(); }
  catch { stderr("OPENAI_API_KEY is unavailable for a synthetic model run."); return 2; }
  if (apiKey === undefined || apiKey.length === 0) {
    stderr("OPENAI_API_KEY is required for a synthetic model run.");
    return 2;
  }

  try {
    const model = (dependencies.createModel ?? ((modelId, key) => createOpenAIModel({ modelId, ...DEFAULT_MODEL_CONFIG }, key)))(parsed.modelId, apiKey);
    const result = await (dependencies.recommend ?? recommendSynthetic)(
      { scenarioId: parsed.scenarioId, modelId: parsed.modelId },
      { model, ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }) }
    );
    if (dependencies.signal?.aborted) { stderr("Recommendation was cancelled."); return 130; }
    if (!result.ok) {
      stderr(errorText(result.error.code));
      return result.error.code === "POLICY_BLOCKED" ? 6 : 5;
    }
    if (!DailyTrainingRecommendationSchema.safeParse(result.value).success) {
      stderr(errorText("INVALID_OUTPUT"));
      return 5;
    }
    stdout(parsed.json
      ? JSON.stringify({ schemaVersion: 1, mode: "synthetic", recommendation: result.value })
      : formatSyntheticRecommendation(parsed.scenarioId, result.value));
    return 0;
  } catch {
    if (dependencies.signal?.aborted) { stderr("Recommendation was cancelled."); return 130; }
    stderr(errorText("MODEL_UNAVAILABLE"));
    return 5;
  }
}
