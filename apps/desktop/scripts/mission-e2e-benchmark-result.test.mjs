import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  enrichRound,
  summarize,
  summarizeByRole,
  verifyBackgroundModelOverlap,
  difference,
  parseCoreTerminalConsole,
  readDiagnosticRecords,
} from "./mission-e2e-benchmark-result.mjs";

const record = (event, executionId, at) => ({
  event,
  scope: { executionId },
  occurredAt: new Date(at).toISOString(),
});
test("missing and negative measurements never become percentile samples", () => {
  assert.equal(difference(undefined, 10), null);
  const summary = summarize([
    { status: "succeeded", measurementIssues: [], clickToDispatchMs: null },
    { status: "succeeded", measurementIssues: [], clickToDispatchMs: -1 },
    { status: "succeeded", measurementIssues: [], clickToDispatchMs: 3 },
  ]);
  assert.deepEqual(summary.clickToDispatchMs, {
    samples: 1,
    totalRounds: 3,
    excluded: 2,
    excludedReasons: { "metric-unavailable": 1, "metric-negative": 1 },
    p50: 3,
    p95: 3,
  });
  assert.deepEqual(summary.runtimeTextToPaintMs, {
    samples: 0,
    totalRounds: 3,
    excluded: 3,
    excludedReasons: { "metric-unavailable": 3 },
    p50: null,
    p95: null,
  });
});
test("an unadmitted partial round cannot borrow another Execution's runtime or terminal facts", () => {
  const round = enrichRound(
    {
      missionId: "failed-mission",
      clickAt: 1000,
      presentation: "api-background",
      error: "transport failure",
    },
    [
      record("runtime.model_request_dispatched", "other", 1010),
      record("runtime.first_text_delta", "other", 1020),
      record("runtime.model_request_finished", "other", 1040),
      record("execution.terminal_committed", "other", 1050),
      record("session.active_binding_released", "other", 1052),
    ],
  );
  for (const metric of [
    "clickToDispatchMs",
    "clickToFirstTextMs",
    "sdkDurationMs",
    "modelEndToCoreTerminalMs",
    "sessionReleaseAfterCoreMs",
  ])
    assert.equal(round[metric], null, metric);
  assert.ok(round.measurementIssues.includes("execution-identity-unavailable"));
  assert.equal(summarize([round]).clickToDispatchMs.samples, 0);
});
test("failed, partial and invalid rounds stay excluded with explicit reasons and roles stay separate", () => {
  const rounds = [
    { role: "initial", status: "succeeded", measurementIssues: [], clickToDispatchMs: 100 },
    { role: "followup", status: "succeeded", measurementIssues: [], clickToDispatchMs: 10 },
    {
      role: "followup",
      status: "failed",
      error: "provider failed",
      measurementIssues: [],
      clickToDispatchMs: 1,
    },
    {
      role: "followup",
      status: "succeeded",
      error: "paint timed out",
      measurementIssues: [],
      clickToDispatchMs: 2,
    },
    {
      role: "followup",
      status: "succeeded",
      measurementIssues: ["sessionReleaseAfterCoreMs"],
      clickToDispatchMs: 3,
    },
    { role: "followup", clickToDispatchMs: 4 },
  ];
  const aggregate = summarize(rounds).clickToDispatchMs;
  assert.equal(aggregate.samples, 2);
  assert.equal(aggregate.excluded, 4);
  assert.equal(aggregate.excludedReasons["round-error"], 2);
  assert.equal(aggregate.excludedReasons["round-not-succeeded"], 2);
  assert.equal(aggregate.excludedReasons["measurement:sessionReleaseAfterCoreMs"], 1);
  const byRole = summarizeByRole(rounds);
  assert.equal(byRole.initial.clickToDispatchMs.p95, 100);
  assert.equal(byRole.followup.clickToDispatchMs.p95, 10);
  assert.equal(byRole.followup.clickToDispatchMs.excluded, 4);
  assert.equal(rounds.length, 6);
});
test("separates real model milestones, previous terminal and missing foreground paint", () => {
  const round = enrichRound(
    {
      executionId: "next",
      previousExecutionId: "prior",
      missionId: "mission",
      clickAt: 1000,
      triggerAt: 1000,
      presentation: "api-background",
      triggerSource: "mission-status-terminal",
    },
    [
      record("execution.terminal_committed", "prior", 900),
      record("runtime.model_request_dispatched", "next", 1010),
      record("runtime.first_reasoning_delta", "next", 1030),
      record("runtime.first_text_delta", "next", 1040),
      record("runtime.model_request_finished", "next", 1050),
      record("execution.terminal_committed", "next", 1060),
      record("session.active_binding_released", "next", 1062),
    ],
  );
  assert.equal(round.clickToFirstTextMs, 40);
  assert.equal(round.clickToFirstReasoningMs, 30);
  assert.equal(round.triggerToNextDispatchMs, 10);
  assert.equal(round.previousCoreTerminalToNextDispatchMs, 110);
  assert.equal(round.runtimeTextToPaintMs, null);
  assert.deepEqual(round.measurementIssues, ["exact-core-trigger-unavailable"]);
});
test("does not use a different concurrent request's Inbox acceptance", () => {
  const round = enrichRound(
    {
      executionId: "next",
      missionId: "mission",
      requestId: "two",
      clickAt: 1000,
      controlUpdates: [{ at: 1015 }, { at: 1025 }],
    },
    [
      {
        event: "mission.inbox_durable",
        scope: { missionId: "mission" },
        attributes: { requestId: "one" },
        occurredAt: new Date(1010).toISOString(),
      },
      {
        event: "mission.inbox_durable",
        scope: { missionId: "mission" },
        attributes: { requestId: "two" },
        occurredAt: new Date(1020).toISOString(),
      },
    ],
  );
  assert.equal(round.timeline.accepted, 1020);
  assert.equal(round.durableAcceptToControlAvailableMs, 5);
});

