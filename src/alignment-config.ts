import type {
  AlignmentRunnerAdapterIdentity
} from "@dustwave/timed-text/alignment";

export const ALIGNMENT_RUNNER_REPOSITORY =
  "aindaco1/dust-wave-alignment-runner";
export const ALIGNMENT_RUNNER_REVISION =
  "3c5ab054fdad375901eb186f32d7aed6cdb40413";
export const ALIGNMENT_RUNNER_DIGEST =
  "sha256:5b07bbf315bd62a3c445a7a5a476bf642f91aa1c781173aa1f4e4e8021a51178";

export const ALIGNMENT_ADAPTERS: Readonly<
  Record<"whisperx" | "stable-ts", AlignmentRunnerAdapterIdentity>
> = Object.freeze({
  whisperx: Object.freeze({
    name: "whisperx",
    version: "3.8.6",
    model: "default",
    modelVersion: "default-en-es-v1",
    settingsVersion: "whisperx-align-v1",
    runnerDigest: ALIGNMENT_RUNNER_DIGEST
  }),
  "stable-ts": Object.freeze({
    name: "stable-ts",
    version: "2.19.1",
    model: "base",
    modelVersion: "openai-whisper-base",
    settingsVersion: "stable-ts-align-v1",
    runnerDigest: ALIGNMENT_RUNNER_DIGEST
  })
});

export type AlignmentAdapterName = keyof typeof ALIGNMENT_ADAPTERS;

export function configuredAlignmentAdapter(
  value: unknown
): AlignmentRunnerAdapterIdentity | null {
  const key = String(value ?? "") as AlignmentAdapterName;
  const adapter = ALIGNMENT_ADAPTERS[key];
  return adapter ? { ...adapter } : null;
}
