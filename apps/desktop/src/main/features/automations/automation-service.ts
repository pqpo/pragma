import { createHash } from "node:crypto";

import {
  createPragmaLogger,
  moveOwnedStorageToTrash,
  type PragmaLoggerProvider,
  type PragmaPaths,
} from "@pragma/core";
import {
  PragmaAutomationResourceSchema,
  PragmaScheduleAutomationConfigSchema,
  canonicalPragmaResourceRef,
  type PragmaAutomationResource,
} from "@pragma/interpreter/ast";

import {
  AutomationAdapterOptionSchema,
  AutomationSummarySchema,
  type AutomationAdapterOption,
  type AutomationBinding,
  type AutomationRunRecord,
  type AutomationSummary,
  type DeleteAutomation,
  type PreviewAutomationSchedule,
  type SaveAutomation,
} from "../../../shared/contracts/index.ts";
import {
  appendAutomationRun,
  createAutomationBinding,
  type AutomationState,
  type AutomationStore,
  type QueuedAutomationEvent,
} from "./automation-store.ts";
import { nextScheduleOccurrence, previewScheduleOccurrences } from "./automation-schedule.ts";
import type { MissionCreator } from "../missions/mission-creator.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { validateWorkspace } from "../workspaces/workspace-scope.ts";

const SCHEDULE_ADAPTER = "pragma.automation.schedule@v1";
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MISSED_SCHEDULE_TOLERANCE_MS = 60_000;
const TERMINAL_EXECUTION_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export interface AutomationService {
  start(): Promise<void>;
  stop(): void;
  listAdapters(): readonly AutomationAdapterOption[];
  list(): Promise<AutomationSummary[]>;
  save(input: SaveAutomation): Promise<AutomationSummary>;
  delete(input: DeleteAutomation): Promise<void>;
  resetSession(ref: string): Promise<AutomationSummary>;
  preview(input: PreviewAutomationSchedule): { readonly occurrences: readonly string[] };
}