test("parses only an exact Core terminal marker with execution and request correlation", () => {
  const payload =
    "[2026-10-02T08:00:00.000Z] INFO core.expert-session/execution.terminal_committed - Expert turn terminal fact committed\n" +
    "  stream: operation\n  sequence: 18\n  host: kind=desktop bootId=boot\n" +
    "  scope: processKind=desktop-main expertSessionId=session executionId=execution\n" +
    '  attributes:\n    {\n      "requestId": "request",\n      "elapsedMs": 2\n    }';
  assert.deepEqual(parseCoreTerminalConsole(payload, 100), {
    event: "execution.terminal_committed",
    source: "synchronous-console-log",
    executionId: "execution",
    requestId: "request",
    occurredAt: "2026-10-02T08:00:00.000Z",
    producerObservedAt: 100,
  });
  assert.equal(
    parseCoreTerminalConsole(
      payload.replace("execution.terminal_committed", "mission.observer_settled"),
      100,
    ),
    null,
  );
  assert.equal(parseCoreTerminalConsole(payload.replace("executionId=execution", ""), 100), null);
  assert.equal(
    parseCoreTerminalConsole(payload.replace("requestId", "differentAttribute"), 100),
    null,
  );
  assert.equal(
    parseCoreTerminalConsole(payload.replace("2026-10-02T08:00:00.000Z", "invalid-time"), 100),
    null,
  );
});

