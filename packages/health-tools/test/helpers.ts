import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateFixture, type SyntheticFixture } from "@ahp/health-domain";

export const SCENARIO_IDS = [
  "well_recovered_runner",
  "poor_sleep_low_recovery",
  "strength_goal_good_recovery",
  "late_evening_low_recovery",
  "missing_data"
] as const;

const fixturesRoot = resolve(import.meta.dirname, "../../../fixtures/synthetic");

export function loadFixture(scenarioId = "well_recovered_runner"): SyntheticFixture {
  const fixture = JSON.parse(readFileSync(resolve(fixturesRoot, `${scenarioId}.json`), "utf8")) as unknown;
  const result = validateFixture(fixture);
  if (!result.ok) throw new Error(`invalid fixture: ${scenarioId}`);
  return result.value;
}

