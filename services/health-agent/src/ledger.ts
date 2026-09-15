import {
  type CurrentContextResult,
  type DataSource,
  type Evidence,
  type MissingEvidence,
  type UserProfileResult
} from "@ahp/health-domain";
import {
  evidenceFromToolResult,
  validateToolResult,
  type HealthToolName,
  type HealthToolResult
} from "@ahp/health-tools";

export type LedgerErrorCode = "INVALID_TOOL_RESULT" | "CONFLICTING_EVIDENCE";

export type LedgerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: LedgerErrorCode } };

export type DeliveredToolCall = {
  name: HealthToolName;
  result: unknown;
};

export type LedgerSnapshot = {
  evidence: ReadonlyMap<string, Evidence>;
  calls: ReadonlySet<HealthToolName>;
  profile: UserProfileResult | null;
  context: CurrentContextResult | null;
};

function evidenceId(evidence: Evidence): string {
  return evidence.kind === "observation" ? evidence.observation.id : evidence.id;
}

function sourceKey(source: DataSource): string {
  return JSON.stringify([source.kind, source.channel, source.datasetId]);
}

/**
 * Opaque evidence IDs are provenance handles, not a conflict boundary. A
 * source record and metric identify one semantic observation even if a later
 * tool response assigns it a different valid opaque ID.
 */
function semanticKey(evidence: Evidence): string {
  if (evidence.kind === "missing") {
    return JSON.stringify(["missing", sourceKey(evidence.source), evidence.metric, evidence.date]);
  }
  const observation = evidence.observation;
  return JSON.stringify([
    "observation",
    sourceKey(observation.source),
    observation.metric,
    observation.sourceRecordId ?? observation.sourceField,
    observation.effectiveDate
  ]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class EvidenceLedger {
  readonly #evidence = new Map<string, Evidence>();
  readonly #semanticEvidence = new Map<string, Evidence>();
  readonly #calls = new Set<HealthToolName>();
  #profile: UserProfileResult | null = null;
  #context: CurrentContextResult | null = null;

  record(call: DeliveredToolCall): LedgerResult<void> {
    let result: HealthToolResult;
    try {
      result = validateToolResult(call.name, call.result);
    } catch {
      return { ok: false, error: { code: "INVALID_TOOL_RESULT" } };
    }

    const additions = evidenceFromToolResult(result).map(clone);
    const pendingById = new Map(this.#evidence);
    const pendingBySemanticKey = new Map(this.#semanticEvidence);
    for (const entry of additions) {
      const id = evidenceId(entry);
      const key = semanticKey(entry);
      const current = pendingById.get(id);
      const semanticCurrent = pendingBySemanticKey.get(key);
      if ((current !== undefined && JSON.stringify(current) !== JSON.stringify(entry)) ||
        (semanticCurrent !== undefined && JSON.stringify(semanticCurrent) !== JSON.stringify(entry))) {
        return { ok: false, error: { code: "CONFLICTING_EVIDENCE" } };
      }
      pendingById.set(id, entry);
      pendingBySemanticKey.set(key, entry);
    }

    for (const entry of additions) {
      this.#evidence.set(evidenceId(entry), entry);
      this.#semanticEvidence.set(semanticKey(entry), entry);
    }
    this.#calls.add(call.name);
    if (call.name === "get_user_profile") this.#profile = clone(result as UserProfileResult);
    if (call.name === "get_current_context") this.#context = clone(result as CurrentContextResult);
    return { ok: true, value: undefined };
  }

  snapshot(): LedgerSnapshot {
    return {
      evidence: new Map([...this.#evidence].map(([id, entry]) => [id, clone(entry)])),
      calls: new Set(this.#calls),
      profile: this.#profile === null ? null : clone(this.#profile),
      context: this.#context === null ? null : clone(this.#context)
    };
  }

  clear(): void {
    this.#evidence.clear();
    this.#semanticEvidence.clear();
    this.#calls.clear();
    this.#profile = null;
    this.#context = null;
  }
}

export function isMissingEvidence(evidence: Evidence): evidence is MissingEvidence {
  return evidence.kind === "missing";
}
