import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  InstantSchema,
  LocalDateSchema,
  SleepDurationObservationSchema,
  SleepDurationStateSchema,
  validateSleepDurationState,
  type SleepDurationState
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const packageRoot = resolve(__dirname, "..");

const fixture = JSON.parse(
  readFileSync(
    resolve(repoRoot, "fixtures/synthetic/sleep_observation.json"),
    "utf8"
  )
) as unknown;

function deriveObservationId(input: {
  source: { kind: string; channel: string; datasetId: string | null };
  sourceRecordId: string | null;
  metric: string;
  effectiveDate: string;
  sourceField: string;
}): string {
  const tuple = [
    input.source.kind,
    input.source.channel,
    input.source.datasetId,
    input.sourceRecordId,
    input.metric,
    input.effectiveDate,
    input.sourceField
  ];

  return `obs_${createHash("sha256")
    .update(JSON.stringify(tuple))
    .digest("hex")}`;
}

function validObservation(): Record<string, unknown> {
  return {
    id: "obs_1a0a7683ee795393dbd7cd5216d9dcf2965dbf5810ce914485cf2a3b72535a78",
    metric: "sleep.duration",
    value: 28_800,
    unit: "seconds",
    source: {
      kind: "synthetic",
      channel: "fixture",
      datasetId: "slice-1-synthetic-sleep"
    },
    effectiveDate: "2024-02-29",
    period: {
      start: "2024-02-28T22:15:00+02:00",
      end: "2024-02-29T06:15:00+02:00"
    },
    recordedAt: "2024-02-29T06:20:00+02:00",
    sourceRecordId: "synthetic-sleep-2024-02-29",
    sourceField: "sleep.duration",
    derivation: null
  };
}

function validState(): Record<string, unknown> {
  return {
    status: "available",
    observation: validObservation()
  };
}

