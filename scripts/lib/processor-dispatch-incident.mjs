const API_ORIGIN = "https://api.github.com";
import registry from "../../config/processor-dispatch-registry.json"
  with { type: "json" };

const API_VERSION = registry.githubApiVersion;
const MAXIMUM_RESPONSE_BYTES = 512_000;
const INCIDENT_TITLE = "[Podcast automation] Processor dispatch failures";
const INCIDENT_MARKER = "<!-- dust-wave-processor-dispatch-incident-v1 -->";

export async function reconcileProcessorDispatchIncident({
  fetchImpl = fetch,
  githubToken,
  repository,
  ledger,
  runId,
  serverUrl = "https://github.com"
}) {
  if (!validRepository(repository) || !String(githubToken || "").trim()) {
    throw new Error("processor_dispatch_incident_configuration_invalid");
  }
  if (!validLedger(ledger)) {
    throw new Error("processor_dispatch_incident_ledger_invalid");
  }
  const existing = await findOpenIncident({
    fetchImpl,
    githubToken,
    repository
  });
  const evidenceUrl = validEvidenceUrl({ repository, runId, serverUrl });
  if (ledger.failed > 0) {
    const body = incidentBody({ ledger, evidenceUrl });
    if (existing) {
      if (String(existing.body || "") === body) {
        return { action: "unchanged", issueNumber: existing.number };
      }
      await githubJson({
        fetchImpl,
        githubToken,
        url: `${API_ORIGIN}/repos/${repository}/issues/${existing.number}`,
        method: "PATCH",
        body: { body }
      });
      return { action: "updated", issueNumber: existing.number };
    }
    const created = await githubJson({
      fetchImpl,
      githubToken,
      url: `${API_ORIGIN}/repos/${repository}/issues`,
      method: "POST",
      body: { title: INCIDENT_TITLE, body }
    });
    const issueNumber = validIssueNumber(created?.number);
    return { action: "opened", issueNumber };
  }
  if (!existing) return { action: "none", issueNumber: null };
  await githubJson({
    fetchImpl,
    githubToken,
    url: `${API_ORIGIN}/repos/${repository}/issues/${existing.number}`,
    method: "PATCH",
    body: {
      state: "closed",
      state_reason: "completed",
      body: `${String(existing.body || INCIDENT_MARKER)}\n\n`
        + `Recovered automatically. Current evidence: ${evidenceUrl}`
    }
  });
  return { action: "closed", issueNumber: existing.number };
}

async function findOpenIncident({ fetchImpl, githubToken, repository }) {
  const query = new URLSearchParams({
    q: `repo:${repository} is:issue is:open in:title "${INCIDENT_TITLE}"`,
    per_page: "10"
  });
  const response = await githubJson({
    fetchImpl,
    githubToken,
    url: `${API_ORIGIN}/search/issues?${query}`
  });
  const issues = Array.isArray(response?.items) ? response.items : [];
  const incident = issues.find((issue) =>
    String(issue?.title || "") === INCIDENT_TITLE
    && String(issue?.body || "").includes(INCIDENT_MARKER)
  );
  if (!incident) return null;
  return {
    number: validIssueNumber(incident.number),
    body: String(incident.body || "")
  };
}

function incidentBody({ ledger, evidenceUrl }) {
  return [
    "This issue is maintained automatically by the staging Podcast dispatcher.",
    "",
    `- Terminal failures: ${ledger.failed}`,
    `- Queued: ${ledger.queued}`,
    `- Leased: ${ledger.leased}`,
    `- Dispatched: ${ledger.dispatched}`,
    `- Running: ${ledger.running}`,
    `- Succeeded: ${ledger.succeeded}`,
    `- Canceled: ${ledger.canceled}`,
    `- Total durable rows: ${ledger.total}`,
    `- Latest evidence: ${evidenceUrl}`,
    "",
    "No media URL, object key, manifest, listener identity, email address, "
      + "provider payload, or job ID is included.",
    "",
    INCIDENT_MARKER
  ].join("\n");
}

async function githubJson({
  fetchImpl,
  githubToken,
  url,
  method = "GET",
  body
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "user-agent": "dust-wave-podcast-processor-dispatcher",
      "x-github-api-version": API_VERSION
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("processor_dispatch_incident_response_too_large");
  }
  if (!response.ok) {
    throw new Error(`processor_dispatch_incident_github_http_${response.status}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("processor_dispatch_incident_response_invalid");
  }
}

function validLedger(value) {
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
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && keys.slice(1).reduce((sum, key) => sum + value[key], 0) === value.total;
}

function validRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

function validIssueNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("processor_dispatch_incident_issue_invalid");
  }
  return number;
}

function validEvidenceUrl({ repository, runId, serverUrl }) {
  const origin = new URL(serverUrl);
  if (origin.protocol !== "https:" || origin.origin !== serverUrl) {
    throw new Error("processor_dispatch_incident_server_invalid");
  }
  const normalizedRunId = String(runId || "");
  return /^[0-9]{1,30}$/.test(normalizedRunId)
    ? `${origin.origin}/${repository}/actions/runs/${normalizedRunId}`
    : `${origin.origin}/${repository}/actions`;
}
