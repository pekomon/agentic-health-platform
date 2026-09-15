import { describe, expect, it } from "vitest";

import { finalizeRecommendation } from "../src/finalize.js";
import { EvidenceLedger } from "../src/ledger.js";
import { replayScenario } from "../evals/replay.js";

function ledgerFor(calls: Awaited<ReturnType<typeof replayScenario>>["calls"]): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (const call of calls) expect(ledger.record(call)).toMatchObject({ ok: true });
  return ledger;
}

describe("recommendation grounding finalizer", () => {
  it("rejects evidence that was not delivered to the model", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const draft = structuredClone(replay.draft);
    draft.rationaleClaims[0]!.evidenceIds[0] = "obs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(finalizeRecommendation(draft, ledgerFor(replay.calls).snapshot())).toEqual({ ok: false, error: { code: "UNGROUNDED_EVIDENCE" } });
  });

  it("rejects an allowed ID when it was not delivered in this request", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const otherScenario = await replayScenario("poor_sleep_low_recovery");
    const draft = structuredClone(replay.draft);
    const sleepCall = otherScenario.calls.find((call) => call.name === "get_sleep_history");
    const sleepResult = sleepCall?.result as { days?: Array<{ duration?: { observation?: { id: string } } }> };
    const knownButUndeliveredId = sleepResult.days?.[0]?.duration?.observation?.id;
    if (knownButUndeliveredId === undefined) throw new Error("missing known sleep evidence");
    draft.rationaleClaims[0]!.evidenceIds[0] = knownButUndeliveredId;
    expect(finalizeRecommendation(draft, ledgerFor(replay.calls).snapshot())).toEqual({ ok: false, error: { code: "UNGROUNDED_EVIDENCE" } });
  });

  it("does not permit a model to replace delivered evidence values", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const ledger = ledgerFor(replay.calls);
    const before = ledger.snapshot();
    const result = finalizeRecommendation(replay.draft, before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outputObservation = result.value.evidence.find((entry) => entry.kind === "observation");
    if (outputObservation?.kind !== "observation") throw new Error("expected observation");
    outputObservation.observation.value = "tampered" as never;
    const original = before.evidence.get(outputObservation.observation.id);
    expect(original).not.toEqual(outputObservation);
  });

  it("rejects malformed claims, zones, wrong activities, excess time, and absent retrieval", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const cases: readonly [unknown, string][] = [
      [{ ...replay.draft, rationaleClaims: [{ text: "uncited", evidenceIds: [] }] }, "INVALID_OUTPUT"],
      [{ ...replay.draft, targetHeartRateZone: { minZone: 1, maxZone: 2 } }, "INVALID_OUTPUT"],
      [{ ...replay.draft, activity: "CYCLING", intensity: "EASY" }, "CONSTRAINT_VIOLATION"],
      [{ ...replay.draft, durationMinutes: 46 }, "CONSTRAINT_VIOLATION"]
    ];
    for (const [draft, code] of cases) expect(finalizeRecommendation(draft, ledgerFor(replay.calls).snapshot())).toEqual({ ok: false, error: { code } });
    const withoutContext = ledgerFor(replay.calls.filter((call) => call.name !== "get_current_context"));
    expect(finalizeRecommendation(replay.draft, withoutContext.snapshot())).toEqual({ ok: false, error: { code: "INSUFFICIENT_CONTEXT" } });
  });

  it("requires sleep and recovery limitations when the history is unavailable", async () => {
    const replay = await replayScenario("missing_data");
    const draft = structuredClone(replay.draft);
    draft.limitationIds = [];
    expect(finalizeRecommendation(draft, ledgerFor(replay.calls).snapshot())).toEqual({ ok: false, error: { code: "INSUFFICIENT_CONTEXT" } });
  });

  it("fails closed when repeated delivered evidence changes meaning", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const ledger = new EvidenceLedger();
    const call = replay.calls.find((candidate) => candidate.name === "get_sleep_history");
    if (call === undefined) throw new Error("missing sleep call");
    expect(ledger.record(call)).toMatchObject({ ok: true });
    const changed = structuredClone(call);
    const history = changed.result as { days: Array<{ duration: { status: string; observation?: { value: unknown } } }> };
    const observation = history.days[0]?.duration.observation;
    if (observation === undefined) throw new Error("missing observation");
    observation.id = "obs_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    observation.value = 1;
    expect(ledger.record(changed)).toEqual({ ok: false, error: { code: "CONFLICTING_EVIDENCE" } });
  });

  it("rejects contradictory semantic evidence within one delivered tool result", async () => {
    const replay = await replayScenario("missing_data");
    const ledger = new EvidenceLedger();
    const call = replay.calls.find((candidate) => candidate.name === "get_sleep_history");
    if (call === undefined) throw new Error("missing sleep call");
    const changed = structuredClone(call);
    const history = changed.result as { missing: Array<{ id: string; metric: string; date: string | null; reason: string }> };
    const existing = history.missing.find((entry) => entry.metric === "sleep.duration");
    if (existing === undefined) throw new Error("missing sleep limitation");
    history.missing.push({
      ...existing,
      id: "missing_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      reason: "provider_unavailable"
    });
    expect(ledger.record(changed)).toEqual({ ok: false, error: { code: "CONFLICTING_EVIDENCE" } });
  });

  it("enforces zero available time as REST only", async () => {
    const replay = await replayScenario("well_recovered_runner");
    const snapshot = ledgerFor(replay.calls).snapshot();
    if (snapshot.context === null) throw new Error("missing context");
    snapshot.context.context.availableMinutes = 0;
    expect(finalizeRecommendation(replay.draft, snapshot)).toEqual({ ok: false, error: { code: "CONSTRAINT_VIOLATION" } });
  });
});
