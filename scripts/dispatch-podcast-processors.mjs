import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import registry from "../config/processor-dispatch-registry.json"
  with { type: "json" };
import {
  reconcileProcessorDispatchIncident
} from "./lib/processor-dispatch-incident.mjs";
import {
  retrySignedWorkerRequest,
  signedWorkerRequest
} from "./lib/signed-worker-request.mjs";

const MAXIMUM_RESPONSE_BYTES = 64_000;

export async function dispatchPodcastProcessors({
  fetchImpl = fetch,
  environment = process.env
} = {}) {
  const callbackSecret = requiredEnvironment(
    environment,
    "MEDIA_PROCESSOR_CALLBACK_SECRET"
  );
  const githubToken = requiredEnvironment(environment, "GH_TOKEN");
  const repository = validRepository(
    requiredEnvironment(environment, "GITHUB_REPOSITORY")
  );
  const workflowRef = validRef(
    requiredEnvironment(environment, "PROCESSOR_WORKFLOW_REF")
  );
  const origin = new URL(registry.stagingOrigin);
  if (
    origin.origin !== registry.stagingOrigin
    || origin.pathname !== "/"
    || origin.protocol !== "https:"
  ) {
    throw new Error("Processor dispatch staging origin is invalid");
  }

  const claim = await signedWorkerRequest({
    fetchImpl,
    callbackSecret,
    origin,
    path: "/v1/processor/dispatches/claim",
    errorPrefix: "processor_dispatch_worker",
    body: {
      action: "claim",
      dispatcher: "github-actions",
      maximum: 4
    }
  });
  const dispatches = validateClaimResponse(claim);
  const ledger = claim.ledger === undefined
    ? null
    : validateLedgerSummary(claim.ledger);
  const failures = [];

  for (const dispatch of dispatches) {
    let runId;
    try {
      runId = await createGitHubWorkflowDispatch({
        fetchImpl,
        githubToken,
        repository,
        workflowRef,
        dispatch
      });
    } catch (error) {
      const failureCode = dispatchFailureCode(error);
      try {
        await retrySignedWorkerRequest({
          fetchImpl,
          callbackSecret,
          origin,
          path: `/v1/processor/dispatches/${dispatch.id}/failed`,
          errorPrefix: "processor_dispatch_worker",
          body: {
            action: "dispatch_failed",
            dispatchId: dispatch.id,
            leaseId: dispatch.leaseId,
            failureCode
          }
        });
      } catch {
        // The lease expires into bounded retry if acknowledgement is unavailable.
      }
      failures.push({ processorType: dispatch.processorType, failureCode });
      continue;
    }

    try {
      await retrySignedWorkerRequest({
        fetchImpl,
        callbackSecret,
        origin,
        path: `/v1/processor/dispatches/${dispatch.id}/dispatched`,
        errorPrefix: "processor_dispatch_worker",
        body: {
          action: "dispatched",
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          githubRunId: runId
        }
      });
      process.stdout.write(
        `Dispatched ${dispatch.processorType} processor run ${runId}.\n`
      );
    } catch (error) {
      // Do not reject a lease after GitHub has accepted the workflow. The
      // source processor's transition to running will reconcile this lease;
      // otherwise normal lease expiry provides bounded recovery without an
      // immediate duplicate dispatch.
      failures.push({
        processorType: dispatch.processorType,
        failureCode: dispatchFailureCode(error)
      });
    }
  }

  process.stdout.write(
    `Processor dispatcher claimed ${dispatches.length}; `
      + `${dispatches.length - failures.length} dispatched; `
      + `${failures.length} failed.\n`
  );
  if (ledger) {
    await publishLedgerEvidence({ environment, ledger });
    await reconcileProcessorDispatchIncident({
      fetchImpl,
      githubToken,
      repository,
      ledger,
      runId: environment.GITHUB_RUN_ID,
      serverUrl: String(environment.GITHUB_SERVER_URL || "https://github.com")
    });
  }
  if (failures.length) {
    throw new Error(
      `Processor dispatch failed for ${failures.length} claimed job(s)`
    );
  }
  return {
    claimed: dispatches.length,
    dispatched: dispatches.length - failures.length,
    failed: failures.length,
    ledger
  };
}

