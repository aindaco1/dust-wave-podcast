import type { TranscriptLanguage, VerifiedApprovedTranscript } from "./transcripts";
import {
  RequestValidationError,
  requiredText
} from "./validation";

export const AI_DRAFT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const MAXIMUM_AI_DRAFT_TRANSCRIPT_CHARACTERS = 48_000;
export const AI_DRAFT_LIMIT_PER_EPISODE_PER_ADMIN_PER_HOUR = 6;

const LANGUAGE_VALUES = new Set<TranscriptLanguage>(["en", "es"]);

export type AiDraftTranscriptProjection = {
  excerpt: string;
  includedCueCount: number;
  totalCueCount: number;
  truncated: boolean;
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
  if (
    typeof response !== "string"
    || response.length < 2
    || response.length > maximumResponseCharacters
  ) {
    throw new TypeError("AI draft provider response is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new TypeError("AI draft provider response is not valid JSON");
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