export function createAutomationService(options: {
  readonly paths: PragmaPaths;
  readonly project: PragmaProjectStore;
  readonly store: AutomationStore;
  readonly missions: MissionStore;
  readonly creator: MissionCreator;
  readonly runner: MissionRunner;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly now?: (() => Date) | undefined;
}): AutomationService {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.automation",
  });
  const now = options.now ?? (() => new Date());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const processing = new Set<string>();
  let running = false;
  const getMission = async (id: string) => await getMissionFromStore(options.missions, id);
  const waitForMissionExecution = async (id: string): Promise<void> => {
    while (running) {
      const mission = await options.missions.get(id);
      if (
        mission.execution === undefined ||
        TERMINAL_EXECUTION_STATUSES.has(mission.execution.status)
      ) {
        return;
      }
      await wait(1_000);
    }
  };

  const scheduleResource = async (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
  ): Promise<void> => {
    const ref = canonicalPragmaResourceRef(resource);
    clearTimer(ref);
    if (!running || !resource.spec.enabled || resource.spec.adapter !== SCHEDULE_ADAPTER) {
      await setNextRun(ref, binding.generation, undefined);
      return;
    }
    const config = PragmaScheduleAutomationConfigSchema.parse(resource.spec.config);
    const occurrence = nextScheduleOccurrence(config.trigger, now());
    await setNextRun(ref, binding.generation, occurrence?.toISOString());
    if (occurrence === undefined) return;
    armTimer(resource, binding, occurrence);
  };

  const armTimer = (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
    occurrence: Date,
  ): void => {
    const ref = canonicalPragmaResourceRef(resource);
    const remaining = occurrence.getTime() - now().getTime();
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
    const timer = setTimeout(() => {
      timers.delete(ref);
      if (!running) return;
      if (remaining > MAX_TIMER_DELAY_MS) {
        armTimer(resource, binding, occurrence);
        return;
      }
      void fireSchedule(resource, binding, occurrence).catch((error: unknown) => {
        logger.error(
          "automation.schedule_failed",
          `Automation schedule failed for ${ref}.`,
          error,
          { automationRef: ref },
        );
      });
    }, delay);
    timer.unref();
    timers.set(ref, timer);
  };

  const fireSchedule = async (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
    occurrence: Date,
  ): Promise<void> => {
    const ref = canonicalPragmaResourceRef(resource);
    const currentBinding = await options.store.getBinding(ref);
    if (currentBinding?.generation !== binding.generation) return;
    const current = await findAutomation(ref);
    if (current === undefined || !current.spec.enabled) return;

    const eventId = scheduleEventId(ref, binding.generation, occurrence.toISOString());
    if (now().getTime() - occurrence.getTime() > MISSED_SCHEDULE_TOLERANCE_MS) {
      await updateRun(ref, binding.generation, {
        eventId,
        scheduledFor: occurrence.toISOString(),
        status: "skipped",
        error: "Desktop was unavailable or asleep when this schedule was due.",
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      });
    } else {
      await enqueue(ref, binding.generation, {
        eventId,
        scheduledFor: occurrence.toISOString(),
        missionId: deterministicUuid(`automation-mission:${eventId}`),
        createdAt: now().toISOString(),
      });
      void processQueue(ref);
    }
    await scheduleResource(current, binding);
  };

  const enqueue = async (
    ref: string,
    generation: string,
    event: QueuedAutomationEvent,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) => {
      if (
        state.queue.some((candidate) => candidate.eventId === event.eventId) ||
        state.runs.some((run) => run.eventId === event.eventId)
      ) {
        return state;
      }
      const timestamp = now().toISOString();
      return appendAutomationRun(
        { ...state, queue: [...state.queue, event] },
        {
          eventId: event.eventId,
          scheduledFor: event.scheduledFor,
          status: "queued",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      );
    });
  };

  const processQueue = async (ref: string): Promise<void> => {
    if (processing.has(ref)) return;
    processing.add(ref);
    try {
      while (running) {
        const resource = await findAutomation(ref);
        const binding = await options.store.getBinding(ref);
        if (resource === undefined || binding === undefined || !resource.spec.enabled) return;
        const state = await options.store.getState(ref, binding.generation);
        const event = state.queue[0];
        if (event === undefined) return;
        if (
          resource.spec.interaction.mode === "new-mission" ||
          resource.spec.route.executor.ref.startsWith("flow:")
        ) {
          await dispatchNewMission(resource, binding, event);
        } else {
          await dispatchReusableMission(resource, binding, state, event);
        }
      }
    } finally {
      processing.delete(ref);
    }
  };

  const dispatchNewMission = async (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
    event: QueuedAutomationEvent,
  ): Promise<void> => {
    const ref = canonicalPragmaResourceRef(resource);
    try {
      const mission = await ensureMission(resource, binding, event.missionId);
      await markDispatched(ref, binding.generation, event, event.missionId);
      if (mission.execution === undefined) {
        void options.runner.run(event.missionId).catch(async (error: unknown) => {
          await markRunOnlyFailed(ref, binding.generation, event, event.missionId, error).catch(
            () => undefined,
          );
        });
      }
    } catch (error) {
      await markFailed(ref, binding.generation, event, event.missionId, error);
    }
  };

  const dispatchReusableMission = async (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
    state: AutomationState,
    event: QueuedAutomationEvent,
  ): Promise<void> => {
    const ref = canonicalPragmaResourceRef(resource);
    let missionId = state.missionId;
    let mission = missionId === undefined ? undefined : await getMission(missionId);
    let startsMission = state.missionId === undefined;
    if (mission?.lifecycleStatus === "completed") {
      mission = undefined;
      missionId = undefined;
      startsMission = true;
    }
    missionId ??= event.missionId;
    try {
      if (mission === undefined) {
        mission = await ensureMission(resource, binding, missionId);
      }
      if (!startsMission) {
        await waitForMissionExecution(missionId);
        if (!running) return;
        mission = await options.missions.get(missionId);
        if (mission.lifecycleStatus === "completed") {
          missionId = event.missionId;
          mission = await ensureMission(resource, binding, missionId);
          startsMission = true;
        }
      }
      const dispatchMissionId = missionId;
      const operation = startsMission
        ? mission.execution === undefined
          ? options.runner.run(dispatchMissionId)
          : TERMINAL_EXECUTION_STATUSES.has(mission.execution.status)
            ? Promise.resolve(mission)
            : waitForMissionExecution(dispatchMissionId).then(
                async () => await options.missions.get(dispatchMissionId),
              )
        : options.runner.sendMessage({
            id: dispatchMissionId,
            content: promptFor(resource),
            requestId: deterministicUuid(`automation-message:${event.eventId}`),
          });
      await markDispatched(ref, binding.generation, event, dispatchMissionId, true);
      try {
        await operation;
      } catch (error) {
        await markRunOnlyFailed(ref, binding.generation, event, dispatchMissionId, error);
      }
    } catch (error) {
      await markFailed(ref, binding.generation, event, missionId, error);
    }
  };

  const ensureMission = async (
    resource: PragmaAutomationResource,
    binding: AutomationBinding,
    missionId: string,
  ) => {
    const existing = await getMission(missionId);
    if (existing !== undefined) return existing;
    return await options.creator.create({
      id: missionId,
      workspace: binding.workspace.path,
      executorRef: resource.spec.route.executor.ref,
      missionInput: automationMissionInput(resource),
      toolPermissionMode: binding.toolPermissionMode,
      ...(binding.modelOverride === undefined ? {} : { modelOverride: binding.modelOverride }),
    });
  };

  const markDispatched = async (
    ref: string,
    generation: string,
    event: QueuedAutomationEvent,
    missionId: string,
    reuse = false,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) => ({
      ...upsertRun(state, event, "dispatched", missionId),
      ...(reuse ? { missionId } : {}),
      queue: state.queue.filter((candidate) => candidate.eventId !== event.eventId),
    }));
  };

  const markFailed = async (
    ref: string,
    generation: string,
    event: QueuedAutomationEvent,
    missionId: string,
    error: unknown,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) => ({
      ...upsertRun(state, event, "failed", missionId, errorMessage(error)),
      queue: state.queue.filter((candidate) => candidate.eventId !== event.eventId),
    }));
  };

  const markRunOnlyFailed = async (
    ref: string,
    generation: string,
    event: QueuedAutomationEvent,
    missionId: string,
    error: unknown,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) =>
      upsertRun(state, event, "failed", missionId, errorMessage(error)),
    );
  };

  const updateRun = async (
    ref: string,
    generation: string,
    run: AutomationRunRecord,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) => {
      const without = state.runs.filter((candidate) => candidate.eventId !== run.eventId);
      return { ...state, runs: [...without, run].slice(-100) };
    });
  };

  const findAutomation = async (ref: string): Promise<PragmaAutomationResource | undefined> =>
    (await options.project.get()).resources.find(
      (resource): resource is PragmaAutomationResource =>
        resource.kind === "Automation" && canonicalPragmaResourceRef(resource) === ref,
    );

  const summaryFor = async (resource: PragmaAutomationResource): Promise<AutomationSummary> => {
    const ref = canonicalPragmaResourceRef(resource);
    const binding = await options.store.getBinding(ref);
    if (resource.spec.adapter !== SCHEDULE_ADAPTER) {
      return AutomationSummarySchema.parse({
        ref,
        resource,
        ...(binding === undefined ? {} : { binding }),
        status: "needs_attention",
        queueDepth: 0,
        diagnostic: `Adapter is not installed: ${resource.spec.adapter}.`,
      });
    }
    if (binding === undefined) {
      return AutomationSummarySchema.parse({
        ref,
        resource,
        status: "needs_attention",
        queueDepth: 0,
        diagnostic: "Desktop binding is missing.",
      });
    }
    const state = await options.store.getState(ref, binding.generation);
    return AutomationSummarySchema.parse({
      ref,
      resource,
      binding,
      status: !resource.spec.enabled
        ? "disabled"
        : state.nextRunAt === undefined
          ? "expired"
          : "scheduled",
      ...(state.nextRunAt === undefined ? {} : { nextRunAt: state.nextRunAt }),
      ...(state.missionId === undefined ? {} : { missionId: state.missionId }),
      queueDepth: state.queue.length,
      ...(state.runs.at(-1) === undefined ? {} : { lastRun: state.runs.at(-1) }),
    });
  };

  const reconcile = async (): Promise<void> => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const resources = (await options.project.get()).resources.filter(
      (resource): resource is PragmaAutomationResource => resource.kind === "Automation",
    );
    for (const resource of resources) {
      const ref = canonicalPragmaResourceRef(resource);
      const binding = await options.store.getBinding(ref);
      if (binding === undefined) continue;
      await scheduleResource(resource, binding);
      void processQueue(ref);
    }
  };

  const clearTimer = (ref: string): void => {
    const timer = timers.get(ref);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(ref);
  };

  const setNextRun = async (
    ref: string,
    generation: string,
    nextRunAt: string | undefined,
  ): Promise<void> => {
    await options.store.updateState(ref, generation, (state) => ({
      ...state,
      ...(nextRunAt === undefined ? { nextRunAt: undefined } : { nextRunAt }),
    }));
  };

  return {
    async start() {
      if (running) return;
      running = true;
      try {
        await reconcile();
      } catch (error) {
        running = false;
        throw error;
      }
    },
    stop() {
      running = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    listAdapters() {
      return [
        AutomationAdapterOptionSchema.parse({
          ref: SCHEDULE_ADAPTER,
          name: "Schedule",
          description: "Trigger an Expert, Team, or Flow on a local Desktop schedule.",
          sourceMode: "signal",
          placement: "desktop",
          requiresConnection: false,
          supportsSessionReuse: true,
        }),
      ];
    },
    async list() {
      const resources = (await options.project.get()).resources.filter(
        (resource): resource is PragmaAutomationResource => resource.kind === "Automation",
      );
      return await Promise.all(resources.map(summaryFor));
    },
    async save(input) {
      const resource = PragmaAutomationResourceSchema.parse(input.resource);
      if (resource.spec.adapter !== SCHEDULE_ADAPTER) {
        throw new Error(`Automation adapter is not installed: ${resource.spec.adapter}.`);
      }
      const validation = await validateWorkspace(input.binding.workspace);
      if (!validation.ok) {
        throw new Error("The Automation workspace must be an accessible, writable directory.");
      }
      const ref = canonicalPragmaResourceRef(resource);
      const previousResource = await findAutomation(ref);
      const previousBinding = await options.store.getBinding(ref);
      const workspace = {
        path: input.binding.workspace,
        basename:
          input.binding.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? input.binding.workspace,
      };
      const rotateGeneration =
        previousResource === undefined ||
        previousBinding === undefined ||
        executionIdentity(previousResource, previousBinding) !==
          executionIdentity(resource, {
            ...previousBinding,
            workspace,
            toolPermissionMode: input.binding.toolPermissionMode,
            ...(input.binding.modelOverride === undefined
              ? { modelOverride: undefined }
              : { modelOverride: input.binding.modelOverride }),
          });
      const snapshot = await options.project.upsert({
        baseRevision: input.expectedProjectRevision,
        resource,
      });
      const binding = createAutomationBinding({
        automationRef: ref,
        previous: previousBinding,
        rotateGeneration,
        workspace,
        toolPermissionMode: input.binding.toolPermissionMode,
        ...(input.binding.modelOverride === undefined
          ? {}
          : { modelOverride: input.binding.modelOverride }),
      });
      await options.store.saveBinding(binding);
      if (rotateGeneration && previousBinding !== undefined) {
        await moveOwnedStorageToTrash({
          paths: options.paths,
          owner: { type: "automation-generation", id: ref },
          sources: [{ label: "state", path: options.paths.automationStateRoot(ref) }],
        });
      }
      if (snapshot.resources.every((candidate) => canonicalPragmaResourceRef(candidate) !== ref)) {
        throw new Error(`Automation was not published: ${ref}.`);
      }
      await scheduleResource(resource, binding);
      void processQueue(ref);
      return await summaryFor(resource);
    },
    async delete(input) {
      clearTimer(input.ref);
      await options.project.remove({
        baseRevision: input.expectedProjectRevision,
        ref: input.ref,
      });
      await moveOwnedStorageToTrash({
        paths: options.paths,
        owner: { type: "automation", id: input.ref },
        sources: [
          { label: "binding.json", path: options.paths.automationBinding(input.ref) },
          { label: "state", path: options.paths.automationStateRoot(input.ref) },
        ],
      });
    },
    async resetSession(ref) {
      const resource = await findAutomation(ref);
      if (resource === undefined) throw new Error(`Automation not found: ${ref}.`);
      const previous = await options.store.getBinding(ref);
      if (previous === undefined) throw new Error(`Automation binding not found: ${ref}.`);
      const binding = createAutomationBinding({
        automationRef: ref,
        previous,
        rotateGeneration: true,
        workspace: previous.workspace,
        toolPermissionMode: previous.toolPermissionMode,
        ...(previous.modelOverride === undefined ? {} : { modelOverride: previous.modelOverride }),
      });
      await options.store.saveBinding(binding);
      await moveOwnedStorageToTrash({
        paths: options.paths,
        owner: { type: "automation-generation", id: ref },
        sources: [{ label: "state", path: options.paths.automationStateRoot(ref) }],
      });
      await scheduleResource(resource, binding);
      return await summaryFor(resource);
    },
    preview(input) {
      return {
        occurrences: previewScheduleOccurrences(
          input.trigger,
          input.from === undefined ? now() : new Date(input.from),
          input.count,
        ).map((occurrence) => occurrence.toISOString()),
      };
    },
  };
}

