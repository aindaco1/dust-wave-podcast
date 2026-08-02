import type { PodcastEnv } from "./env";
import { fetchWithTimeout } from "./fetch-with-timeout";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const VIDEO_UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos"
  + "?uploadType=resumable&part=snippet,status";
const CHANNEL_LOOKUP_URL =
  "https://www.googleapis.com/youtube/v3/channels";
const VIDEO_LOOKUP_URL = "https://www.googleapis.com/youtube/v3/videos";
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 64_000;
const TOKEN_TIMEOUT_MS = 10_000;
const METADATA_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAXIMUM_UPLOAD_TIMEOUT_MS = 13 * 60_000;

type YouTubeProviderConfig = {
  channelId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type JsonObject = Record<string, unknown>;

export class YouTubeProviderError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = "YouTubeProviderError";
    this.code = code;
  }
}

export function youtubeProviderConfigured(env: PodcastEnv): boolean {
  return youtubeProviderConfig(env) !== null;
}

export async function verifyYouTubeChannelAccess(
  env: PodcastEnv
): Promise<{ channelId: string }> {
  const config = youtubeProviderConfig(env);
  if (!config) {
    throw new YouTubeProviderError("youtube_not_configured");
  }
  const accessToken = await refreshAccessToken(config);
  await verifyAuthenticatedChannel(accessToken, config.channelId);
  return { channelId: config.channelId };
}

async function verifyAuthenticatedChannel(
  accessToken: string,
  expectedChannelId: string
): Promise<void> {
  const url = new URL(CHANNEL_LOOKUP_URL);
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "50");
  const response = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "error"
  }, METADATA_TIMEOUT_MS).catch(() => {
    throw new YouTubeProviderError(
      "youtube_channel_verification_failed"
    );
  });
  if (!response.ok) {
    throw new YouTubeProviderError(
      "youtube_channel_verification_failed"
    );
  }
  const payload = await boundedJson(
    response,
    "youtube_channel_verification_failed"
  );
  const items = Array.isArray(payload.items)
    ? payload.items.slice(0, 50)
    : [];
  const matched = items.some((value) => {
    const item = jsonObject(value);
    return String(item?.id ?? "") === expectedChannelId;
  });
  if (!matched) {
    throw new YouTubeProviderError(
      "youtube_channel_verification_failed"
    );
  }
}

export async function uploadUnlistedYouTubeVideo(
  env: PodcastEnv,
  {
    title,
    description,
    privacyStatus,
    contentLength,
    body,
    uploadTimeoutMs = UPLOAD_TIMEOUT_MS
  }: {
    title: string;
    description: string;
    privacyStatus: "private" | "unlisted";
    contentLength: number;
    body: ReadableStream;
    uploadTimeoutMs?: number;
  }
): Promise<{ videoId: string }> {
  if (
    !Number.isSafeInteger(uploadTimeoutMs)
    || uploadTimeoutMs < UPLOAD_TIMEOUT_MS
    || uploadTimeoutMs > MAXIMUM_UPLOAD_TIMEOUT_MS
  ) {
    throw new YouTubeProviderError("youtube_upload_timeout_invalid");
  }
  const config = youtubeProviderConfig(env);
  if (!config) {
    throw new YouTubeProviderError("youtube_not_configured");
  }
  const accessToken = await refreshAccessToken(config);
  await verifyAuthenticatedChannel(accessToken, config.channelId);
  const initiation = await fetchWithTimeout(VIDEO_UPLOAD_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-length": String(contentLength),
      "x-upload-content-type": "video/mp4"
    },
    body: JSON.stringify({
      snippet: {
        title,
        description,
        categoryId: "22"
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false
      }
    }),
    redirect: "error"
  }, METADATA_TIMEOUT_MS).catch(() => {
    throw new YouTubeProviderError("youtube_upload_session_failed");
  });
  if (!initiation.ok) {
    throw new YouTubeProviderError("youtube_upload_session_failed");
  }
  const uploadUrl = validUploadSessionUrl(
    initiation.headers.get("location")
  );
  const upload = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-length": String(contentLength),
      "content-type": "video/mp4"
    },
    body,
    redirect: "error"
  }, uploadTimeoutMs).catch(() => {
    throw new YouTubeProviderError("youtube_upload_failed");
  });
  if (!upload.ok) {
    throw new YouTubeProviderError(
      upload.status === 308
        ? "youtube_upload_incomplete"
        : "youtube_upload_failed"
    );
  }
  const uploaded = await boundedJson(upload, "youtube_upload_response_invalid");
  const videoId = validVideoId(uploaded.id);
  await verifyUploadedVideo(
    accessToken,
    videoId,
    config.channelId,
    privacyStatus
  );
  return { videoId };
}

export function youtubeProviderTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("title must be a string");
  }
  const title = value.trim();
  if (
    title.length < 1
    || title.length > 100
    || /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new TypeError("title is not valid YouTube metadata");
  }
  return title;
}

export function youtubeProviderDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("description must be a string");
  }
  const description = value.trim();
  if (
    description.length > 5_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)
  ) {
    throw new TypeError("description is not valid YouTube metadata");
  }
  return description;
}

