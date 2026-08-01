import type { TranscriptLanguage, VerifiedApprovedTranscript } from "./transcripts";
import {
  RequestValidationError,
  requiredText
} from "./validation";

export const AI_DRAFT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const MAXIMUM_AI_DRAFT_TRANSCRIPT_CHARACTERS = 80_000;
export const AI_DRAFT_LIMIT_PER_EPISODE_PER_ADMIN_PER_HOUR = 6;

const LANGUAGE_VALUES = new Set<TranscriptLanguage>(["en", "es"]);
export const MAXIMUM_AI_DRAFT_GROUNDING_ITEMS = 24;
export const MAXIMUM_AI_DRAFT_GROUNDING_NAME_CHARACTERS = 120;
export const MAXIMUM_AI_DRAFT_GROUNDING_EVIDENCE_CHARACTERS = 500;

export type AiDraftTranscriptProjection = {
  excerpt: string;
  includedCueCount: number;
  totalCueCount: number;
  truncated: boolean;
};

export type AiDraftGrounding = {
  namedEntities: Array<{ name: string; evidence: string }>;
  speakerAttributions: Array<{
    speakerLabel: string;
    evidence: string;
  }>;
};

export type AiDraftGroundingSource = {
  evidenceTexts: string[];
  confirmedSpeakerLabels?: string[];
};

export function aiDraftLanguage(
  value: unknown,
  field: string
): TranscriptLanguage {
  const language = requiredText(value, field, 2) as TranscriptLanguage;
  if (!LANGUAGE_VALUES.has(language)) {
    throw new RequestValidationError(`${field} must be en or es`);
  }
  return language;
}

export function projectTranscriptForAiDraft(
  transcript: VerifiedApprovedTranscript,
  {
    maximumCharacters = MAXIMUM_AI_DRAFT_TRANSCRIPT_CHARACTERS,
    includeCueIds = false
  }: {
    maximumCharacters?: number;
    includeCueIds?: boolean;
  } = {}
): AiDraftTranscriptProjection {
  if (
    !Number.isSafeInteger(maximumCharacters)
    || maximumCharacters < 4_000
    || maximumCharacters > MAXIMUM_AI_DRAFT_TRANSCRIPT_CHARACTERS
  ) {
    throw new RangeError("maximumCharacters is outside the supported range");
  }
  const lines = transcript.cues.map((cue) => {
    const speaker = cue.speakerLabel ? `${cue.speakerLabel}: ` : "";
    const identity = includeCueIds ? `${cue.id} @ ` : "";
    return `[${identity}${formatTimestamp(cue.startsAtMs)}] ${speaker}${cue.text}`;
  });
  const fullTranscript = lines.join("\n");
  if (fullTranscript.length <= maximumCharacters) {
    return {
      excerpt: fullTranscript,
      includedCueCount: lines.length,
      totalCueCount: lines.length,
      truncated: false
    };
  }

  const selected = new Set<number>();
  const segmentBudget = Math.floor((maximumCharacters - 500) / 3);
  collectForward(lines, 0, segmentBudget, selected);
  collectForward(
    lines,
    Math.max(0, Math.floor(lines.length / 2) - 1),
    segmentBudget,
    selected
  );
  collectBackward(lines, lines.length - 1, segmentBudget, selected);
  const indexes = [...selected].sort((left, right) => left - right);
  let excerpt = renderTranscriptSelection(lines, indexes);
  while (excerpt.length > maximumCharacters && indexes.length > 3) {
    indexes.splice(Math.floor(indexes.length / 2), 1);
    excerpt = renderTranscriptSelection(lines, indexes);
  }
  return {
    excerpt,
    includedCueCount: indexes.length,
    totalCueCount: lines.length,
    truncated: true
  };
}

