import type { TranscriptLanguage } from "./transcripts";

export type EditorialAiDraftScheduleSource = {
  episode_id: string;
  source_language: TranscriptLanguage;
  show_language: string;
};

export type EditorialAiDraftGenerationResult =
  | "failed"
  | "ready"
  | "skipped";

export async function scheduleEditorialAiDrafts<
  Source extends EditorialAiDraftScheduleSource
>({
  enabled,
  maximumAttempts,
  loadSources,
  generate,
  scanFailedEvent,
  generationFailedEvent,
  logError = (event) => console.error(JSON.stringify(event))
}: {
  enabled: boolean;
  maximumAttempts: number;
  loadSources: () => Promise<{ results: Source[] }>;
  generate: (
    source: Source,
    outputLanguage: TranscriptLanguage
  ) => Promise<EditorialAiDraftGenerationResult>;
  scanFailedEvent: string;
  generationFailedEvent: string;
  logError?: (event: Record<string, unknown>) => void;
}): Promise<number> {
  if (!enabled) return 0;
  let sources: Source[];
  try {
    sources = (await loadSources()).results;
  } catch (error) {
    logError({
      level: "error",
      event: scanFailedEvent,
      errorName: error instanceof Error ? error.name : "UnknownError"
    });
    return 0;
  }

  let generated = 0;
  let attempted = 0;
  for (const source of sources) {
    const outputLanguages = new Set<TranscriptLanguage>([
      source.source_language
    ]);
    if (source.show_language === "en" || source.show_language === "es") {
      outputLanguages.add(source.show_language);
    }
    for (const outputLanguage of outputLanguages) {
      if (attempted >= maximumAttempts) return generated;
      try {
        const result = await generate(source, outputLanguage);
        if (result !== "skipped") attempted += 1;
        if (result === "ready") generated += 1;
      } catch (error) {
        logError({
          level: "error",
          event: generationFailedEvent,
          episodeId: source.episode_id,
          outputLanguage,
          errorName: error instanceof Error ? error.name : "UnknownError"
        });
      }
    }
  }
  return generated;
}
