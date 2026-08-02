import matrix from "../config/launch-lab-matrix.json";

const RUN_INSERT_QUERY = [
  "INSERT OR IGNORE INTO launch_lab_runs (",
  "  id, show_id, source_commit",
  ") VALUES (?, ?, ?)"
].join("\n");
const RUN_SELECT_QUERY = [
  "SELECT id, show_id, source_commit, status, started_at, completed_at",
  "FROM launch_lab_runs",
  "WHERE id = ?"
].join("\n");
const SCENARIO_LIST_QUERY = [
  "SELECT provider, scenario, expected_status, state, observed_status,",
  "  failure_code",
  "FROM launch_lab_provider_scenarios",
  "WHERE run_id = ?",
  "ORDER BY provider, scenario"
].join("\n");

type LaunchLabRunRow = {
  id: string;
  show_id: string;
  source_commit: string;
  status: string;
  started_at: string;
  completed_at: string | null;
};

export type LaunchLabScenarioRow = {
  provider: string;
  scenario: string;
  expected_status: string;
  state: string;
  observed_status: string | null;
  failure_code: string | null;
};

export type LaunchLabProvider = keyof typeof matrix.providers;

export type LaunchLabObservation = {
  provider: LaunchLabProvider;
  scenario: string;
  observedStatus: string;
  failureCode?: string | null;
};

export async function ensureLaunchLabRun(
  db: D1Database,
  input: { runId: string; showId: string; sourceCommit: string }
): Promise<boolean> {
  await db.prepare(RUN_INSERT_QUERY).bind(
    input.runId,
    input.showId,
    input.sourceCommit
  ).run();
  const row = await loadLaunchLabRun(db, input.runId);
  return Boolean(
    row
    && row.show_id === input.showId
    && row.source_commit === input.sourceCommit
  );
}

