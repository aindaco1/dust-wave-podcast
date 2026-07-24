import { describe, expect, it } from "vitest";

import {
  DYNAMIC_AD_MP3_PROFILE,
  validateDynamicAdMp3
} from "../src/mp3-profile";

describe("dynamic ad MP3 profile validation", () => {
  it("accepts complete MPEG-1 Layer III 128 kbps 44.1 kHz stereo frames", () => {
    const bytes = mp3Frames(100);
    const report = validateDynamicAdMp3(bytes);

    expect(report).toEqual({
      profile: DYNAMIC_AD_MP3_PROFILE,
      audioBytes: 41_700,
      frameBytes: 41_700,
      frameCount: 100,
      durationMs: 2_612,
      bitrateKbps: 128,
      sampleRateHz: 44_100,
      channels: 2,
      id3v2Bytes: 0,
      id3v1Bytes: 0
    });
  });

  it("accounts for bounded ID3v2 and ID3v1 metadata outside audio frames", () => {
    const id3v2 = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    const bytes = concatenate(id3v2, mp3Frames(2), id3v1);
    const report = validateDynamicAdMp3(bytes);

    expect(report.frameCount).toBe(2);
    expect(report.id3v2Bytes).toBe(10);
    expect(report.id3v1Bytes).toBe(128);
    expect(report.frameBytes).toBe(834);
  });

  it("rejects mono, incompatible bitrate, and truncated frames", () => {
    const mono = mp3Frames(1);
    mono[3] = 0xc0;
    expect(() => validateDynamicAdMp3(mono)).toThrow("44.1 kHz stereo");

    const wrongBitrate = mp3Frames(1);
    wrongBitrate[2] = 0x80;
    expect(() => validateDynamicAdMp3(wrongBitrate)).toThrow("128 kbps");

    expect(() => validateDynamicAdMp3(mp3Frames(2).slice(0, -1))).toThrow(
      "truncated"
    );
  });
});

function mp3Frames(count: number): Uint8Array {
  const frameLength = 417;
  const bytes = new Uint8Array(frameLength * count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * frameLength;
    bytes.set([0xff, 0xfb, 0x90, 0x40], offset);
  }
  return bytes;
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
