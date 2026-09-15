import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateFixture, type SyntheticFixture } from "@ahp/health-domain";

export const SCENARIO_IDS = [
  "well_recovered_runner",
  "poor_sleep_low_recovery",
  "strength_goal_good_recovery",
  "late_evening_low_recovery",
  "missing_data"
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export function fixtureRootFor(moduleDirectory: string): string {
  const candidates = [
    resolve(moduleDirectory, "../../../fixtures/synthetic"),
    resolve(moduleDirectory, "../../../../fixtures/synthetic")
  ];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (root === undefined) throw new Error("SYNTHETIC_FIXTURES_UNAVAILABLE");
  return root;
}

const fixturesRoot = fixtureRootFor(import.meta.dirname);

export function loadScenarioFixture(scenarioId: ScenarioId): SyntheticFixture {
  const raw = JSON.parse(readFileSync(resolve(fixturesRoot, `${scenarioId}.json`), "utf8")) as unknown;
  const parsed = validateFixture(raw);
  if (!parsed.ok) throw new Error("INVALID_SYNTHETIC_FIXTURE");
  return parsed.value;
}