export function automationMissionInput(resource: PragmaAutomationResource) {
  const routeInput = resource.spec.route.input;
  return resource.spec.route.executor.ref.startsWith("flow:") && routeInput.kind === "prompt"
    ? { kind: "auto" as const, value: routeInput.value }
    : routeInput;
}

function promptFor(resource: PragmaAutomationResource): string {
  if (resource.spec.route.input.kind !== "prompt") {
    throw new Error("Only Expert and Team Automations can reuse a Mission.");
  }
  return resource.spec.route.input.value;
}

function executionIdentity(resource: PragmaAutomationResource, binding: AutomationBinding): string {
  return JSON.stringify({
    executor: resource.spec.route.executor.ref,
    input: resource.spec.route.input,
    interaction: resource.spec.interaction,
    workspace: binding.workspace.path,
    permission: binding.toolPermissionMode,
    model: binding.modelOverride,
  });
}

function scheduleEventId(ref: string, generation: string, scheduledFor: string): string {
  return `schedule:${createHash("sha256")
    .update(JSON.stringify([ref, generation, scheduledFor]))
    .digest("hex")}`;
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function upsertRun(
  state: AutomationState,
  event: QueuedAutomationEvent,
  status: AutomationRunRecord["status"],
  missionId?: string,
  error?: string,
): AutomationState {
  const timestamp = new Date().toISOString();
  const existing = state.runs.find((run) => run.eventId === event.eventId);
  const run: AutomationRunRecord = {
    eventId: event.eventId,
    scheduledFor: event.scheduledFor,
    status,
    ...(missionId === undefined ? {} : { missionId }),
    ...(error === undefined ? {} : { error }),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  return {
    ...state,
    runs: [...state.runs.filter((candidate) => candidate.eventId !== event.eventId), run].slice(
      -100,
    ),
  };
}

async function getMissionFromStore(
  missions: MissionStore,
  id: string,
): Promise<Awaited<ReturnType<MissionStore["get"]>> | undefined> {
  try {
    return await missions.get(id);
  } catch (error) {
    if (error instanceof MissionStoreError && error.code === "mission_not_found") return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 10_000);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