export async function seedLaunchLabScenarios(
  db: D1Database,
  runId: string
): Promise<void> {
  const entries = matrixEntries();
  await db.batch(entries.map(({ provider, scenario, expectedStatus }) =>
    db.prepare(
      `INSERT OR IGNORE INTO launch_lab_provider_scenarios (
         id, run_id, provider, scenario, expected_status
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      launchLabScenarioId(runId, provider, scenario),
      runId,
      provider,
      scenario,
      expectedStatus
    )
  ));
  const rows = (await db.prepare(
    `SELECT provider, scenario, expected_status
     FROM launch_lab_provider_scenarios
     WHERE run_id = ?`
  ).bind(runId).all<{
    provider: string;
    scenario: string;
    expected_status: string;
  }>()).results;
  const actual = new Map(rows.map((row) => [
    `${row.provider}:${row.scenario}`,
    row.expected_status
  ]));
  if (
    actual.size !== entries.length
    || entries.some((entry) =>
      actual.get(`${entry.provider}:${entry.scenario}`)
        !== entry.expectedStatus
    )
  ) {
    throw new Error("Launch Lab scenario contract did not persist exactly.");
  }
}

export async function recordLaunchLabObservations(
  db: D1Database,
  runId: string,
  observations: LaunchLabObservation[]
): Promise<void> {
  if (observations.length < 1 || observations.length > 50) {
    throw new Error("Launch Lab observation count is invalid.");
  }
  const expected = new Map(matrixEntries().map((entry) => [
    `${entry.provider}:${entry.scenario}`,
    entry.expectedStatus
  ]));
  const normalized = observations.map((observation) => {
    const key = `${observation.provider}:${observation.scenario}`;
    const expectedStatus = expected.get(key);
    if (
      !expectedStatus
      || !/^[a-z0-9_]{1,40}$/.test(observation.observedStatus)
      || (
        observation.failureCode
        && !/^[a-z0-9_]{1,80}$/.test(observation.failureCode)
      )
    ) {
      throw new Error("Launch Lab observation is not allowlisted.");
    }
    return { ...observation, expectedStatus };
  });
  if (new Set(normalized.map((item) =>
    `${item.provider}:${item.scenario}`
  )).size !== normalized.length) {
    throw new Error("Launch Lab observations must be unique.");
  }
  await db.batch(normalized.map((observation) => db.prepare(
    `UPDATE launch_lab_provider_scenarios
     SET
       state = CASE WHEN ? = expected_status THEN 'passed' ELSE 'failed' END,
       observed_status = ?,
       failure_code = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?
       AND expected_status = ?
       AND state != 'passed'`
  ).bind(
    observation.observedStatus,
    observation.observedStatus,
    observation.observedStatus === observation.expectedStatus
      ? null
      : observation.failureCode ?? "unexpected_status",
    launchLabScenarioId(
      runId,
      observation.provider,
      observation.scenario
    ),
    observation.expectedStatus
  )));
  const rows = await loadScenarioRows(db, runId);
  const byKey = new Map(rows.map((row) => [
    `${row.provider}:${row.scenario}`,
    row
  ]));
  if (normalized.some((observation) => {
    const row = byKey.get(`${observation.provider}:${observation.scenario}`);
    return !row
      || row.expected_status !== observation.expectedStatus
      || row.observed_status !== observation.observedStatus
      || row.state !== (
        observation.observedStatus === observation.expectedStatus
          ? "passed"
          : "failed"
      );
  })) {
    throw new Error("Launch Lab observation did not persist exactly.");
  }
  await refreshLaunchLabRunStatus(db, runId);
}

export function launchLabExpectedStatus(
  provider: LaunchLabProvider,
  scenario: string
): string | null {
  const scenarios = matrix.providers[provider] as Record<string, string>;
  return scenarios[scenario] ?? null;
}

export function isLaunchLabProvider(
  value: string
): value is LaunchLabProvider {
  return Object.hasOwn(matrix.providers, value);
}

export async function presentLaunchLabRun(
  db: D1Database,
  runId: string
): Promise<Record<string, unknown> | null> {
  const run = await loadLaunchLabRun(db, runId);
  if (!run) return null;
  const scenarios = (await loadScenarioRows(db, runId)).map((row) => ({
      provider: row.provider,
      scenario: row.scenario,
      expectedStatus: row.expected_status,
      state: row.state,
      observedStatus: row.observed_status,
      failureCode: row.failure_code
    }));
  return {
    schemaVersion: "dust-wave-launch-lab-run-v1",
    runId: run.id,
    sourceCommit: run.source_commit,
    status: run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    scenarios,
    passed: scenarios.length > 0
      && scenarios.every(({ state }) => state === "passed"),
    launchGateEligible: false
  };
}

async function loadScenarioRows(
  db: D1Database,
  runId: string
): Promise<LaunchLabScenarioRow[]> {
  return (await db.prepare(SCENARIO_LIST_QUERY)
    .bind(runId)
    .all<LaunchLabScenarioRow>()).results;
}

function matrixEntries(): Array<{
  provider: LaunchLabProvider;
  scenario: string;
  expectedStatus: string;
}> {
  return Object.entries(matrix.providers).flatMap(([provider, scenarios]) =>
    Object.entries(scenarios).map(([scenario, expectedStatus]) => ({
      provider: provider as LaunchLabProvider,
      scenario,
      expectedStatus
    }))
  );
}

function launchLabScenarioId(
  runId: string,
  provider: LaunchLabProvider,
  scenario: string
): string {
  return `lab_${runId}_${provider}_${scenario}`;
}

export async function refreshLaunchLabRunStatus(
  db: D1Database,
  runId: string
): Promise<void> {
  await db.prepare(
    `UPDATE launch_lab_runs
     SET
       status = CASE
         WHEN EXISTS (
           SELECT 1 FROM launch_lab_provider_scenarios scenario
           WHERE scenario.run_id = launch_lab_runs.id
             AND scenario.state = 'failed'
         ) THEN 'failed'
         WHEN EXISTS (
           SELECT 1 FROM launch_lab_provider_scenarios scenario
           WHERE scenario.run_id = launch_lab_runs.id
             AND scenario.state IN ('pending', 'running')
         ) OR NOT EXISTS (
           SELECT 1 FROM launch_lab_provider_scenarios scenario
           WHERE scenario.run_id = launch_lab_runs.id
         ) THEN 'running'
         ELSE 'passed'
       END,
       completed_at = CASE
         WHEN EXISTS (
           SELECT 1 FROM launch_lab_provider_scenarios scenario
           WHERE scenario.run_id = launch_lab_runs.id
         ) AND NOT EXISTS (
           SELECT 1 FROM launch_lab_provider_scenarios scenario
           WHERE scenario.run_id = launch_lab_runs.id
             AND scenario.state IN ('pending', 'running')
         ) THEN COALESCE(completed_at, datetime('now'))
         ELSE NULL
       END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(runId).run();
}

async function loadLaunchLabRun(
  db: D1Database,
  runId: string
): Promise<LaunchLabRunRow | null> {
  return db.prepare(RUN_SELECT_QUERY).bind(runId).first<LaunchLabRunRow>();
}
