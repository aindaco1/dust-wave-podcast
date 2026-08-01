const MAXIMUM_WINDOWS = 100;
const MINIMUM_WINDOW_DURATION_MS = 120_000;
const MAXIMUM_WINDOW_DURATION_MS = 300_000;

export function buildCaptionWordTimeline(referenceCues) {
  if (!Array.isArray(referenceCues) || referenceCues.length < 1) {
    throw new TypeError("Caption reference cues are required");
  }
  return referenceCues.flatMap((cue, cueIndex) => {
    const startsAtMs = boundedInteger(
      cue?.startsAtMs,
      0,
      86_399_999,
      `Caption cue ${cueIndex + 1} start`
    );
    const text = String(cue?.text ?? "");
    return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu))
      .map((match, wordIndex) => ({
        startsAtMs,
        cueIndex,
        wordIndex,
        text: match[0]
      }));
  });
}

export function planCaptionDenseWindows({
  words,
  sourceDurationMs,
  fixtureCount = 12,
  windowDurationMs = 135_000,
  gridMs = 1_000,
  minimumGapMs = 1_000,
  minimumReferenceWords = 100
}) {
  const duration = boundedInteger(
    sourceDurationMs,
    MINIMUM_WINDOW_DURATION_MS,
    86_400_000,
    "Source duration"
  );
  const count = boundedInteger(
    fixtureCount,
    1,
    MAXIMUM_WINDOWS,
    "Fixture count"
  );
  const windowDuration = boundedInteger(
    windowDurationMs,
    MINIMUM_WINDOW_DURATION_MS,
    MAXIMUM_WINDOW_DURATION_MS,
    "Window duration"
  );
  const grid = boundedInteger(gridMs, 100, 60_000, "Planning grid");
  const gap = boundedInteger(minimumGapMs, 0, 60_000, "Minimum gap");
  const minimumWords = boundedInteger(
    minimumReferenceWords,
    1,
    25_000,
    "Minimum reference words"
  );
  if (count * windowDuration + (count - 1) * gap > duration) {
    throw new TypeError("The source is too short for the requested fixture plan");
  }
  if (!Array.isArray(words) || words.length < 1) {
    throw new TypeError("Caption reference words are required");
  }
  const timeline = words.map((word, index) => ({
    ...word,
    startsAtMs: boundedInteger(
      word?.startsAtMs,
      0,
      duration,
      `Caption word ${index + 1} start`
    )
  })).sort((left, right) => left.startsAtMs - right.startsAtMs);
  const maximumStart = duration - windowDuration;
  const starts = [];
  for (let start = 0; start <= maximumStart; start += grid) starts.push(start);
  if (starts.at(-1) !== maximumStart) starts.push(maximumStart);
  const candidates = starts.map((startsAtMs) => {
    const endsAtMs = startsAtMs + windowDuration;
    return {
      startsAtMs,
      endsAtMs,
      referenceWordCount: countWords(timeline, startsAtMs, endsAtMs)
    };
  });
  const nextIndexes = candidates.map((candidate) => lowerBound(
    starts,
    candidate.endsAtMs + gap
  ));
  const impossible = Number.NEGATIVE_INFINITY;
  const scores = Array.from(
    { length: count + 1 },
    () => new Float64Array(candidates.length + 1)
  );
  const choices = Array.from(
    { length: count + 1 },
    () => new Uint8Array(candidates.length)
  );
  for (let remaining = 1; remaining <= count; remaining += 1) {
    scores[remaining].fill(impossible);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const skip = scores[remaining][index + 1];
      const candidate = candidates[index];
      const tail = scores[remaining - 1][nextIndexes[index]];
      const take = candidate.referenceWordCount >= minimumWords
        && Number.isFinite(tail)
        ? candidate.referenceWordCount + tail
        : impossible;
      if (take >= skip) {
        scores[remaining][index] = take;
        choices[remaining][index] = 1;
      } else {
        scores[remaining][index] = skip;
      }
    }
  }
  if (!Number.isFinite(scores[count][0])) {
    throw new TypeError(
      "The caption reference cannot supply the requested speech-dense fixtures"
    );
  }
  const windows = [];
  let remaining = count;
  let index = 0;
  while (remaining > 0 && index < candidates.length) {
    if (choices[remaining][index] === 1) {
      windows.push(candidates[index]);
      index = nextIndexes[index];
      remaining -= 1;
    } else {
      index += 1;
    }
  }
  if (windows.length !== count) {
    throw new TypeError("The fixture plan could not be reconstructed");
  }
  return windows;
}

export function clipYouTubeJson3Reference(value, startsAtMs, endsAtMs) {
  if (!value || typeof value !== "object" || !Array.isArray(value.events)) {
    throw new TypeError("YouTube caption events are invalid");
  }
  const start = boundedInteger(startsAtMs, 0, 86_399_999, "Window start");
  const end = boundedInteger(endsAtMs, start + 1, 86_400_000, "Window end");
  const events = value.events.flatMap((event) => {
    if (!event || typeof event !== "object" || !Array.isArray(event.segs)) {
      return [];
    }
    const eventStart = Number(event.tStartMs);
    if (!Number.isSafeInteger(eventStart) || eventStart < start || eventStart >= end) {
      return [];
    }
    const eventDuration = Number(event.dDurationMs);
    const boundedDuration = Number.isSafeInteger(eventDuration) && eventDuration > 0
      ? Math.min(eventDuration, end - eventStart)
      : undefined;
    const clipped = {
      ...event,
      tStartMs: eventStart - start
    };
    if (boundedDuration === undefined) delete clipped.dDurationMs;
    else clipped.dDurationMs = boundedDuration;
    return [clipped];
  });
  if (!events.length) throw new TypeError("Window contains no caption events");
  return { events };
}

function countWords(words, startsAtMs, endsAtMs) {
  const first = lowerBound(words, startsAtMs, (word) => word.startsAtMs);
  const last = lowerBound(words, endsAtMs, (word) => word.startsAtMs);
  return last - first;
}

function lowerBound(values, target, selector = (value) => value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (selector(values[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function boundedInteger(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${field} is invalid`);
  }
  return number;
}
