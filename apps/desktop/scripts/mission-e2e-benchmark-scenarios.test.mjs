import assert from "node:assert/strict";
import { test } from "node:test";
import { rendererScenarioRun } from "./mission-e2e-benchmark-scenarios.mjs";

function fakeRenderer() {
  const original = {
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    document: globalThis.document,
  };
  const statusListeners = new Set();
  const subscriptions = new Set();
  const observers = new Set();
  const created = [];
  const deleted = [];
  const starts = [];
  const sends = [];
  const markers = [];
  let latest;
  let current = 0;
  let maximumConcurrent = 0;
  const emit = (missionId, id, status) => {
    latest = { missionId, id, status };
    if (status === "succeeded") {
      const marker = {
        event: "execution.terminal_committed",
        source: "synchronous-console-log",
        executionId: id,
        requestId: id.startsWith("followup-") ? sends.at(-1)?.requestId : `initial-${missionId}`,
        occurredAt: new Date(Date.now() - 5).toISOString(),
        producerObservedAt: Date.now() - 1,
      };
      markers.push(marker);
      globalThis.window.__pragmaE2ECoreTerminal?.(marker);
    }
    for (const listener of statusListeners) listener({ missionId, execution: { id, status } });
    for (const observer of observers) observer.callback();
  };
  const emitChat = (missionId, patches) => {
    for (const subscription of subscriptions)
      if (subscription.missionId === missionId) subscription.listener({ kind: "patch", patches });
  };
  const api = {
    getBridgeSnapshot: async () => ({ startup: { status: "ready" } }),
    listMissionExecutors: async () => [
      { ref: "expert:7k2m9q4v8np6r3dt", name: "Pragma", kind: "expert" },
    ],
    createMission: async () => {
      const mission = {
        id: `mission-${created.length + 1}`,
        initialMessageId: `initial-mission-${created.length + 1}`,
      };
      created.push(mission);
      latest = { missionId: mission.id };
      return mission;
    },
    subscribeMissionStatusUpdates: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    subscribeMissionChat: (missionId, listener) => {
      const subscription = { missionId, listener };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
    runMission: async (missionId) => {
      const id = `execution-${starts.length + 1}`;
      starts.push(missionId);
      current++;
      maximumConcurrent = Math.max(current, maximumConcurrent);
      emit(missionId, id, "running");
      setTimeout(() => {
        current--;
        emit(missionId, id, "succeeded");
      }, 5);
      return { execution: { id } };
    },
    sendMissionMessage: async (input) => {
      sends.push(input);
      const id = `followup-${sends.length}`;
      current++;
      maximumConcurrent = Math.max(current, maximumConcurrent);
      emit(input.id, id, "running");
      setTimeout(() => {
        current--;
        emit(input.id, id, "succeeded");
      }, 5);
      return { requestId: input.requestId, state: "accepted" };
    },
    deleteMission: async (id) => {
      deleted.push(id);
    },
  };
  globalThis.window = {
    pragmaDesktop: api,
    crypto: { randomUUID: () => `request-${sends.length + 1}` },
  };
  globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  };
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === ".navigation-item" ? [{ click() {} }, { click() {} }] : [],
    querySelector: (selector) =>
      selector === ".mission-row-open"
        ? { click() {} }
        : {
            dataset: {
              missionId: latest?.missionId,
              missionExecutionId: latest?.id,
              missionStatus: latest?.status,
            },
          },
    body: {},
  };
  return {
    created,
    deleted,
    starts,
    sends,
    markers,
    api,
    emit,
    emitChat,
    get maximumConcurrent() {
      return maximumConcurrent;
    },
    restore: () => {
      Object.assign(globalThis, original);
    },
    get listeners() {
      return statusListeners.size + subscriptions.size + observers.size;
    },
  };
}
const configuration = {
  group: "four-missions",
  samples: 1,
  workspace: "/isolated",
  providerId: "provider",
  model: "model",
  thinking: "medium",
  launchedAt: Date.now(),
  backgroundLoad: false,
};

