import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  open,
  stat
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  mediaProcessorSignature
} from "./media-processor-signature.mjs";

export function createStagingMediaProcessorClient({
  origin,
  secret
}) {
  if (
    !/^https:\/\/[A-Za-z0-9.-]+$/.test(origin)
    || String(secret || "").length < 16
  ) {
    throw new Error("The staging processor client is not configured.");
  }

  async function signedJsonRequest(url, body, timeoutMs = 30_000) {
    const response = await signedRequest(url, {
      method: "POST",
      body,
      signedMessage: body,
      headers: { "content-type": "application/json" },
      timeoutMs
    });
    return boundedJson(response);
  }

  async function signedRequest(
    url,
    { method, body, signedMessage, headers, timeoutMs }
  ) {
    if (!url.startsWith(`${origin}/`)) {
      throw new Error(
        "Refusing a processor request outside isolated staging."
      );
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const signed = mediaProcessorSignature(signedMessage, secret);
      try {
        const response = await fetch(url, {
          method,
          body,
          headers: {
            ...headers,
            "x-podcast-processor-timestamp": String(signed.timestamp),
            "x-podcast-processor-signature": signed.signature
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.ok) return response;
        const detail = await boundedResponseText(response, 20_000);
        if (response.status < 500 || attempt === 3) {
          throw new Error(
            `Processor request failed (${response.status}): ${detail}`
          );
        }
      } catch (error) {
        lastError = error;
        if (attempt === 3) break;
      }
    }
    throw lastError ?? new Error("Processor request failed.");
  }

  async function downloadSignedSource({
    url,
    body,
    filename,
    expectedBytes,
    expectedType
  }) {
    const response = await signedRequest(url, {
      method: "POST",
      body,
      signedMessage: body,
      headers: { "content-type": "application/json" },
      timeoutMs: 30 * 60_000
    });
    if (
      response.headers.get("content-type") !== expectedType
      || Number(response.headers.get("content-length")) !== expectedBytes
      || !response.body
    ) {
      await response.body?.cancel();
      throw new Error(
        "The private source response did not match the manifest."
      );
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(filename, { mode: 0o600 })
    );
    if ((await stat(filename)).size !== expectedBytes) {
      throw new Error(
        "The private source download ended at the wrong byte count."
      );
    }
  }

  async function uploadMultipartFile({
    manifest,
    filename,
    output,
    partIdentity
  }) {
    const file = await stat(filename);
    if (
      file.size !== output.objectBytes
      || output.objectKey !== manifest.output.objectKey
      || !Object.values(partIdentity).includes(manifest.jobId)
    ) {
      throw new Error(
        "The local processor output does not match the manifest."
      );
    }
    const partBytes = manifest.output.recommendedPartBytes;
    const partCount = Math.ceil(file.size / partBytes);
    const handle = await open(filename, "r");
    try {
      for (let index = 0; index < partCount; index += 1) {
        const length = Math.min(
          partBytes,
          file.size - index * partBytes
        );
        const bytes = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(
          bytes,
          0,
          length,
          index * partBytes
        );
        if (bytesRead !== length) {
          throw new Error(
            "The processor output changed while it was being uploaded."
          );
        }
        const partNumber = index + 1;
        const payload = Buffer.from(JSON.stringify({
          ...partIdentity,
          partNumber,
          objectBytes: length,
          sha256: sha256(bytes),
          manifestSha256: manifest.manifestSha256
        })).toString("base64url");
        const result = curlSignedBinaryPut(
          manifest.endpoints.partTemplate.replace(
            "{partNumber}",
            String(partNumber)
          ),
          bytes,
          payload,
          {
            "content-type": "application/octet-stream",
            "content-length": String(length),
            "x-podcast-processor-part-payload": payload
          },
          10 * 60_000
        );
        if (
          result.checksumVerified !== true
          || result.partNumber !== partNumber
          || result.uploadedBytes !== length
        ) {
          throw new Error(
            `Multipart part ${partNumber} was not verified.`
          );
        }
      }
    } finally {
      await handle.close();
    }
    const completed = await signedJsonRequest(
      manifest.endpoints.uploadComplete,
      JSON.stringify({
        jobId: manifest.jobId,
        action: "upload-complete",
        manifestSha256: manifest.manifestSha256,
        objectBytes: output.objectBytes,
        outputSha256: output.sha256,
        partCount
      }),
      10 * 60_000
    );
    if (
      completed.multipartCompleted !== true
      || completed.objectBytes !== output.objectBytes
    ) {
      throw new Error(
        "The multipart output was not completed exactly."
      );
    }
    return completed;
  }

  function signedBinaryPut({
    url,
    bytes,
    signedMessage,
    headers = {},
    timeoutMs = 10 * 60_000
  }) {
    if (
      !Buffer.isBuffer(bytes)
      || bytes.byteLength < 1
      || typeof signedMessage !== "string"
      || signedMessage.length < 1
    ) {
      throw new Error("The signed binary upload input is invalid.");
    }
    return curlSignedBinaryPut(
      url,
      bytes,
      signedMessage,
      headers,
      timeoutMs
    );
  }

  function curlSignedBinaryPut(
    url,
    bytes,
    signedMessage,
    headers,
    timeoutMs
  ) {
    if (!url.startsWith(`${origin}/`)) {
      throw new Error(
        "Refusing a processor request outside isolated staging."
      );
    }
    const signed = mediaProcessorSignature(signedMessage, secret);
    const result = spawnSync("curl", [
      "--http1.1",
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--retry", "3",
      "--retry-all-errors",
      "--retry-delay", "1",
      "--connect-timeout", "30",
      "--max-time", String(Math.ceil(timeoutMs / 1_000)),
      "--request", "PUT",
      "--header", "Expect:",
      "--header",
      `x-podcast-processor-timestamp: ${signed.timestamp}`,
      "--header",
      `x-podcast-processor-signature: ${signed.signature}`,
      ...Object.entries(headers).flatMap(([name, value]) => [
        "--header", `${name}: ${value}`
      ]),
      "--data-binary", "@-",
      url
    ], {
      input: bytes,
      encoding: null,
      maxBuffer: 2_100_000,
      timeout: timeoutMs + 30_000
    });
    if (result.status !== 0) {
      const detail = Buffer.concat([
        result.stdout || Buffer.alloc(0),
        result.stderr || Buffer.alloc(0)
      ]).subarray(0, 20_000).toString("utf8").trim();
      throw new Error(
        `Processor binary upload failed safely: ${detail || "curl failed"}`
      );
    }
    return boundedJsonBytes(result.stdout);
  }

  return {
    downloadSignedSource,
    signedBinaryPut,
    signedJsonRequest,
    uploadMultipartFile
  };
}

function boundedJsonBytes(bytes) {
  if (!bytes || bytes.byteLength > 2_000_000) {
    throw new Error("The processor response exceeded its byte limit.");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The processor response was not a JSON object.");
  }
  return value;
}

async function boundedJson(response) {
  const text = await boundedResponseText(response, 2_000_000);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The processor response was not a JSON object.");
  }
  return value;
}

async function boundedResponseText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(
        "The processor response exceeded its byte limit."
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
