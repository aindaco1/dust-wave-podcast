export type WebVttCue = {
  startsAtMs: number;
  endsAtMs: number;
  speakerLabel?: string;
  text: string;
};

export function renderWebVtt(cues: WebVttCue[]): string {
  const body = cues.map((cue, index) => {
    const text = escapeWebVttText(cue.text);
    const payload = cue.speakerLabel
      ? `<v ${escapeWebVttText(cue.speakerLabel)}>${text}</v>`
      : text;
    return [
      String(index + 1),
      `${webVttTimestamp(cue.startsAtMs)} --> ${webVttTimestamp(cue.endsAtMs)}`,
      payload
    ].join("\n");
  });
  return `WEBVTT\n\n${body.join("\n\n")}\n`;
}

export function timedTextMarkdownToPlainText(value: string): string {
  return String(value || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?u>/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function webVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(seconds).padStart(2, "0")}.${
      String(remainder).padStart(3, "0")
    }`
  ].join(":");
}

function escapeWebVttText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