export async function claimAiDraftGeneration(
  db: D1Database,
  {
    action,
    adminUserId,
    episodeId,
    metadata,
    limit = AI_DRAFT_LIMIT_PER_EPISODE_PER_ADMIN_PER_HOUR
  }: {
    action: string;
    adminUserId: string;
    episodeId: string;
    metadata: Record<string, unknown>;
    limit?: number;
  }
): Promise<boolean> {
  if (
    !/^[a-z][a-z0-9_.-]{2,80}$/.test(action)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100
  ) {
    throw new TypeError("AI draft claim configuration is invalid");
  }
  const result = await db
    .prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, ?, 'episode', ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM admin_audit_events
         WHERE target_type = 'episode'
           AND target_id = ?
           AND action = ?
           AND admin_user_id = ?
           AND occurred_at > datetime('now', '-1 hour')
       ) < ?`
    )
    .bind(
      `audit_${crypto.randomUUID().replace(/-/g, "")}`,
      adminUserId,
      action,
      episodeId,
      JSON.stringify(metadata),
      episodeId,
      action,
      adminUserId,
      limit
    )
    .run();
  return result.meta.changes === 1;
}

export function parseAiProviderJsonObject(
  value: unknown,
  maximumResponseCharacters = 20_000
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("AI draft provider response must be an object");
  }
  const response = (value as { response?: unknown }).response;
  let parsed: unknown;
  if (typeof response === "string") {
    if (
      response.length < 2
      || response.length > maximumResponseCharacters
    ) {
      throw new TypeError("AI draft provider response is invalid");
    }
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new TypeError("AI draft provider response is not valid JSON");
    }
  } else if (
    response
    && typeof response === "object"
    && !Array.isArray(response)
  ) {
    let serialized: string;
    try {
      serialized = JSON.stringify(response);
    } catch {
      throw new TypeError("AI draft provider response is invalid");
    }
    if (
      serialized.length < 2
      || serialized.length > maximumResponseCharacters
    ) {
      throw new TypeError("AI draft provider response is invalid");
    }
    parsed = response;
  } else {
    throw new TypeError("AI draft provider response is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("AI draft provider output must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function generatedAiText(
  value: unknown,
  field: string,
  maximumCharacters: number,
  { allowNewlines = true }: { allowNewlines?: boolean } = {}
): string {
  if (typeof value !== "string") {
    throw new TypeError(`AI draft provider ${field} must be text`);
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (
    !normalized
    || normalized.length > maximumCharacters
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u
      .test(normalized)
    || /<[^>]*>/u.test(normalized)
    || (!allowNewlines && normalized.includes("\n"))
  ) {
    throw new TypeError(`AI draft provider ${field} is invalid`);
  }
  return normalized;
}

export function validateAiDraftGrounding(
  value: unknown,
  source: AiDraftGroundingSource
): AiDraftGrounding {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray(source.evidenceTexts)
  ) {
    throw new TypeError("AI draft grounding is invalid");
  }
  const grounding = value as Record<string, unknown>;
  if (
    Object.keys(grounding).sort().join(",")
      !== "namedEntities,speakerAttributions"
    || !Array.isArray(grounding.namedEntities)
    || !Array.isArray(grounding.speakerAttributions)
    || grounding.namedEntities.length > MAXIMUM_AI_DRAFT_GROUNDING_ITEMS
    || grounding.speakerAttributions.length > MAXIMUM_AI_DRAFT_GROUNDING_ITEMS
  ) {
    throw new TypeError("AI draft grounding is invalid");
  }
  const evidenceTexts = source.evidenceTexts
    .map(normalizeGroundingText)
    .filter(Boolean);
  if (!evidenceTexts.length) {
    throw new TypeError("AI draft grounding source is invalid");
  }
  const confirmedSpeakerLabels = new Map<string, string>();
  for (const value of source.confirmedSpeakerLabels ?? []) {
    const label = generatedAiText(
      value,
      "confirmedSpeakerLabel",
      MAXIMUM_AI_DRAFT_GROUNDING_NAME_CHARACTERS,
      { allowNewlines: false }
    );
    confirmedSpeakerLabels.set(normalizeGroundingText(label), label);
  }

  const namedEntities: AiDraftGrounding["namedEntities"] = [];
  const seenEntities = new Set<string>();
  for (const [index, rawEntity] of grounding.namedEntities.entries()) {
    const entity = exactGroundingRecord(
      rawEntity,
      ["evidence", "name"],
      `namedEntities[${index}]`
    );
    const name = generatedAiText(
      entity.name,
      "grounding name",
      MAXIMUM_AI_DRAFT_GROUNDING_NAME_CHARACTERS,
      { allowNewlines: false }
    );
    const evidence = generatedAiText(
      entity.evidence,
      "grounding evidence",
      MAXIMUM_AI_DRAFT_GROUNDING_EVIDENCE_CHARACTERS,
      { allowNewlines: false }
    );
    const comparableName = normalizeGroundingText(name);
    const comparableEvidence = normalizeGroundingText(evidence);
    if (
      seenEntities.has(comparableName)
      || !comparableEvidence.includes(comparableName)
      || !evidenceTexts.some((text) => text.includes(comparableEvidence))
    ) {
      throw new TypeError("AI draft named-entity grounding is invalid");
    }
    seenEntities.add(comparableName);
    namedEntities.push({ name, evidence });
  }

  const speakerAttributions: AiDraftGrounding["speakerAttributions"] = [];
  const seenAttributions = new Set<string>();
  for (
    const [index, rawAttribution]
    of grounding.speakerAttributions.entries()
  ) {
    const attribution = exactGroundingRecord(
      rawAttribution,
      ["evidence", "speakerLabel"],
      `speakerAttributions[${index}]`
    );
    const speakerLabel = generatedAiText(
      attribution.speakerLabel,
      "speaker label",
      MAXIMUM_AI_DRAFT_GROUNDING_NAME_CHARACTERS,
      { allowNewlines: false }
    );
    const evidence = generatedAiText(
      attribution.evidence,
      "speaker evidence",
      MAXIMUM_AI_DRAFT_GROUNDING_EVIDENCE_CHARACTERS,
      { allowNewlines: false }
    );
    const comparableLabel = normalizeGroundingText(speakerLabel);
    const comparableEvidence = normalizeGroundingText(evidence);
    if (
      seenAttributions.has(comparableLabel)
      || !confirmedSpeakerLabels.has(comparableLabel)
      || !comparableEvidence.includes(`${comparableLabel}:`)
      || !evidenceTexts.some((text) => text.includes(comparableEvidence))
    ) {
      throw new TypeError("AI draft speaker grounding is invalid");
    }
    seenAttributions.add(comparableLabel);
    speakerAttributions.push({ speakerLabel, evidence });
  }
  return { namedEntities, speakerAttributions };
}

export function safeAiUsage(value: unknown): Record<string, number> | null {
  const usage = (
    value
    && typeof value === "object"
    && !Array.isArray(value)
  )
    ? (value as { usage?: unknown }).usage
    : null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const result: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const amount = Number((usage as Record<string, unknown>)[key]);
    if (Number.isSafeInteger(amount) && amount >= 0) result[key] = amount;
  }
  return Object.keys(result).length ? result : null;
}

export function safeAiDraftFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const message = error.message;
  if (message === "AI draft provider response must be an object") {
    return "provider_response_not_object";
  }
  if (message === "AI draft provider response is not valid JSON") {
    return "provider_response_invalid_json";
  }
  if (message === "AI draft provider output must be an object") {
    return "provider_output_not_object";
  }
  if (message === "AI draft grounding is invalid") {
    return "grounding_schema_invalid";
  }
  if (message === "AI draft grounding source is invalid") {
    return "grounding_source_invalid";
  }
  if (message === "AI draft named-entity grounding is invalid") {
    return "grounding_named_entity_invalid";
  }
  if (message === "AI draft speaker grounding is invalid") {
    return "grounding_speaker_invalid";
  }
  if (/^AI draft namedEntities\[\d+\] is invalid$/u.test(message)) {
    return "grounding_named_entity_schema_invalid";
  }
  if (/^AI draft speakerAttributions\[\d+\] is invalid$/u.test(message)) {
    return "grounding_speaker_schema_invalid";
  }
  if (message.startsWith("AI draft provider grounding ")) {
    return "grounding_text_invalid";
  }
  if (message === "AI draft provider response is invalid") {
    return "provider_response_invalid";
  }
  if (message.startsWith("AI draft provider ")) {
    return "draft_schema_invalid";
  }
  if (message === "AI draft show-notes attribution is invalid") {
    return "show_notes_attribution_invalid";
  }
  if (message === "AI draft show-notes Markdown structure is invalid") {
    return "show_notes_markdown_structure_invalid";
  }
  return error.name === "TypeError" ? "type_error" : "provider_error";
}

function collectForward(
  lines: string[],
  start: number,
  budget: number,
  selected: Set<number>
): void {
  let used = 0;
  for (let index = start; index < lines.length; index += 1) {
    const length = lines[index].length + 1;
    if (used > 0 && used + length > budget) break;
    selected.add(index);
    used += length;
  }
}

function collectBackward(
  lines: string[],
  start: number,
  budget: number,
  selected: Set<number>
): void {
  let used = 0;
  for (let index = start; index >= 0; index -= 1) {
    const length = lines[index].length + 1;
    if (used > 0 && used + length > budget) break;
    selected.add(index);
    used += length;
  }
}

function renderTranscriptSelection(
  lines: string[],
  indexes: number[]
): string {
  const output: string[] = [];
  let previous = -1;
  for (const index of indexes) {
    if (previous >= 0 && index > previous + 1) {
      output.push("[… approved transcript cues omitted …]");
    }
    output.push(lines[index]);
    previous = index;
  }
  return output.join("\n");
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function exactGroundingRecord(
  value: unknown,
  keys: string[],
  field: string
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== keys.join(",")
  ) {
    throw new TypeError(`AI draft ${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function normalizeGroundingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}