export async function createGitHubWorkflowDispatch({
  fetchImpl,
  githubToken,
  repository,
  workflowRef,
  dispatch
}) {
  const processor = registry.processors[dispatch.processorType];
  if (!processor) throw new Error("processor_type_not_registered");
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/workflows/`
      + `${encodeURIComponent(processor.workflow)}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubToken}`,
        "content-type": "application/json",
        "user-agent": "dust-wave-podcast-processor-dispatcher",
        "x-github-api-version": registry.githubApiVersion
      },
      body: JSON.stringify({
        ref: workflowRef,
        inputs: {
          [processor.input]: dispatch.targetId
        }
      })
    }
  );
  const responseBody = await readBoundedResponse(response);
  if (!response.ok) {
    const error = new Error(`github_dispatch_http_${response.status}`);
    error.code = `github_dispatch_http_${response.status}`;
    throw error;
  }
  const value = parseObject(responseBody);
  const runId = String(value?.workflow_run_id ?? "");
  if (!/^[0-9]{1,30}$/.test(runId)) {
    const error = new Error("github_dispatch_run_id_missing");
    error.code = "github_dispatch_run_id_missing";
    throw error;
  }
  return runId;
}

export function validateClaimResponse(value) {
  if (
    !value
    || value.schemaVersion !== 1
    || !Array.isArray(value.dispatches)
    || value.dispatches.length > 4
  ) {
    throw new Error("processor_claim_response_invalid");
  }
  if (value.ledger !== undefined) validateLedgerSummary(value.ledger);
  return value.dispatches.map((dispatch) => {
    if (
      !dispatch
      || typeof dispatch !== "object"
      || !validIdentifier(dispatch.id)
      || !validIdentifier(dispatch.targetId)
      || !validIdentifier(dispatch.leaseId)
      || !registry.processors[dispatch.processorType]
      || !/^[a-f0-9]{64}$/.test(dispatch.processorManifestSha256)
      || !Number.isSafeInteger(dispatch.attempt)
      || dispatch.attempt < 1
      || dispatch.attempt > 5
    ) {
      throw new Error("processor_claim_response_invalid");
    }
    return dispatch;
  });
}

export function validateLedgerSummary(value) {
  const keys = [
    "total",
    "queued",
    "leased",
    "dispatched",
    "running",
    "succeeded",
    "failed",
    "canceled"
  ];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || keys.slice(1).reduce((sum, key) => sum + value[key], 0) !== value.total
  ) {
    throw new Error("processor_claim_response_invalid");
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function publishLedgerEvidence({ environment, ledger }) {
  const line = "Processor ledger: "
    + `queued ${ledger.queued}; leased ${ledger.leased}; `
    + `dispatched ${ledger.dispatched}; running ${ledger.running}; `
    + `succeeded ${ledger.succeeded}; failed ${ledger.failed}; `
    + `canceled ${ledger.canceled}; total ${ledger.total}.`;
  process.stdout.write(`${line}\n`);
  if (ledger.failed > 0) {
    process.stdout.write(
      `::warning title=Podcast processor dispatch attention::`
      + `${ledger.failed} terminal dispatch failure(s) need review.\n`
    );
  }
  const summaryPath = String(environment.GITHUB_STEP_SUMMARY || "").trim();
  if (!summaryPath) return;
  await appendFile(
    summaryPath,
    `### Podcast processor dispatch\n\n${line}\n`,
    { encoding: "utf8", flag: "a" }
  );
}

async function readBoundedResponse(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("processor_dispatch_response_too_large");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("processor_dispatch_response_too_large");
  }
  return text;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function dispatchFailureCode(error) {
  const code = String(error?.code ?? error?.message ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(code)
    ? code
    : "github_dispatch_request_failed";
}

function requiredEnvironment(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  return value;
}

function validRef(value) {
  if (
    value.length > 240
    || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value)
    || value.includes("..")
    || value.includes("//")
  ) {
    throw new Error("PROCESSOR_WORKFLOW_REF is invalid");
  }
  return value;
}

function validIdentifier(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 240
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";
if (import.meta.url === invokedPath) {
  await dispatchPodcastProcessors();
}