describe("sleep duration observation validation", () => {
  it("accepts the synthetic fixture and preserves value and source", () => {
    const parsed = SleepDurationStateSchema.parse(fixture);

    expect(parsed.status).toBe("available");
    expect(parsed.observation.value).toBe(28_800);
    expect(parsed.observation.source).toEqual({
      kind: "synthetic",
      channel: "fixture",
      datasetId: "slice-1-synthetic-sleep"
    });
  });

  it("matches the producer-derived observation ID", () => {
    const parsed = SleepDurationStateSchema.parse(fixture);

    expect(
      deriveObservationId({
        source: parsed.observation.source,
        sourceRecordId: parsed.observation.sourceRecordId,
        metric: parsed.observation.metric,
        effectiveDate: parsed.observation.effectiveDate,
        sourceField: parsed.observation.sourceField
      })
    ).toBe(parsed.observation.id);
  });

  it("keeps the selected SHA-256 tuple derivation stable", () => {
    expect(
      deriveObservationId({
        source: {
          kind: "synthetic",
          channel: "fixture",
          datasetId: "slice-1-synthetic-sleep"
        },
        sourceRecordId: "synthetic-sleep-2024-02-29",
        metric: "sleep.duration",
        effectiveDate: "2024-02-29",
        sourceField: "sleep.duration"
      })
    ).toBe(
      "obs_1a0a7683ee795393dbd7cd5216d9dcf2965dbf5810ce914485cf2a3b72535a78"
    );
  });

  it("accepts a valid leap day and rejects an impossible calendar date", () => {
    expect(LocalDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(LocalDateSchema.safeParse("2023-02-29").success).toBe(false);
  });

  it("requires an instant timezone or offset", () => {
    expect(InstantSchema.safeParse("2024-02-29T06:15:00+02:00").success).toBe(
      true
    );
    expect(InstantSchema.safeParse("2024-02-29T06:15:00").success).toBe(false);
  });

  it("accepts an available zero-second duration", () => {
    const observation = {
      ...validObservation(),
      value: 0,
      period: {
        start: "2024-02-29T06:15:00+02:00",
        end: "2024-02-29T06:15:00+02:00"
      }
    };

    expect(
      SleepDurationStateSchema.safeParse({
        status: "available",
        observation
      }).success
    ).toBe(true);
  });

  it("accepts an explicit missing state without synthesizing an observation", () => {
    const parsed = SleepDurationStateSchema.parse({
      status: "missing",
      reason: "not_recorded"
    });

    expect(parsed).toEqual({ status: "missing", reason: "not_recorded" });
  });

  it.each([
    ["negative", -1],
    ["string", "28800"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("rejects %s duration values", (_label, value) => {
    expect(
      SleepDurationObservationSchema.safeParse({
        ...validObservation(),
        value
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      SleepDurationStateSchema.safeParse({
        ...validState(),
        extra: "not allowed"
      }).success
    ).toBe(false);
  });

  it("rejects invalid DataSource pairings", () => {
    const observation = {
      ...validObservation(),
      source: {
        kind: "synthetic",
        channel: "rest",
        datasetId: "slice-1-synthetic-sleep"
      }
    };

    expect(SleepDurationObservationSchema.safeParse(observation).success).toBe(
      false
    );
  });

  it("rejects missing provenance", () => {
    const { source: _source, ...observation } = validObservation();

    expect(SleepDurationObservationSchema.safeParse(observation).success).toBe(
      false
    );
  });

  it("rejects duration exceeding its observation period", () => {
    const observation = {
      ...validObservation(),
      value: 3_601,
      period: {
        start: "2024-02-29T01:00:00Z",
        end: "2024-02-29T02:00:00Z"
      }
    };

    expect(SleepDurationObservationSchema.safeParse(observation).success).toBe(
      false
    );
  });

  it("does not parse a missing value as an available value", () => {
    const missing = SleepDurationStateSchema.parse({
      status: "missing",
      reason: "not_recorded"
    });

    expect(missing.status).toBe("missing");
    expect("observation" in missing).toBe(false);
  });

  it("returns public diagnostics without canary input values", () => {
    const canary = "SECRET_CANARY_INPUT_VALUE";
    const result = validateSleepDurationState({
      ...validState(),
      canary
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(canary);
    if (!result.ok) {
      expect(result.issues.every((issue) => "path" in issue && "code" in issue))
        .toBe(true);
    }
  });

  it("validates through the exported helper", () => {
    const result = validateSleepDurationState(fixture);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value: SleepDurationState = result.value;
      expect(value.status).toBe("available");
    }
  });
});

describe("public package surface", () => {
  it("compiles a consumer import from package exports", () => {
    execFileSync("npm", ["run", "build", "--workspace", "@ahp/health-domain"], {
      cwd: repoRoot,
      stdio: "pipe"
    });

    const consumerRoot = mkdtempSync(join(tmpdir(), "ahp-consumer-"));
    const nodeModulesScope = join(consumerRoot, "node_modules", "@ahp");
    mkdirSync(nodeModulesScope, { recursive: true });
    symlinkSync(packageRoot, join(nodeModulesScope, "health-domain"), "dir");
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify({ type: "module" })
    );
    writeFileSync(
      join(consumerRoot, "consumer.ts"),
      [
        'import { SleepDurationStateSchema, validateSleepDurationState, type MetricState, type Observation, type SleepDurationState } from "@ahp/health-domain";',
        'const value: SleepDurationState = SleepDurationStateSchema.parse({ status: "missing", reason: "not_recorded" });',
        "const result = validateSleepDurationState(value);",
        "if (!result.ok) { throw new Error('unexpected validation failure'); }",
        "const genericObservation: Observation<number> = {",
        '  id: "obs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",',
        '  metric: "future.metric",',
        "  value: 7,",
        '  unit: "score",',
        '  source: { kind: "user", channel: "input", datasetId: null },',
        '  effectiveDate: "2024-02-29",',
        "  period: null,",
        "  recordedAt: null,",
        '  sourceRecordId: "future.metric",',
        '  sourceField: "future.metric",',
        "  derivation: null",
        "};",
        'const genericState: MetricState<number> = { status: "available", observation: genericObservation };',
        'if (genericState.observation.metric !== "future.metric") { throw new Error("generic metric was narrowed"); }'
      ].join("\n")
    );
    writeFileSync(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true
          },
          files: ["consumer.ts"]
        },
        null,
        2
      )
    );

    execFileSync(resolve(repoRoot, "node_modules/.bin/tsc"), ["-p", consumerRoot], {
      cwd: consumerRoot,
      stdio: "pipe"
    });
  });
});
