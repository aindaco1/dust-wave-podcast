const DISK_MEASUREMENT_SCHEMA = "alignment-disk-measurement-v1";
const DISK_MEASUREMENT_METHOD = "filesystem-delta-plus-input-v1";

export function buildAlignmentWorkflowEvidence({
  manifest,
  validated,
  diskMeasurement
}) {
  if (!manifest || !validated || typeof manifest !== "object") {
    throw new Error("Alignment evidence inputs are invalid.");
  }
  if (!new Set(["en", "es"]).has(manifest.language)) {
    throw new Error("Alignment evidence language is invalid.");
  }
  const measurement = validateAlignmentDiskMeasurement(diskMeasurement);
  const resource = validated.manifest?.resource;
  if (!resource || typeof resource !== "object") {
    throw new Error("Alignment result resource evidence is missing.");
  }
  return {
    schemaVersion: "alignment-workflow-evidence-v2",
    jobId: manifest.jobId,
    alignmentRevisionId: manifest.alignmentRevisionId,
    processorManifestSha256: manifest.manifestSha256,
    resultManifestSha256: validated.manifestSha256,
    adapter: {
      name: manifest.adapter.name,
      version: manifest.adapter.version,
      modelVersion: manifest.adapter.modelVersion,
      settingsVersion: manifest.adapter.settingsVersion
    },
    runner: {
      revision: manifest.runner.revision,
      digest: manifest.adapter.runnerDigest
    },
    quality: validated.quality,
    resource: {
      language: manifest.language,
      inputDurationMinutes: positiveNumber(
        resource.inputDurationMinutes,
        "input duration"
      ),
      wallClockMinutes: positiveNumber(
        resource.wallClockMinutes,
        "wall-clock duration"
      ),
      peakMemoryMb: positiveNumber(resource.peakMemoryMb, "peak memory"),
      peakDiskMb: measurement.peakDiskMb,
      runner: boundedText(resource.runner, "runner")
    },
    resourceMeasurement: {
      diskMethod: measurement.method,
      sampleIntervalMs: measurement.sampleIntervalMs
    }
  };
}

export function validateAlignmentDiskMeasurement(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(
      value,
      ["schemaVersion", "method", "sampleIntervalMs", "peakDiskMb"]
    )
  ) {
    throw new Error("Alignment disk measurement has an invalid schema.");
  }
  if (value.schemaVersion !== DISK_MEASUREMENT_SCHEMA) {
    throw new Error("Alignment disk measurement version is unsupported.");
  }
  if (value.method !== DISK_MEASUREMENT_METHOD) {
    throw new Error("Alignment disk measurement method is unsupported.");
  }
  if (
    !Number.isSafeInteger(value.sampleIntervalMs)
    || value.sampleIntervalMs < 100
    || value.sampleIntervalMs > 60_000
  ) {
    throw new Error("Alignment disk sample interval is invalid.");
  }
  return {
    schemaVersion: value.schemaVersion,
    method: value.method,
    sampleIntervalMs: value.sampleIntervalMs,
    peakDiskMb: positiveNumber(value.peakDiskMb, "peak disk")
  };
}

function positiveNumber(value, field) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    throw new Error(`Alignment evidence ${field} is invalid.`);
  }
  return value;
}

function boundedText(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200 || /[\x00-\x1f\x7f<>]/u.test(text)) {
    throw new Error(`Alignment evidence ${field} is invalid.`);
  }
  return text;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
