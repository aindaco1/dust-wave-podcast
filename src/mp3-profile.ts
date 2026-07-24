export const DYNAMIC_AD_MP3_PROFILE =
  "mp3-44100-stereo-cbr128-frame-v1";

export interface Mp3ProfileReport {
  profile: typeof DYNAMIC_AD_MP3_PROFILE;
  audioBytes: number;
  frameBytes: number;
  frameCount: number;
  durationMs: number;
  bitrateKbps: 128;
  sampleRateHz: 44_100;
  channels: 2;
  id3v2Bytes: number;
  id3v1Bytes: number;
}

export function validateDynamicAdMp3(
  bytes: Uint8Array
): Mp3ProfileReport {
  if (bytes.byteLength < 417) {
    throw new Error("Creative MP3 is too small to contain an audio frame.");
  }
  let offset = id3v2Length(bytes);
  const id3v2Bytes = offset;
  const id3v1Bytes = hasId3v1(bytes) ? 128 : 0;
  const audioEnd = bytes.byteLength - id3v1Bytes;
  let frameBytes = 0;
  let frameCount = 0;

  while (offset < audioEnd) {
    if (offset + 4 > audioEnd) {
      throw new Error("Creative MP3 ends inside a frame header.");
    }
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const fourth = bytes[offset + 3];
    if (first !== 0xff || (second & 0xe0) !== 0xe0) {
      throw new Error(`Creative MP3 has an invalid frame sync at byte ${offset}.`);
    }
    const versionBits = (second >> 3) & 0x03;
    const layerBits = (second >> 1) & 0x03;
    const bitrateIndex = (third >> 4) & 0x0f;
    const sampleRateIndex = (third >> 2) & 0x03;
    const padding = (third >> 1) & 0x01;
    const channelMode = (fourth >> 6) & 0x03;
    if (
      versionBits !== 0x03
      || layerBits !== 0x01
      || bitrateIndex !== 0x09
      || sampleRateIndex !== 0x00
      || channelMode === 0x03
    ) {
      throw new Error(
        `Creative MP3 frame ${frameCount + 1} does not match MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo.`
      );
    }
    const length = Math.floor((144 * 128_000) / 44_100) + padding;
    if (offset + length > audioEnd) {
      throw new Error(`Creative MP3 frame ${frameCount + 1} is truncated.`);
    }
    offset += length;
    frameBytes += length;
    frameCount += 1;
  }
  if (offset !== audioEnd || frameCount === 0) {
    throw new Error("Creative MP3 does not end on a complete frame boundary.");
  }
  return {
    profile: DYNAMIC_AD_MP3_PROFILE,
    audioBytes: bytes.byteLength,
    frameBytes,
    frameCount,
    durationMs: Math.round((frameCount * 1_152 * 1_000) / 44_100),
    bitrateKbps: 128,
    sampleRateHz: 44_100,
    channels: 2,
    id3v2Bytes,
    id3v1Bytes
  };
}

function id3v2Length(bytes: Uint8Array): number {
  if (
    bytes.byteLength < 10
    || bytes[0] !== 0x49
    || bytes[1] !== 0x44
    || bytes[2] !== 0x33
  ) {
    return 0;
  }
  const sizeBytes = bytes.slice(6, 10);
  if (sizeBytes.some((value) => (value & 0x80) !== 0)) {
    throw new Error("Creative MP3 has an invalid ID3v2 size.");
  }
  const payloadBytes = (
    (sizeBytes[0] << 21)
    | (sizeBytes[1] << 14)
    | (sizeBytes[2] << 7)
    | sizeBytes[3]
  );
  const footerBytes = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + payloadBytes + footerBytes;
  if (total >= bytes.byteLength) {
    throw new Error("Creative MP3 ID3v2 tag consumes the audio payload.");
  }
  return total;
}

function hasId3v1(bytes: Uint8Array): boolean {
  const offset = bytes.byteLength - 128;
  return offset >= 0
    && bytes[offset] === 0x54
    && bytes[offset + 1] === 0x41
    && bytes[offset + 2] === 0x47;
}
