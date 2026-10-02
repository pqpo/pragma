/* global window, document, requestAnimationFrame, MutationObserver */
/** Serialized into the isolated production renderer; keep this function self-contained. */
export async function rendererScenarioRun(configuration) {
  const api = window.pragmaDesktop;
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  const wait = async (check, name, budget = 120_000) => {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await delay(20);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const painted = () =>
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const rounds = [];
  const failures = [];
  const cleanups = [];
  const missions = [];
  const background = {
    enabled: configuration.backgroundLoad,
    triggers: [],
    expedites: [],
    failures: [],
  };
  let startup;
  let backgroundTimer;
  let triggerPending = false;
  const coreMarkers = new Map();
  const coreListeners = new Set();
  const previousCoreCallback = window.__pragmaE2ECoreTerminal;
  window.__pragmaE2ECoreTerminal = (marker) => {
    if (
      marker?.event !== "execution.terminal_committed" ||
      marker.source !== "synchronous-console-log" ||
      typeof marker.executionId !== "string" ||
      typeof marker.requestId !== "string" ||
      !Number.isFinite(Date.parse(marker.occurredAt))
    )
      return;
    const observedAt = Date.now();
    const observed = {
      ...marker,
      observedAt,
      relayDelayMs: observedAt - Date.parse(marker.occurredAt),
    };
    coreMarkers.set(marker.executionId, observed);
    if (coreMarkers.size > 256) coreMarkers.delete(coreMarkers.keys().next().value);
    for (const listener of coreListeners) listener(observed);
  };
  cleanups.push(() => {
    window.__pragmaE2ECoreTerminal = previousCoreCallback;
    coreListeners.clear();
    coreMarkers.clear();
  });
  try {
    await wait(
      () => api.getBridgeSnapshot().then((value) => value.startup.status === "ready"),
      "Bridge startup",
    );
    startup = {
      launchedAt: configuration.launchedAt,
      processStartedAt: configuration.processStartedAt,
      windowCreatedAt: configuration.windowCreatedAt,
      rendererLoadedAt: configuration.rendererLoadedAt,
      bridgeReadyAt: Date.now(),
      startupMs: Date.now() - configuration.launchedAt,
    };
    const executors = await api.listMissionExecutors();
    const executor =
      executors.find((entry) => entry.name === "Pragma" && entry.kind !== "flow") ??
      executors.find((entry) => entry.kind === "expert");
    if (!executor) throw new Error("No Expert executor.");
    const modelOverride = {
      providerId: configuration.providerId,
      modelId: configuration.model,
      thinkingLevel: configuration.thinking,
    };
    const shortPrompt = "只回复ok，不要调用工具。";
    const longPrompt =
      "这是隔离的合成性能测试。请输出 40 行简短编号，每行说明一次测量原则，不要调用工具。";
    const terminal = new Map();
    cleanups.push(
      api.subscribeMissionStatusUpdates((update) => {
        if (
          update.execution &&
          ["succeeded", "failed", "cancelled"].includes(update.execution.status)
        )
          terminal.set(update.execution.id, update.execution.status);
      }),
    );
    const snapshotBackground = async () => {
      const at = Date.now();
      const memory = await api.getMemoryPlaneStatus();
      const activeTasks = await api.listActiveMemoryExtractionTasks();
      const tasks = [
        ...new Map(
          [...activeTasks, ...background.expedites]
            .filter((task) => ["episodic", "semantic"].includes(task.module))
            .map((task) => [`${task.module}:${task.id}`, task]),
        ).values(),
      ];
      const curatorRuns = [];
      for (const task of tasks) {
        try {
          const detail = await api.getMemoryExtractionTaskDetail({
            module: task.module,
            id: task.id,
          });
          for (const run of detail.runs)
            curatorRuns.push({
              runId: run.runId,
              missionId: run.missionId,
              module: run.module,
              jobId: run.jobId,
              status: run.status,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              executionId: run.chat?.execution?.id,
            });
        } catch (error) {
          background.failures.push({
            phase: "memory-run-observation",
            module: task.module,
            id: task.id,
            error: error.message,
          });
        }
      }
      return { at, memory, activeTasks, curatorRuns, automations: await api.listAutomations() };
    };
    const triggerBackground = async () => {
      if (triggerPending) return;
      triggerPending = true;
      try {
        background.triggers.push({
          at: Date.now(),
          result: await api.triggerAutomation(background.automationRef),
        });
      } catch (error) {
        background.failures.push({ phase: "automation-trigger", error: error.message });
      } finally {
        triggerPending = false;
      }
    };
    if (configuration.backgroundLoad) {
      const policy = await api.getGlobalMemoryPolicy();
      await api.updateGlobalMemoryPolicy({
        expectedRevision: policy.revision,
        policy: { enabled: "enabled", capture: "enabled", recall: "enabled", learning: "disabled" },
      });
      const profile = await api.getMemoryExtractorProfile();
      const options = await api.getMissionModelOptions(executor.ref);
      await api.updateMemoryExtractorProfile({
        expectedRevision: profile.revision,
        profile: { mode: "pinned", runtimeId: options.runtime.id, ...modelOverride },
      });
      const project = await api.getPragmaProject();
      const automation = await api.saveAutomation({
        expectedProjectRevision: project.revision,
        resource: {
          apiVersion: configuration.dslApiVersion,
          kind: "Automation",
          metadata: {
            id: "7k2m9q4v8np6r3dt",
            name: "Synthetic benchmark background",
            description: "Isolated benchmark data only",
            tags: [],
          },
          spec: {
            adapter: "pragma.automation.schedule@v1",
            binding: "binding:desktop-automation",
            config: {
              trigger: { kind: "calendar", frequency: "daily", time: "00:00", timezone: "UTC" },
            },
            enabled: true,
            route: {
              executor: { ref: executor.ref },
              input: {
                kind: "prompt",
                value:
                  "Synthetic Alpha project chose measured evidence for release decisions. Explain this decision in one concise paragraph. Do not call tools.",
              },
            },
            interaction: { mode: "new-mission" },
            delivery: { adapter: "pragma.automation.delivery.local@v1" },
          },
        },
        binding: {
          workspace: configuration.workspace,
          toolPermissionMode: "request-approval",
          modelOverride,
        },
      });
      background.automationRef = automation.ref;
      background.before = await snapshotBackground();
      await triggerBackground();
      // Use the real queue and public CAS expedite action to seed ordinary curator work.
      // Do not alter production idle policy or manufacture Evidence/Memory counts.
      try {
        const tasks = await wait(
          async () => {
            const board = await api.listMemoryExtractionJobs({
              pages: Object.fromEntries(
                ["waiting", "attention", "running", "completed"].map((lane) => [
                  lane,
                  { pageIndex: 0 },
                ]),
              ),
            });
            const waiting = board.lanes.waiting.tasks.filter((task) =>
              ["episodic", "semantic"].includes(task.module),
            );
            return waiting.length ? waiting : undefined;
          },
          "Synthetic Memory evidence",
          60_000,
        );
        for (const task of tasks.slice(0, 2)) {
          await api.manageMemoryExtractionTask({
            module: task.module,
            id: task.id,
            expectedRevision: task.revision,
            action: "expedite",
          });
          background.expedites.push({ at: Date.now(), module: task.module, id: task.id });
        }
      } catch (error) {
        background.failures.push({ phase: "memory-seed", error: error.message });
      }
      background.measurementStart = await snapshotBackground();
      backgroundTimer = setInterval(() => {
        void triggerBackground();
      }, 15_000);
    }
    if (["cold", "new", "warm"].includes(configuration.group)) {
      const result = await window.__pragmaE2EBaselineRun(configuration);
      rounds.push(...result.rounds);
      failures.push(...(result.failures ?? []));
      if (result.error) failures.push({ phase: "baseline-renderer", error: result.error });
    } else {
      const create = async (foreground, prompt = shortPrompt) => {
        const createStartedAt = Date.now();
        const mission = await api.createMission({
          workspace: configuration.workspace,
          executor: { ref: executor.ref },
          input: { kind: "prompt", value: prompt, attachments: [] },
          modelOverride,
        });
        missions.push(mission.id);
        const markers = { createStartedAt, createFinishedAt: Date.now() };
        if (foreground) {
          document.querySelectorAll(".navigation-item")[1].click();
          const row = await wait(() => document.querySelector(".mission-row-open"), "Mission row");
          row.click();
          await wait(
            () =>
              document.querySelector(".mission-detail-status-bar")?.dataset.missionId ===
              mission.id,
            "Mission detail",
          );
          await painted();
        }
        return { mission, markers };
      };
      const observe = (
        mission,
        {
          previousExecutionId,
          foreground = false,
          markers,
          onFinalLive,
          onTerminal,
          onCoreTerminal,
          onTerminalPaint,
          onFirstText,
          triggerAt,
          triggerSource,
          role = previousExecutionId ? "followup" : "initial",
        } = {},
      ) => {
        const sample = {
          group: configuration.group,
          launchId: configuration.launchedAt,
          role,
          missionId: mission.id,
          presentation: foreground ? "foreground-ui" : "api-background",
          previousExecutionId,
          triggerAt,
          triggerSource,
          ...markers,
          controlUpdates: [],
        };
        rounds.push(sample);
        const isCurrent = (executionId) =>
          executionId &&
          executionId !== previousExecutionId &&
          (!sample.executionId || sample.executionId === executionId);
        let finalTriggered = false;
        let terminalTriggered = false;
        let coreTriggered = false;
        let firstTextTriggered = false;
        let terminalPaintTriggered = false;
        const assistantEntries = new Set();
        const assistantText = new Map();
        const checkCoreMarker = () => {
          if (!sample.executionId || coreTriggered) return;
          const marker = coreMarkers.get(sample.executionId);
          const expectedRequestId = sample.requestId ?? mission.initialMessageId;
          if (!marker || (expectedRequestId && marker.requestId !== expectedRequestId)) return;
          coreTriggered = true;
          sample.coreTerminalMarker = marker;
          onCoreTerminal?.(sample, marker);
        };
        coreListeners.add(checkCoreMarker);
        const stopStatus = api.subscribeMissionStatusUpdates((update) => {
          if (update.missionId !== mission.id || !isCurrent(update.execution?.id)) return;
          sample.executionId = update.execution.id;
          checkCoreMarker();
          if (
            ["succeeded", "failed", "cancelled"].includes(update.execution.status) &&
            !terminalTriggered
          ) {
            terminalTriggered = true;
            sample.terminalObservedAt = Date.now();
            onTerminal?.(sample);
          }
        });
        const finalLive = () => {
          if (finalTriggered) return;
          finalTriggered = true;
          sample.finalLiveObservedAt = Date.now();
          if (onFinalLive)
            void painted().then(() => {
              sample.finalLivePaintObservedAt = Date.now();
              onFinalLive(sample);
            });
        };
        const stopChat = api.subscribeMissionChat(mission.id, (update) => {
          if (update.kind !== "patch") return;
          for (const patch of update.patches) {
            if (patch.type === "queue.update")
              sample.controlUpdates.push({ at: Date.now(), revision: update.revision });
            if (patch.type === "entry.upsert" && isCurrent(patch.entry.executionId)) {
              sample.executionId = patch.entry.executionId;
              checkCoreMarker();
              if (patch.entry.kind === "assistant") {
                assistantEntries.add(patch.entry.id);
                assistantText.set(patch.entry.id, patch.entry.content ?? "");
                if (!firstTextTriggered && patch.entry.content) {
                  firstTextTriggered = true;
                  sample.firstLiveTextObservedAt = Date.now();
                  onFirstText?.(sample);
                }
                if (patch.entry.streaming === false && patch.entry.content) finalLive();
              }
            }
            if (
              patch.type === "entry.append" &&
              assistantEntries.has(patch.entryId) &&
              patch.delta &&
              !firstTextTriggered
            ) {
              firstTextTriggered = true;
              sample.firstLiveTextObservedAt = Date.now();
              onFirstText?.(sample);
            }
            if (
              patch.type === "entry.streaming" &&
              !patch.streaming &&
              assistantEntries.has(patch.entryId)
            )
              finalLive();
          }
          for (const patch of update.patches) {
            if (patch.type === "entry.append" && assistantEntries.has(patch.entryId))
              assistantText.set(
                patch.entryId,
                (assistantText.get(patch.entryId) ?? "") + (patch.delta ?? ""),
              );
          }
        });
        const observer = new MutationObserver(() => {
          if (!foreground || !sample.executionId) return;
          for (const [selector, field] of [
            [".mission-assistant-message[data-mission-execution-id]", "textPaintAt"],
            [".mission-thinking-entry[data-mission-execution-id]", "reasoningPaintAt"],
          ]) {
            const element = [...document.querySelectorAll(selector)].find(
              (item) =>
                item.dataset.missionExecutionId === sample.executionId && item.textContent.trim(),
            );
            if (element && sample[field] === undefined) {
              sample[field] = "pending";
              void painted().then(() => {
                sample[field] = Date.now();
              });
            }
          }
          const bar = document.querySelector(".mission-detail-status-bar");
          if (
            bar?.dataset.missionExecutionId === sample.executionId &&
            ["succeeded", "failed", "cancelled"].includes(bar.dataset.missionStatus) &&
            !terminalPaintTriggered
          ) {
            terminalPaintTriggered = true;
            void painted().then(() => {
              sample.terminalPaintAt = Date.now();
              onTerminalPaint?.(sample);
            });
          }
        });
        if (foreground)
          observer.observe(document.body, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
          });
        const stop = () => {
          stopStatus();
          stopChat();
          observer.disconnect();
          coreListeners.delete(checkCoreMarker);
        };
        cleanups.push(stop);
        return {
          sample,
          assistantOutput: () => [...assistantText.values()].join("\n"),
          start: async (mode = "run", content = shortPrompt) => {
            sample.clickAt = Date.now();
            if (mode === "run") {
              const started = await api.runMission(mission.id);
              if (started.execution?.id) sample.executionId = started.execution.id;
              checkCoreMarker();
            } else {
              sample.requestId = window.crypto.randomUUID();
              sample.receipt = await api.sendMissionMessage({
                id: mission.id,
                requestId: sample.requestId,
                mode: "enqueue",
                content,
                attachments: [],
              });
            }
          },
          finish: async () => {
            const status = await wait(
              () => sample.executionId && terminal.get(sample.executionId),
              "Core terminal projection",
            );
            sample.status = status;
            if (status !== "succeeded") {
              sample.error = `Mission ended ${status}`;
              throw new Error(sample.error);
            }
            await delay(50);
          },
          stop,
        };
      };
      if (configuration.group === "four-missions") {
        const owners = [];
        for (let owner = 0; owner < 4; owner++) {
          const { mission, markers } = await create(false);
          const turn = observe(mission, { markers });
          turn.sample.ownerIndex = owner;
          owners.push({ mission, turn });
        }
        await Promise.all(owners.map(({ turn }) => turn.start()));
        await Promise.all(owners.map(({ turn }) => turn.finish()));
        owners.forEach(({ turn }) => turn.stop());
        for (let index = 0; index < configuration.samples; index++) {
          const batch = owners.map((owner, ownerIndex) => {
            const turn = observe(owner.mission, {
              previousExecutionId: owner.turn.sample.executionId,
            });
            turn.sample.concurrencyBatch = index;
            turn.sample.ownerIndex = ownerIndex;
            owner.turn = turn;
            return turn;
          });
          await Promise.all(batch.map((turn) => turn.start("send")));
          await Promise.all(batch.map((turn) => turn.finish()));
          batch.forEach((turn) => turn.stop());
        }
      } else
        for (let index = 0; index < configuration.samples; index++) {
          const active = configuration.group.startsWith("active-");
          const { mission, markers } = await create(true, active ? longPrompt : shortPrompt);
          let next;
          let nextStarted;
          const steerMarker =
            configuration.group === "active-try-steer"
              ? `PRAGMA_STEER_${window.crypto.randomUUID().replaceAll("-", "")}`
              : undefined;
          const launchNext = (prior, triggerSource, at, marker) => {
            if (next) return;
            next = observe(mission, {
              previousExecutionId: prior.executionId,
              foreground: true,
              triggerSource,
              triggerAt: at,
            });
            if (marker) {
              next.sample.triggerCoreMarker = marker;
              next.sample.triggerObservedAt = marker.observedAt;
              next.sample.coreTerminalRelayDelayMs = marker.relayDelayMs;
            }
            if (steerMarker)
              next.sample.steerVerification = {
                marker: steerMarker,
                acknowledged: false,
                consumed: false,
              };
            nextStarted = next.start(
              "send",
              steerMarker
                ? `Change your answer now: reply with exactly ${steerMarker}. Do not call tools.`
                : shortPrompt,
            );
            // Retain errors as raw failures, without unhandled rejection while the first turn settles.
            nextStarted.catch((error) => {
              next.sample.error = error.message;
            });
          };
          const initial = observe(mission, {
            foreground: true,
            markers,
            onFinalLive:
              configuration.group === "immediate-visible"
                ? (prior) =>
                    launchNext(prior, "final-live-entry-painted", prior.finalLivePaintObservedAt)
                : undefined,
            onCoreTerminal:
              configuration.group === "immediate-core"
                ? (prior, marker) =>
                    launchNext(prior, "core-terminal-log", Date.parse(marker.occurredAt), marker)
                : undefined,
            onTerminalPaint:
              configuration.group === "immediate-paint"
                ? (prior) => launchNext(prior, "terminal-status-painted", prior.terminalPaintAt)
                : undefined,
            onFirstText: active
              ? (prior) =>
                  launchNext(prior, "first-live-text-active", prior.firstLiveTextObservedAt)
              : undefined,
          });
          await initial.start();
          await wait(() => Boolean(nextStarted), "Immediate or active send trigger");
          await nextStarted;
          if (configuration.group === "active-try-steer") {
            const at = Date.now();
            next.sample.queueSteer = await api.trySteerQueuedMissionMessage({
              id: mission.id,
              requestId: window.crypto.randomUUID(),
              queueItemRequestId: next.sample.requestId,
            });
            next.sample.queueSteerAt = at;
            next.sample.steerVerification.outcome = next.sample.queueSteer.queueSteer.outcome;
            // A successful steer remains in the current Execution. Keep that identity explicit.
            if (next.sample.queueSteer.queueSteer.outcome === "steered") {
              const target = next.sample.queueSteer.queueSteer.executionId;
              next.sample.steerVerification.acknowledged = true;
              next.sample.steerVerification.targetExecutionId = target;
              next.sample.executionId = target;
              next.sample.delivery = "steer-current-execution";
            } else {
              next.sample.error = `Steer was not delivered: ${next.sample.queueSteer.queueSteer.reason}`;
              failures.push({
                phase: "steer-delivery",
                missionId: mission.id,
                error: next.sample.error,
              });
            }
          }
          await initial.finish();
          if (steerMarker && next.sample.steerVerification.acknowledged) {
            const output = initial.assistantOutput();
            const consumed =
              next.sample.steerVerification.targetExecutionId === initial.sample.executionId &&
              output.includes(steerMarker);
            Object.assign(next.sample.steerVerification, {
              consumed,
              checkedAt: Date.now(),
              evidence: consumed
                ? {
                    executionId: initial.sample.executionId,
                    source: "assistant-output",
                    marker: steerMarker,
                  }
                : null,
            });
            if (!consumed) {
              next.sample.error =
                "SDK acknowledged steer, but the target Execution output did not contain its unique marker.";
              failures.push({
                phase: "steer-consumption",
                missionId: mission.id,
                error: next.sample.error,
              });
            }
          }
          await next.finish();
          initial.stop();
          next.stop();
        }
    }
    if (backgroundTimer) clearInterval(backgroundTimer);
    await wait(() => !triggerPending, "Background trigger drain");
    if (configuration.backgroundLoad) {
      background.after = await snapshotBackground();
      background.observedCanonicalFeedEvents =
        background.after.memory.feed.eventCount - background.before.memory.feed.eventCount;
      background.observedRunningCuratorJobs = background.measurementStart.activeTasks.filter(
        (task) => ["episodic", "semantic"].includes(task.module) && task.lane === "running",
      ).length;
      background.modelOverlap = { status: "pending-diagnostic-verification", evidence: [] };
    }
    failures.push(...background.failures);
    return { rounds, failures, startup, background };
  } catch (error) {
    failures.push({ group: configuration.group, phase: "scenario", error: error.message });
    return { rounds, failures, startup, background, error: error.message };
  } finally {
    if (backgroundTimer) clearInterval(backgroundTimer);
    for (const stop of cleanups) stop();
    for (const id of missions) {
      try {
        await api.deleteMission(id);
      } catch (error) {
        failures.push({ phase: "cleanup", missionId: id, error: error.message });
      }
    }
  }
}