test("loads shutdown-compressed diagnostics, deduplicates live copies and retains another boot's sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-e2e-diagnostics-"));
  try {
    const nested = join(root, "boot-a");
    await mkdir(nested);
    const first = {
      ...record("execution.terminal_committed", "one", 1000),
      host: { bootId: "a" },
      sequence: 1,
      stream: "operation",
    };
    const second = {
      ...record("runtime.model_request_dispatched", "two", 1001),
      host: { bootId: "b" },
      sequence: 1,
      stream: "operation",
    };
    const line = JSON.stringify(first) + "\n";
    await writeFile(join(nested, "operations-0001.jsonl"), line);
    await writeFile(join(nested, "operations-0001.jsonl.gz"), gzipSync(line));
    await writeFile(
      join(root, "operations-0002.jsonl.gz"),
      gzipSync(JSON.stringify(second) + "\n"),
    );
    const records = await readDiagnosticRecords(root);
    assert.equal(records.length, 2);
    assert.deepEqual(
      new Set(records.map((entry) => entry.scope.executionId)),
      new Set(["one", "two"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core fact-to-dispatch includes relay delay without moving the Core timestamp to UI receipt", () => {
  const round = enrichRound(
    {
      executionId: "next",
      missionId: "mission",
      clickAt: 1012,
      triggerAt: 1000,
      triggerObservedAt: 1010,
      triggerSource: "core-terminal-log",
      coreTerminalRelayDelayMs: 10,
    },
    [record("runtime.model_request_dispatched", "next", 1020)],
  );
  assert.equal(round.triggerAt, 1000);
  assert.equal(round.triggerToNextDispatchMs, 20);
  assert.equal(round.observedTriggerToNextDispatchMs, 10);
  assert.equal(round.coreTerminalRelayDelayMs, 10);
  assert.equal(round.measurementIssues.includes("exact-core-trigger-unavailable"), false);
});

const curatorRecord = (event, at, attempt = 1, runId = "native-run") => ({
  ...record(event, "curator-execution", at),
  host: { bootId: "curator-boot" },
  scope: { missionId: "curator-mission", executionId: "curator-execution" },
  attributes: { runId, attempt },
});
test("consumed steer keeps pre-click native dispatch and first deltas unavailable", () => {
  const round = enrichRound(
    {
      group: "active-try-steer",
      role: "followup",
      executionId: "current",
      previousExecutionId: "current",
      status: "succeeded",
      clickAt: 1000,
      presentation: "foreground-ui",
      textPaintAt: 1030,
      terminalPaintAt: 1080,
      steerVerification: { acknowledged: true, consumed: true, marker: "UNIQUE_STEER_MARKER" },
    },
    [
      record("runtime.model_request_dispatched", "current", 900),
      record("runtime.first_text_delta", "current", 920),
      record("runtime.first_reasoning_delta", "current", 910),
      record("runtime.model_request_finished", "current", 1050),
      record("execution.terminal_committed", "current", 1060),
      record("session.active_binding_released", "current", 1062),
    ],
  );
  for (const metric of [
    "clickToDispatchMs",
    "clickToFirstTextMs",
    "sdkTextTtftMs",
    "sdkReasoningTtftMs",
    "runtimeTextToPaintMs",
    "clickToFirstReasoningMs",
  ])
    assert.equal(round[metric], null, metric);
  assert.equal(round.timeline.dispatch, undefined);
  assert.equal(round.timeline.runtimeText, undefined);
  assert.equal(round.modelEndToCoreTerminalMs, 10);
  assert.ok(round.measurementIssues.includes("clickToDispatchMs"));
  assert.ok(round.measurementIssues.includes("clickToFirstTextMs"));
  assert.equal(round.measurementIssues.includes("steer-consumption-unverified"), false);
  const summary = summarize([round]);
  assert.equal(summary.clickToDispatchMs.samples, 0);
  assert.equal(summary.sdkTextTtftMs.p95, null);
  assert.equal(summary.modelEndToCoreTerminalMs.samples, 0);
  assert.equal(
    summary.modelEndToCoreTerminalMs.excludedReasons["measurement:clickToDispatchMs"],
    1,
  );
});
const backgroundFixture = () => ({
  enabled: true,
  failures: [],
  measurementStart: {
    activeTasks: [{ module: "episodic", lane: "running" }],
    curatorRuns: [
      {
        module: "episodic",
        runId: "curator-run",
        missionId: "curator-mission",
        executionId: "curator-execution",
      },
    ],
  },
});
const foregroundFixture = (clickAt = 1000, terminal = 1100, executionId = "foreground") => ({
  executionId,
  clickAt,
  timeline: { terminal },
  measurementIssues: [],
});
test("job running and non-overlapping or incomplete Runtime records cannot verify model load", () => {
  for (const records of [
    [],
    [curatorRecord("runtime.model_request_dispatched", 1010)],
    [
      curatorRecord("runtime.model_request_dispatched", 800),
      curatorRecord("runtime.model_request_finished", 900),
    ],
    [
      curatorRecord("runtime.model_request_dispatched", 1010),
      curatorRecord("runtime.model_request_finished", 1090, 2),
    ],
    [
      curatorRecord("runtime.model_request_dispatched", 1010),
      curatorRecord("runtime.model_request_finished", 1090, 1, "another-run"),
    ],
  ]) {
    const background = backgroundFixture();
    const round = foregroundFixture();
    verifyBackgroundModelOverlap(background, [round], records);
    assert.equal(background.modelOverlap.status, "unverified");
    assert.equal(background.modelOverlap.evidence.length, 0);
    assert.equal(background.failures[0].phase, "memory-model-overlap");
    assert.ok(round.measurementIssues.includes("background-model-overlap-unverified"));
  }
});
test("missing boot, Execution, runtime run or attempt identity never pairs background records", () => {
  const pair = [
    curatorRecord("runtime.model_request_dispatched", 1010),
    curatorRecord("runtime.model_request_finished", 1090),
  ];
  for (const removeIdentity of [
    (record) => {
      delete record.host.bootId;
    },
    (record) => {
      delete record.scope.executionId;
    },
    (record) => {
      delete record.attributes.runId;
    },
    (record) => {
      delete record.attributes.attempt;
    },
  ]) {
    for (const missingSide of ["dispatch", "finish", "both"]) {
      const records = structuredClone(pair);
      if (missingSide !== "finish") removeIdentity(records[0]);
      if (missingSide !== "dispatch") removeIdentity(records[1]);
      const background = backgroundFixture();
      verifyBackgroundModelOverlap(background, [foregroundFixture()], records);
      assert.equal(background.modelOverlap.status, "unverified", missingSide);
      assert.deepEqual(background.modelOverlap.evidence, []);
    }
  }
  const otherBoot = structuredClone(pair);
  otherBoot[1].host.bootId = "different-boot";
  const background = backgroundFixture();
  verifyBackgroundModelOverlap(background, [foregroundFixture()], otherBoot);
  assert.equal(background.modelOverlap.status, "unverified");
});
test("model overlap requires a real paired curator interval for each measured foreground round", () => {
  const background = backgroundFixture();
  const first = foregroundFixture();
  const second = foregroundFixture(1200, 1300, "second");
  const records = [
    curatorRecord("runtime.model_request_dispatched", 1010),
    curatorRecord("runtime.model_request_finished", 1090),
  ];
  verifyBackgroundModelOverlap(background, [first, second], records);
  assert.equal(background.modelOverlap.status, "unverified");
  assert.equal(background.modelOverlap.verifiedRounds, 1);
  assert.equal(first.backgroundModelOverlap, "verified");
  assert.equal(second.backgroundModelOverlap, "unverified");
  const valid = backgroundFixture();
  verifyBackgroundModelOverlap(valid, [foregroundFixture()], records);
  assert.equal(valid.modelOverlap.status, "verified");
  assert.equal(valid.modelOverlap.evidence[0].overlapMs, 80);
  assert.deepEqual(valid.failures, []);
});