export async function verifyYouTubeVideo(
  env: PodcastEnv,
  {
    videoId,
    privacyStatus
  }: {
    videoId: string;
    privacyStatus: "private" | "unlisted";
  }
): Promise<{ videoId: string }> {
  const config = youtubeProviderConfig(env);
  if (!config) {
    throw new YouTubeProviderError("youtube_not_configured");
  }
  const validId = validVideoId(videoId);
  const accessToken = await refreshAccessToken(config);
  await verifyUploadedVideo(
    accessToken,
    validId,
    config.channelId,
    privacyStatus
  );
  return { videoId: validId };
}

function youtubeProviderConfig(
  env: PodcastEnv
): YouTubeProviderConfig | null {
  if (
    !env.YOUTUBE_CLIENT_ID
    || !env.YOUTUBE_CLIENT_SECRET
    || !env.YOUTUBE_REFRESH_TOKEN
    || !env.YOUTUBE_CHANNEL_ID
    || !/^[A-Za-z0-9_-]{6,200}$/.test(env.YOUTUBE_CHANNEL_ID)
  ) {
    return null;
  }
  return {
    channelId: env.YOUTUBE_CHANNEL_ID,
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN
  };
}

async function refreshAccessToken(
  config: YouTubeProviderConfig
): Promise<string> {
  const response = await fetchWithTimeout(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token"
    }),
    redirect: "error"
  }, TOKEN_TIMEOUT_MS).catch(() => {
    throw new YouTubeProviderError("youtube_oauth_network_failed");
  });
  if (!response.ok) {
    let providerCode = "";
    try {
      const rejected = await boundedJson(
        response,
        "youtube_oauth_response_invalid"
      );
      providerCode = typeof rejected.error === "string"
        ? rejected.error
        : "";
    } catch {
      // Provider bodies are intentionally discarded. The status-independent
      // fallback remains actionable without retaining potentially sensitive
      // response text.
    }
    throw new YouTubeProviderError(oauthFailureCode(providerCode));
  }
  const payload = await boundedJson(
    response,
    "youtube_oauth_response_invalid"
  );
  const accessToken = typeof payload.access_token === "string"
    ? payload.access_token
    : "";
  const tokenType = typeof payload.token_type === "string"
    ? payload.token_type
    : "";
  if (
    !accessToken
    || accessToken.length > 4096
    || tokenType.toLowerCase() !== "bearer"
  ) {
    throw new YouTubeProviderError("youtube_oauth_response_invalid");
  }
  return accessToken;
}

function oauthFailureCode(providerCode: string): string {
  switch (providerCode) {
    case "invalid_grant":
      return "youtube_oauth_invalid_grant";
    case "invalid_client":
      return "youtube_oauth_invalid_client";
    case "unauthorized_client":
      return "youtube_oauth_unauthorized_client";
    case "invalid_request":
      return "youtube_oauth_invalid_request";
    case "unsupported_grant_type":
      return "youtube_oauth_unsupported_grant_type";
    default:
      return "youtube_oauth_request_rejected";
  }
}

async function verifyUploadedVideo(
  accessToken: string,
  videoId: string,
  expectedChannelId: string,
  expectedPrivacyStatus: "private" | "unlisted"
): Promise<void> {
  const url = new URL(VIDEO_LOOKUP_URL);
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("id", videoId);
  const response = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "error"
  }, METADATA_TIMEOUT_MS).catch(() => {
    throw new YouTubeProviderError("youtube_verification_failed");
  });
  if (!response.ok) {
    throw new YouTubeProviderError("youtube_verification_failed");
  }
  const payload = await boundedJson(
    response,
    "youtube_verification_failed"
  );
  const item = Array.isArray(payload.items)
    ? jsonObject(payload.items[0])
    : null;
  const snippet = jsonObject(item?.snippet);
  const status = jsonObject(item?.status);
  if (
    !item
    || String(snippet?.channelId ?? "") !== expectedChannelId
    || String(status?.privacyStatus ?? "") !== expectedPrivacyStatus
  ) {
    throw new YouTubeProviderError("youtube_verification_failed");
  }
}

function validUploadSessionUrl(value: string | null): string {
  try {
    const url = new URL(String(value ?? ""));
    if (
      url.origin !== "https://www.googleapis.com"
      || url.pathname !== "/upload/youtube/v3/videos"
      || !url.searchParams.has("upload_id")
    ) {
      throw new Error("invalid");
    }
    return url.toString();
  } catch {
    throw new YouTubeProviderError("youtube_upload_session_failed");
  }
}

function validVideoId(value: unknown): string {
  const videoId = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(videoId)) {
    throw new YouTubeProviderError("youtube_upload_response_invalid");
  }
  return videoId;
}

async function boundedJson(
  response: Response,
  errorCode: string
): Promise<JsonObject> {
  const declaredLength = Number(
    response.headers.get("content-length") ?? "0"
  );
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAXIMUM_PROVIDER_RESPONSE_BYTES
  ) {
    throw new YouTubeProviderError(errorCode);
  }
  const bytes = await boundedResponseBytes(response, errorCode);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const object = jsonObject(value);
    if (!object) {
      throw new Error("invalid");
    }
    return object;
  } catch {
    throw new YouTubeProviderError(errorCode);
  }
}

async function boundedResponseBytes(
  response: Response,
  errorCode: string
): Promise<Uint8Array> {
  if (!response.body) {
    throw new YouTubeProviderError(errorCode);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new YouTubeProviderError(errorCode);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
