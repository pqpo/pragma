import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const E2E_GROUPS = [
  "cold",
  "new",
  "warm",
  "four-missions",
  "immediate-visible",
  "immediate-core",
  "immediate-paint",
  "active-enqueue",
  "active-try-steer",
];
export const E2E_METRICS = [
  "missionCreateMs",
  "clickToDispatchMs",
  "durableAcceptToControlAvailableMs",
  "runtimeTextToPaintMs",
  "runtimeReasoningToPaintMs",
  "clickToFirstTextMs",
  "clickToFirstReasoningMs",
  "clickToTextPaintMs",
  "clickToReasoningPaintMs",
  "sdkTextTtftMs",
  "sdkReasoningTtftMs",
  "sdkDurationMs",
  "modelEndToCoreTerminalMs",
  "coreTerminalToPaintMs",
  "sessionReleaseAfterCoreMs",
  "observerAfterCoreMs",
  "triggerToNextDispatchMs",
  "observedTriggerToNextDispatchMs",
  "coreTerminalRelayDelayMs",
  "previousCoreTerminalToNextDispatchMs",
];
export function difference(end, start) {
  return !Number.isFinite(end) || !Number.isFinite(start)
    ? null
    : Math.round((end - start) * 100) / 100;
}
export function summarize(rounds) {
  return Object.fromEntries(
    E2E_METRICS.map((metric) => {
      const values = [];
      const excludedReasons = {};
      for (const round of rounds) {
        const reasons = [];
        if (round.error) reasons.push("round-error");
        if (round.status !== "succeeded") reasons.push("round-not-succeeded");
        if (!Array.isArray(round.measurementIssues)) reasons.push("round-not-enriched");
        else reasons.push(...round.measurementIssues.map((issue) => `measurement:${issue}`));
        if (!Number.isFinite(round[metric])) reasons.push("metric-unavailable");
        else if (round[metric] < 0) reasons.push("metric-negative");
        if (reasons.length) {
          for (const reason of new Set(reasons))
            excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
        } else values.push(round[metric]);
      }
      values.sort((a, b) => a - b);
      return [
        metric,
        {
          samples: values.length,
          totalRounds: rounds.length,
          excluded: rounds.length - values.length,
          excludedReasons,
          p50: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)] ?? null,
          p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null,
        },
      ];
    }),
  );
}
export function summarizeByRole(rounds) {
  return Object.fromEntries(
    [...new Set(rounds.map((round) => round.role ?? "unspecified"))].map((role) => [
      role,
      summarize(rounds.filter((round) => (round.role ?? "unspecified") === role)),
    ]),
  );
}
const hasIdentity = (value) => typeof value === "string" && value.length > 0;
export function enrichRound(round, records) {
  const owned = hasIdentity(round.executionId)
    ? records.filter(
        (record) =>
          record.scope?.executionId === round.executionId ||
          record.attributes?.executionId === round.executionId,
      )
    : [];
  const timestamp = (event, entries = owned) => {
    const at = entries
      .filter(
        (entry) =>
          entry.event === event &&
          (!event.startsWith("runtime.") || Date.parse(entry.occurredAt) >= round.clickAt),
      )
      .map((entry) => Date.parse(entry.occurredAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    return at;
  };
  const dispatch = timestamp("runtime.model_request_dispatched");
  const finished = timestamp("runtime.model_request_finished");
  const terminal = timestamp("execution.terminal_committed");
  const release = timestamp("session.active_binding_released");
  const observer = timestamp("mission.observer_settled");
  const runtimeText = timestamp("runtime.first_text_delta");
  const runtimeReasoning = timestamp("runtime.first_reasoning_delta");
  // Consuming steer in the current Execution does not imply a new native request.
  // Its pre-click dispatch/first delta cannot become steer SDK latency samples.
  const previousTerminal = hasIdentity(round.previousExecutionId)
    ? timestamp(
        "execution.terminal_committed",
        records.filter(
          (record) =>
            record.scope?.executionId === round.previousExecutionId ||
            record.attributes?.executionId === round.previousExecutionId,
        ),
      )
    : undefined;
  const acceptance = (hasIdentity(round.missionId) ? records : [])
    .filter(
      (record) =>
        record.event === "mission.inbox_durable" &&
        (record.scope?.missionId === round.missionId ||
          record.attributes?.missionId === round.missionId) &&
        (!round.requestId ||
          record.attributes?.requestId === round.requestId ||
          record.scope?.requestId === round.requestId) &&
        Date.parse(record.occurredAt) >= round.clickAt,
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0];
  const accepted = acceptance ? Date.parse(acceptance.occurredAt) : undefined;
  const controlAvailable = round.controlUpdates?.find((update) => update.at >= accepted)?.at;
  Object.assign(round, {
    missionCreateMs: difference(round.createFinishedAt, round.createStartedAt),
    clickToDispatchMs: difference(dispatch, round.clickAt),
    durableAcceptToControlAvailableMs: difference(controlAvailable, accepted),
    runtimeTextToPaintMs: difference(round.textPaintAt, runtimeText),
    runtimeReasoningToPaintMs: difference(round.reasoningPaintAt, runtimeReasoning),
    clickToFirstTextMs: difference(runtimeText, round.clickAt),
    clickToFirstReasoningMs: difference(runtimeReasoning, round.clickAt),
    clickToTextPaintMs: difference(round.textPaintAt, round.clickAt),
    clickToReasoningPaintMs: difference(round.reasoningPaintAt, round.clickAt),
    sdkTextTtftMs: difference(runtimeText, dispatch),
    sdkReasoningTtftMs: difference(runtimeReasoning, dispatch),
    sdkDurationMs: difference(finished, dispatch),
    modelEndToCoreTerminalMs: difference(terminal, finished),
    coreTerminalToPaintMs: difference(round.terminalPaintAt, terminal),
    sessionReleaseAfterCoreMs: difference(release, terminal),
    observerAfterCoreMs: difference(observer, terminal),
    triggerToNextDispatchMs: difference(dispatch, round.triggerAt),
    observedTriggerToNextDispatchMs: difference(dispatch, round.triggerObservedAt),
    previousCoreTerminalToNextDispatchMs: difference(dispatch, previousTerminal),
    timeline: {
      dispatch,
      accepted,
      controlAvailable,
      finished,
      terminal,
      release,
      observer,
      runtimeText,
      runtimeReasoning,
      previousTerminal,
    },
  });
  const required = [
    "clickToDispatchMs",
    "clickToFirstTextMs",
    "modelEndToCoreTerminalMs",
    "sessionReleaseAfterCoreMs",
  ];
  if (round.presentation === "foreground-ui")
    required.push("runtimeTextToPaintMs", "coreTerminalToPaintMs");
  round.measurementIssues = required.filter(
    (metric) => !Number.isFinite(round[metric]) || round[metric] < 0,
  );
  if (!hasIdentity(round.executionId))
    round.measurementIssues.push("execution-identity-unavailable");
  if (
    round.group === "active-try-steer" &&
    round.role === "followup" &&
    round.steerVerification?.consumed !== true
  )
    round.measurementIssues.push("steer-consumption-unverified");
  if (round.triggerSource === "mission-status-terminal")
    round.measurementIssues.push("exact-core-trigger-unavailable");
  return round;
}

/** A job claim is not model load. Require a correlated, complete Runtime attempt
 * whose native-call interval intersects an actual foreground round. */
export function verifyBackgroundModelOverlap(background, rounds, records) {
  if (!background?.enabled) return background;
  const runs = [background.before, background.measurementStart, background.after]
    .flatMap((snapshot) => snapshot?.curatorRuns ?? [])
    .filter(
      (run) =>
        ["episodic", "semantic"].includes(run.module) &&
        hasIdentity(run.runId) &&
        hasIdentity(run.missionId),
    );
  const uniqueRuns = [...new Map(runs.map((run) => [run.runId, run])).values()];
  const overlapEvidence = [];
  for (const run of uniqueRuns) {
    const owned = records.filter(
      (record) =>
        record.scope?.missionId === run.missionId ||
        record.attributes?.missionId === run.missionId ||
        (hasIdentity(run.executionId) &&
          (record.scope?.executionId === run.executionId ||
            record.attributes?.executionId === run.executionId)),
    );
    for (const dispatch of owned.filter(
      (record) => record.event === "runtime.model_request_dispatched",
    )) {
      // All parts must be present: two missing identities cannot prove correlation.
      // attempt alone is reused by subsequent Runtime invocations.
      const completeIdentity = (record) =>
        hasIdentity(record.host?.bootId) &&
        hasIdentity(record.scope?.executionId ?? record.attributes?.executionId) &&
        hasIdentity(record.attributes?.runId) &&
        Number.isInteger(record.attributes?.attempt) &&
        record.attributes.attempt > 0;
      const key = (record) =>
        JSON.stringify([
          record.host?.bootId,
          record.scope?.executionId ?? record.attributes?.executionId,
          record.attributes?.runId,
          record.attributes?.attempt,
        ]);
      if (!completeIdentity(dispatch)) continue;
      const dispatchedAt = Date.parse(dispatch.occurredAt);
      const finish = owned
        .filter(
          (record) =>
            record.event === "runtime.model_request_finished" &&
            completeIdentity(record) &&
            key(record) === key(dispatch) &&
            Date.parse(record.occurredAt) >= dispatchedAt,
        )
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0];
      const finishedAt = finish ? Date.parse(finish.occurredAt) : NaN;
      if (!Number.isFinite(dispatchedAt) || !Number.isFinite(finishedAt)) continue;
      for (const round of rounds) {
        const end = round.timeline?.terminal;
        if (
          !hasIdentity(round.executionId) ||
          !Number.isFinite(round.clickAt) ||
          !Number.isFinite(end) ||
          end <= round.clickAt
        )
          continue;
        const overlapMs = Math.min(finishedAt, end) - Math.max(dispatchedAt, round.clickAt);
        if (overlapMs <= 0) continue;
        overlapEvidence.push({
          curatorRunId: run.runId,
          curatorMissionId: run.missionId,
          curatorExecutionId: dispatch.scope?.executionId ?? dispatch.attributes?.executionId,
          runtimeRunId: dispatch.attributes.runId,
          attempt: dispatch.attributes.attempt,
          dispatchedAt,
          finishedAt,
          foregroundExecutionId: round.executionId,
          foregroundClickAt: round.clickAt,
          foregroundTerminalAt: end,
          overlapMs,
        });
      }
    }
  }
  const verifiedRounds = rounds.filter((round) =>
    overlapEvidence.some(
      (evidence) =>
        evidence.foregroundExecutionId === round.executionId &&
        evidence.foregroundClickAt === round.clickAt,
    ),
  );
  for (const round of rounds) {
    round.backgroundModelOverlap = verifiedRounds.includes(round) ? "verified" : "unverified";
    if (
      round.backgroundModelOverlap !== "verified" &&
      Array.isArray(round.measurementIssues) &&
      !round.measurementIssues.includes("background-model-overlap-unverified")
    )
      round.measurementIssues.push("background-model-overlap-unverified");
  }
  const verified = rounds.length > 0 && verifiedRounds.length === rounds.length;
  background.modelOverlap = {
    status: verified ? "verified" : "unverified",
    verifiedRounds: verifiedRounds.length,
    totalRounds: rounds.length,
    evidence: overlapEvidence,
    reason: verified
      ? null
      : "Each measured round needs a correlated complete curator Runtime attempt overlapping its actual foreground interval.",
  };
  if (!verified) {
    background.failures ??= [];
    if (!background.failures.some((failure) => failure.phase === "memory-model-overlap"))
      background.failures.push({
        phase: "memory-model-overlap",
        error: background.modelOverlap.reason,
      });
  }
  return background;
}

/** Parse only the synchronous Console handler's existing Core terminal marker. */
export function parseCoreTerminalConsole(payload, producerObservedAt) {
  if (typeof payload !== "string") return null;
  const header = /^\[([^\]]+)\] INFO core\.expert-session\/execution\.terminal_committed - /u.exec(
    payload,
  );
  if (!header || !Number.isFinite(Date.parse(header[1]))) return null;
  const scope = /^ {2}scope: (.+)$/mu.exec(payload)?.[1];
  const executionId = scope ? /(?:^| )executionId=([^ ]+)/u.exec(scope)?.[1] : undefined;
  if (!executionId) return null;
  const attributePrefix = "  attributes:\n";
  const at = payload.indexOf(attributePrefix);
  let requestId;
  if (at >= 0) {
    try {
      const attributes = JSON.parse(payload.slice(at + attributePrefix.length));
      if (typeof attributes.requestId === "string" && attributes.requestId.length > 0)
        requestId = attributes.requestId;
    } catch {
      return null;
    }
  }
  if (!requestId) return null;
  return {
    event: "execution.terminal_committed",
    source: "synchronous-console-log",
    executionId,
    requestId,
    occurredAt: header[1],
    producerObservedAt,
  };
}

/** Log shutdown rotates active JSONL into gzip; both forms are measurement sources. */
export async function readDiagnosticRecords(root) {
  const records = [];
  const seen = new Set();
  const visit = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.name.startsWith("operations-") && /\.jsonl(?:\.gz)?$/u.test(item.name)) {
        const bytes = await readFile(path);
        const contents = item.name.endsWith(".gz")
          ? gunzipSync(bytes).toString("utf8")
          : bytes.toString("utf8");
        for (const line of contents.split("\n")) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          const identity =
            record.host?.bootId !== undefined && record.sequence !== undefined
              ? JSON.stringify([record.host.bootId, record.stream, record.sequence])
              : JSON.stringify(record);
          if (seen.has(identity)) continue;
          seen.add(identity);
          records.push(record);
        }
      }
    }
  };
  await visit(root);
  return records;
}
