import type {
  AlignmentRunnerAdapterIdentity
} from "@dustwave/timed-text/alignment";

export const ALIGNMENT_RUNNER_REPOSITORY =
  "aindaco1/dust-wave-alignment-runner";
export const ALIGNMENT_RUNNER_REVISION =
  "e611801d2af82dcdb079444b7e8a7eea4309d1a6";
export const ALIGNMENT_RUNNER_DIGEST =
  "sha256:8a7cda2702487a1d542d5fb740efe8580ca9edd99f405d722d610536c73a3a11";

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
