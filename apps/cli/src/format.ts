import type { DailyTrainingRecommendation, DataSource, Evidence } from "@ahp/health-domain";

function sourceText(source: DataSource): string {
  return `${source.kind}/${source.channel}${source.datasetId === null ? "" : ` (${source.datasetId})`}`;
}

function evidenceText(entry: Evidence): string {
  if (entry.kind === "missing") {
    return `${entry.id}: ${entry.metric}; date ${entry.date ?? "null"}; source ${sourceText(entry.source)}; missing ${entry.reason}`;
  }
  const observation = entry.observation;
  const value = typeof observation.value === "string" || typeof observation.value === "number"
    ? String(observation.value)
    : JSON.stringify(observation.value);
  return `${observation.id}: ${observation.metric}=${value}${observation.unit === null ? "" : ` ${observation.unit}`}; date ${observation.effectiveDate}; source ${sourceText(observation.source)}`;
}

export function formatSyntheticRecommendation(
  scenarioId: string,
  recommendation: DailyTrainingRecommendation
): string {
  return [
    `SYNTHETIC training recommendation — fabricated scenario ${scenarioId}`,
    `Activity: ${recommendation.activity}`,
    `Intensity: ${recommendation.intensity}`,
    ...(recommendation.durationMinutes === undefined ? [] : [`Duration: ${recommendation.durationMinutes} minutes`]),
    `Rationale: ${recommendation.rationale}`,
    "Claims:",
    ...recommendation.claims.map((claim) => `- ${claim.text} [${claim.evidenceIds.join(", ")}]`),
    "Evidence:",
    ...recommendation.evidence.map((entry) => `- ${evidenceText(entry)}`),
    `Confidence: ${recommendation.confidence}`,
    "Limitations:",
    ...(recommendation.limitations.length === 0
      ? ["- none"]
      : recommendation.limitations.map((entry) => `- ${evidenceText(entry)}`))
  ].join("\n");
}
