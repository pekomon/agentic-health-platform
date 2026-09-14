import { describe, expect, it } from "vitest";

import { CurrentContextResultSchema, UserProfileResultSchema } from "@ahp/health-domain";
import {
  DEFAULT_HISTORY_DAYS,
  SleepHistoryToolResultSchema,
  createSyntheticHealthTools,
  expectedFixtureDates
} from "../src/index.js";
import { SCENARIO_IDS, loadFixture } from "./helpers.js";

describe("synthetic semantic health readers", () => {
  it.each(SCENARIO_IDS)("serves schema-valid profile, context, and histories for %s", (scenarioId) => {
    const fixture = loadFixture(scenarioId);
    const readers = createSyntheticHealthTools(fixture);

    expect(UserProfileResultSchema.safeParse(readers.get_user_profile()).success).toBe(true);
    expect(CurrentContextResultSchema.safeParse(readers.get_current_context()).success).toBe(true);
    expect(readers.get_sleep_history().days.map((day) => day.date)).toEqual(expectedFixtureDates(fixture));
    expect(readers.get_recovery_history().days.map((day) => day.date)).toEqual(expectedFixtureDates(fixture));
    expect(readers.get_recent_training().days.map((day) => day.date)).toEqual(expectedFixtureDates(fixture));
  });

  it("uses seven days by default and supports explicit one and fourteen day windows", () => {
    const fixture = loadFixture();
    const readers = createSyntheticHealthTools(fixture);

    expect(readers.get_sleep_history().days).toHaveLength(DEFAULT_HISTORY_DAYS);
    expect(readers.get_sleep_history({ days: 1 }).days.map((day) => day.date)).toEqual(["2026-01-14"]);
    expect(readers.get_sleep_history({ days: 14 }).days.map((day) => day.date)).toEqual(expectedFixtureDates(fixture, 14));
  });

  it("uses the context local date when an equivalent clock offset names the previous UTC date", () => {
    const fixture = loadFixture();
    const equivalentOffset = structuredClone(fixture);
    equivalentOffset.context = { ...equivalentOffset.context, localTime: "2026-01-14T00:30:00+02:00" };
    equivalentOffset.clock = "2026-01-13T22:30:00Z";
    const readers = createSyntheticHealthTools(equivalentOffset);

    expect(readers.get_sleep_history({ days: 1 }).window).toEqual({ startDate: "2026-01-14", endDate: "2026-01-14" });
    expect(readers.get_sleep_history({ days: 7 }).days.at(-1)?.date).toBe("2026-01-14");
  });

  it("preserves missing data as missing evidence instead of fabricated observations", () => {
    const readers = createSyntheticHealthTools(loadFixture("missing_data"));

    const sleep = readers.get_sleep_history({ days: 7 });
    const recovery = readers.get_recovery_history({ days: 7 });
    const training = readers.get_recent_training({ days: 7 });

    expect(sleep.status).toBe("unavailable");
    expect(sleep.missing).toHaveLength(7);
    expect(sleep.days.every((day) => day.duration.status === "missing")).toBe(true);
    expect(recovery.missing).toHaveLength(14);
    expect(training.missing).toHaveLength(7);
    expect(training.days.every((day) => day.status === "unavailable" && day.sessions.length === 0)).toBe(true);
  });

  it("generates deterministic input and missing evidence IDs", () => {
    const readers = createSyntheticHealthTools(loadFixture("well_recovered_runner"));

    const firstProfile = readers.get_user_profile();
    const secondProfile = readers.get_user_profile();
    const firstContext = readers.get_current_context();
    const secondContext = readers.get_current_context();

    expect(secondProfile.observations.map((observation) => observation.id)).toEqual(firstProfile.observations.map((observation) => observation.id));
    expect(secondProfile.missing.map((entry) => entry.id)).toEqual(firstProfile.missing.map((entry) => entry.id));
    expect(secondContext.observations.map((observation) => observation.id)).toEqual(firstContext.observations.map((observation) => observation.id));
    expect(secondContext.missing.map((entry) => entry.id)).toEqual(firstContext.missing.map((entry) => entry.id));
  });

  it("rejects fixtures whose observations are not synthetic fixture data", () => {
    const fixture = loadFixture();
    const bad = structuredClone(fixture);
    const observation = bad.sleep[0]?.duration.status === "available" ? bad.sleep[0].duration.observation : null;
    if (observation === null) throw new Error("fixture shape changed");
    observation.source = { kind: "oura", channel: "rest", datasetId: null };

    expect(() => createSyntheticHealthTools(bad)).toThrow();
  });

  it("rejects invalid days arguments before producing a history", () => {
    const readers = createSyntheticHealthTools(loadFixture());

    expect(() => readers.get_sleep_history({ days: 0 })).toThrow(RangeError);
    expect(() => readers.get_sleep_history({ days: 15 })).toThrow(RangeError);
    expect(SleepHistoryToolResultSchema.safeParse(readers.get_sleep_history({ days: 7 })).success).toBe(true);
  });
});