test("starts four actual Mission API calls together and retains all independent raw samples", async () => {
  const renderer = fakeRenderer();
  try {
    const result = await rendererScenarioRun(configuration);
    assert.deepEqual(result.failures, []);
    assert.equal(renderer.maximumConcurrent, 4);
    assert.equal(result.rounds.length, 8);
    assert.equal(new Set(result.rounds.map((round) => round.executionId)).size, 8);
    assert.equal(result.rounds.filter((round) => round.role === "initial").length, 4);
    assert.equal(result.rounds.filter((round) => round.role === "followup").length, 4);
    assert.ok(
      result.rounds.every(
        (round) =>
          round.presentation === "api-background" &&
          round.status === "succeeded" &&
          round.textPaintAt === undefined,
      ),
    );
    assert.equal(renderer.deleted.length, 4);
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
test("reuses exactly four Mission owners for every requested concurrent followup round", async () => {
  const renderer = fakeRenderer();
  try {
    const result = await rendererScenarioRun({ ...configuration, samples: 3 });
    assert.deepEqual(result.failures, []);
    assert.equal(renderer.created.length, 4);
    assert.equal(renderer.starts.length, 4);
    assert.equal(renderer.sends.length, 12);
    assert.equal(renderer.maximumConcurrent, 4);
    for (const { id } of renderer.created) {
      const ownerRounds = result.rounds.filter((round) => round.missionId === id);
      assert.equal(ownerRounds.length, 4);
      assert.equal(ownerRounds[0].role, "initial");
      for (let index = 1; index < ownerRounds.length; index++) {
        assert.equal(ownerRounds[index].role, "followup");
        assert.equal(ownerRounds[index].previousExecutionId, ownerRounds[index - 1].executionId);
      }
      assert.equal(renderer.sends.filter((send) => send.id === id).length, 3);
    }
    assert.equal(renderer.deleted.length, 4);
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
test("submits a correlated followup from the Core log marker before terminal projection and separates relay time", async () => {
  const renderer = fakeRenderer();
  try {
    const result = await rendererScenarioRun({ ...configuration, group: "immediate-core" });
    assert.deepEqual(result.failures, []);
    assert.equal(renderer.sends.length, 1);
    const next = result.rounds[1];
    assert.equal(next.previousExecutionId, result.rounds[0].executionId);
    assert.equal(result.rounds[0].role, "initial");
    assert.equal(next.role, "followup");
    assert.equal(next.triggerSource, "core-terminal-log");
    assert.equal(next.triggerAt, Date.parse(renderer.markers[0].occurredAt));
    assert.equal(next.triggerCoreMarker.requestId, "initial-mission-1");
    assert.ok(next.triggerObservedAt >= next.triggerAt);
    assert.equal(next.coreTerminalRelayDelayMs, next.triggerObservedAt - next.triggerAt);
    assert.equal(next.requestId, renderer.sends[0].requestId);
    assert.equal(next.executionId, "followup-1");
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
test("retains partial samples and transport failure instead of inventing a successful result", async () => {
  const renderer = fakeRenderer();
  renderer.api.runMission = async () => {
    throw new Error("synthetic transport failure");
  };
  try {
    const result = await rendererScenarioRun(configuration);
    assert.match(result.error, /transport failure/);
    assert.equal(result.rounds.length, 4);
    assert.ok(result.rounds.every((round) => round.status === undefined));
    assert.equal(renderer.listeners, 0);
    assert.equal(renderer.deleted.length, 4);
  } finally {
    renderer.restore();
  }
});

test("synthetic background uses public Automation and Memory actions and records observed activity", async () => {
  const renderer = fakeRenderer();
  const actions = [];
  let expedited = false;
  Object.assign(renderer.api, {
    getGlobalMemoryPolicy: async () => ({ revision: 3 }),
    updateGlobalMemoryPolicy: async (input) => {
      actions.push(["policy", input]);
    },
    getMemoryExtractorProfile: async () => ({ revision: 4 }),
    getMissionModelOptions: async () => ({ runtime: { id: "pi" } }),
    updateMemoryExtractorProfile: async (input) => {
      actions.push(["profile", input]);
    },
    getPragmaProject: async () => ({ revision: 5 }),
    saveAutomation: async (input) => {
      actions.push(["save", input]);
      return { ref: "automation:7k2m9q4v8np6r3dt" };
    },
    triggerAutomation: async (ref) => {
      actions.push(["trigger", ref]);
      return { ref };
    },
    getMemoryPlaneStatus: async () => ({ feed: { eventCount: expedited ? 9 : 2 } }),
    listActiveMemoryExtractionTasks: async () =>
      expedited ? [{ module: "episodic", id: "synthetic-job", lane: "running" }] : [],
    listAutomations: async () => [],
    listMemoryExtractionJobs: async () => ({
      lanes: { waiting: { tasks: [{ module: "episodic", id: "synthetic-job", revision: 6 }] } },
    }),
    manageMemoryExtractionTask: async (input) => {
      actions.push(["expedite", input]);
      expedited = true;
    },
    getMemoryExtractionTaskDetail: async () => ({
      runs: [
        {
          runId: "curator-run",
          missionId: "curator-mission",
          module: "episodic",
          jobId: "synthetic-job",
          status: "running",
        },
      ],
    }),
  });
  globalThis.window.__pragmaE2EBaselineRun = async () => ({ rounds: [] });
  try {
    const result = await rendererScenarioRun({
      ...configuration,
      group: "new",
      backgroundLoad: true,
      dslApiVersion: "test-only-version",
    });
    assert.deepEqual(result.failures, []);
    assert.equal(actions.find(([action]) => action === "save")[1].expectedProjectRevision, 5);
    assert.deepEqual(actions.find(([action]) => action === "profile")[1].profile, {
      mode: "pinned",
      runtimeId: "pi",
      providerId: "provider",
      modelId: "model",
      thinkingLevel: "medium",
    });
    assert.deepEqual(actions.find(([action]) => action === "expedite")[1], {
      module: "episodic",
      id: "synthetic-job",
      expectedRevision: 6,
      action: "expedite",
    });
    assert.equal(result.background.observedCanonicalFeedEvents, 7);
    assert.equal(result.background.observedRunningCuratorJobs, 1);
    assert.equal(result.background.modelOverlap.status, "pending-diagnostic-verification");
    assert.equal(result.background.curatorOverlapObservedAtMeasurementStart, undefined);
    assert.equal(result.background.measurementStart.curatorRuns[0].missionId, "curator-mission");
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});

function configureSteer(renderer, { outcome = "steered", consumed = false } = {}) {
  renderer.api.runMission = async (missionId) => {
    renderer.emit(missionId, "active-execution", "running");
    setTimeout(
      () =>
        renderer.emitChat(missionId, [
          {
            type: "entry.upsert",
            entry: {
              id: "initial-assistant",
              executionId: "active-execution",
              kind: "assistant",
              content: "1. Original measurement principle",
              streaming: true,
            },
          },
        ]),
      1,
    );
    return { execution: { id: "active-execution" } };
  };
  renderer.api.sendMissionMessage = async (input) => {
    renderer.sends.push(input);
    return { requestId: input.requestId, state: "accepted" };
  };
  renderer.api.trySteerQueuedMissionMessage = async ({ id }) => {
    const marker = /PRAGMA_STEER_[\w]+/u.exec(renderer.sends.at(-1).content)[0];
    setTimeout(() => {
      if (consumed)
        renderer.emitChat(id, [
          { type: "entry.append", entryId: "initial-assistant", delta: `\n${marker}` },
        ]);
      renderer.emit(id, "active-execution", "succeeded");
      if (outcome === "retained") {
        renderer.emit(id, "queued-execution", "running");
        setTimeout(() => renderer.emit(id, "queued-execution", "succeeded"), 1);
      }
    }, 5);
    return {
      queueSteer:
        outcome === "steered"
          ? { outcome, executionId: "active-execution" }
          : { outcome, reason: "runtime_unsupported" },
    };
  };
}
test("an unsupported retained steer stays unverified even when the queued followup succeeds", async () => {
  const renderer = fakeRenderer();
  configureSteer(renderer, { outcome: "retained" });
  try {
    const result = await rendererScenarioRun({ ...configuration, group: "active-try-steer" });
    const next = result.rounds[1];
    assert.equal(next.status, "succeeded");
    assert.equal(next.executionId, "queued-execution");
    assert.equal(next.steerVerification.acknowledged, false);
    assert.equal(next.steerVerification.consumed, false);
    assert.match(next.error, /not delivered/);
    assert.equal(result.failures[0].phase, "steer-delivery");
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
test("an SDK ACK and successful original terminal cannot prove steer consumption", async () => {
  const renderer = fakeRenderer();
  configureSteer(renderer);
  try {
    const result = await rendererScenarioRun({ ...configuration, group: "active-try-steer" });
    const next = result.rounds[1];
    assert.equal(next.status, "succeeded");
    assert.equal(next.steerVerification.acknowledged, true);
    assert.equal(next.steerVerification.consumed, false);
    assert.equal(next.steerVerification.evidence, null);
    assert.equal(result.failures[0].phase, "steer-consumption");
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
test("only the unique marker in the original target's assistant output verifies consumption", async () => {
  const renderer = fakeRenderer();
  configureSteer(renderer, { consumed: true });
  try {
    const result = await rendererScenarioRun({ ...configuration, group: "active-try-steer" });
    const next = result.rounds[1];
    assert.deepEqual(result.failures, []);
    assert.equal(next.steerVerification.consumed, true);
    assert.equal(next.steerVerification.evidence.executionId, result.rounds[0].executionId);
    assert.equal(next.steerVerification.evidence.source, "assistant-output");
    assert.equal(next.steerVerification.evidence.marker, next.steerVerification.marker);
    assert.equal(next.error, undefined);
    assert.equal(renderer.listeners, 0);
  } finally {
    renderer.restore();
  }
});
