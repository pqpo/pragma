import { join } from "node:path";
import { z } from "zod";
import { executeManagementMutation } from "@pragma/local-host";
import { createHash, randomUUID } from "node:crypto";

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
  AutomationBindingSchema,
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
import type { LocalHostMissionApplication } from "@pragma/local-host";
import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { validateHostWorkspace as validateWorkspace } from "@pragma/local-host";

const SCHEDULE_ADAPTER = "pragma.automation.schedule@v1";
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MISSED_SCHEDULE_TOLERANCE_MS = 60_000;
const TERMINAL_EXECUTION_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export interface AutomationService {
  start(): Promise<void>;
  stop(): void;
  listAdapters(): readonly AutomationAdapterOption[];
  list(): Promise<AutomationSummary[]>;
  listMissionSources(): Promise<ReadonlyMap<string, string>>;
  save(input: SaveAutomation, operationId?: string): Promise<AutomationSummary>;
  delete(input: DeleteAutomation, operationId?: string): Promise<void>;
  trigger(ref: string): Promise<AutomationSummary>;
  resetSession(ref: string, operationId?: string): Promise<AutomationSummary>;
  preview(input: PreviewAutomationSchedule): { readonly occurrences: readonly string[] };
}

export function createAutomationService(options: {
  readonly paths: PragmaPaths;
  readonly project: PragmaProjectStore;
  readonly store: AutomationStore;
  readonly missions: MissionStore;
  readonly creator: MissionCreator;
  readonly application: LocalHostMissionApplication;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly onStorageTrashed?: (() => void) | undefined;
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
        void options.application.startRun(event.missionId).catch(async (error: unknown) => {
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
          ? options.application.startRun(dispatchMissionId)
          : TERMINAL_EXECUTION_STATUSES.has(mission.execution.status)
            ? Promise.resolve(mission)
            : waitForMissionExecution(dispatchMissionId).then(
                async () => await options.missions.get(dispatchMissionId),
              )
        : options.application.sendMessage({
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
    return await options.creator.create(
      automationMissionCreationInput(resource, binding, missionId),
    );
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

  const backfillMissionSourcesForBinding = async (
    ref: string,
    binding: AutomationBinding,
  ): Promise<ReadonlyMap<string, string>> => {
    const state = await options.store.getState(ref, binding.generation);
    const sources = new Map<string, string>();
    if (state.missionId !== undefined) sources.set(state.missionId, ref);
    for (const event of state.queue) sources.set(event.missionId, ref);
    for (const run of state.runs) {
      if (run.missionId !== undefined) sources.set(run.missionId, ref);
    }
    await Promise.all(
      [...sources].map(async ([missionId, automationRef]) => {
        try {
          await options.missions.backfillAutomationOrigin(missionId, automationRef);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") return;
          throw error;
        }
      }),
    );
    return sources;
  };

  const listMissionSources = async (): Promise<ReadonlyMap<string, string>> => {
    const resources = (await options.project.get()).resources.filter(
      (resource): resource is PragmaAutomationResource => resource.kind === "Automation",
    );
    const sources = new Map<string, string>();
    await Promise.all(
      resources.map(async (resource) => {
        const ref = canonicalPragmaResourceRef(resource);
        const binding = await options.store.getBinding(ref);
        if (binding === undefined) return;
        for (const [missionId, automationRef] of await backfillMissionSourcesForBinding(
          ref,
          binding,
        )) {
          sources.set(missionId, automationRef);
        }
      }),
    );
    return sources;
  };

  const assertMutationBinding = async (
    ref: string,
    previous: AutomationBinding | undefined,
    planned: AutomationBinding | undefined,
  ) => {
    const current = await options.store.getBinding(ref);
    const same = (binding: AutomationBinding | undefined) =>
      JSON.stringify(current) === JSON.stringify(binding);
    if (!same(previous) && !same(planned))
      throw new Error(
        "Automation binding revision conflict; inspect current state before retrying.",
      );
  };

  return {
    async start() {
      if (running) return;
      running = true;
      try {
        await listMissionSources();
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
    async listMissionSources() {
      return await listMissionSources();
    },
    async save(input, operationId = randomUUID()) {
      const resource = PragmaAutomationResourceSchema.parse(input.resource);
      const ref = canonicalPragmaResourceRef(resource);
      return await executeManagementMutation({
        root: join(options.paths.storageStateRoot(), "pragma", "automation-mutations", "v1"),
        operationId,
        target: ref,
        input: { action: "save", ...input },
        stateSchema: z
          .object({
            resource: PragmaAutomationResourceSchema,
            binding: AutomationBindingSchema,
            previousBinding: AutomationBindingSchema.optional(),
            rotateGeneration: z.boolean(),
            baseRevision: z.number().int().nonnegative(),
          })
          .strict(),
        resultSchema: AutomationSummarySchema,
        prepare: async () => {
          if (resource.spec.adapter !== SCHEDULE_ADAPTER)
            throw new Error(`Automation adapter is not installed: ${resource.spec.adapter}.`);
          const validation = await validateWorkspace(input.binding.workspace);
          if (!validation.ok)
            throw new Error("The Automation workspace must be an accessible, writable directory.");
          const previousResource = await findAutomation(ref);
          const previousBinding = await options.store.getBinding(ref);
          const workspace = {
            path: input.binding.workspace,
            basename:
              input.binding.workspace.split(/[\\/]/).filter(Boolean).at(-1) ??
              input.binding.workspace,
          };
          const rotateGeneration =
            previousResource === undefined ||
            previousBinding === undefined ||
            executionIdentity(previousResource, previousBinding) !==
              executionIdentity(resource, {
                ...previousBinding,
                workspace,
                toolPermissionMode: input.binding.toolPermissionMode,
                modelOverride: input.binding.modelOverride,
                contextMounts: input.binding.contextMounts,
              });
          if (rotateGeneration && previousBinding !== undefined)
            await backfillMissionSourcesForBinding(ref, previousBinding);
          const binding = createAutomationBinding({
            automationRef: ref,
            previous: previousBinding,
            rotateGeneration,
            workspace,
            toolPermissionMode: input.binding.toolPermissionMode,
            modelOverride: input.binding.modelOverride,
            contextMounts: input.binding.contextMounts,
          });
          return {
            resource,
            binding,
            previousBinding,
            rotateGeneration,
            baseRevision: input.expectedProjectRevision,
          };
        },
        apply: async (plan, publicationId, progress) => {
          await assertMutationBinding(ref, plan.previousBinding, plan.binding);
          if ((await options.project.findRevisionByPublicationId(publicationId)) === undefined) {
            await options.project.applyTransactional(
              { baseRevision: plan.baseRevision, upserts: [plan.resource] },
              publicationId,
            );
          }
          await options.store.saveBinding(plan.binding);
          if (!progress.completed("cleaned")) {
            if (plan.rotateGeneration && plan.previousBinding !== undefined) {
              if (await options.store.retireGeneration(ref, plan.previousBinding.generation))
                options.onStorageTrashed?.();
            }
            await progress.complete("cleaned");
          }
          await scheduleResource(plan.resource, plan.binding);
          void processQueue(ref);
          return await summaryFor(plan.resource);
        },
      });
    },
    async delete(input, operationId = randomUUID()) {
      await executeManagementMutation({
        root: join(options.paths.storageStateRoot(), "pragma", "automation-mutations", "v1"),
        operationId,
        target: input.ref,
        input: { action: "delete", ...input },
        stateSchema: z
          .object({
            previousBinding: AutomationBindingSchema.optional(),
            baseRevision: z.number().int().nonnegative(),
          })
          .strict(),
        resultSchema: z.object({ deleted: z.literal(true) }).strict(),
        prepare: async () => {
          const previousBinding = await options.store.getBinding(input.ref);
          if (previousBinding !== undefined)
            await backfillMissionSourcesForBinding(input.ref, previousBinding);
          return { previousBinding, baseRevision: input.expectedProjectRevision };
        },
        apply: async (plan, publicationId, progress) => {
          await assertMutationBinding(input.ref, plan.previousBinding, undefined);
          clearTimer(input.ref);
          if ((await options.project.findRevisionByPublicationId(publicationId)) === undefined) {
            await options.project.applyTransactional(
              { baseRevision: plan.baseRevision, upserts: [], removals: [input.ref] },
              publicationId,
            );
          }
          if (!progress.completed("cleaned")) {
            await moveOwnedStorageToTrash({
              paths: options.paths,
              owner: { type: "automation", id: input.ref },
              sources: [
                { label: "binding.json", path: options.paths.automationBinding(input.ref) },
                { label: "state", path: options.paths.automationStateRoot(input.ref) },
              ],
            });
            options.onStorageTrashed?.();
            await progress.complete("cleaned");
          }
          return { deleted: true as const };
        },
      });
    },
    async trigger(ref) {
      if (!running) throw new Error("Automation service is not running.");
      const resource = await findAutomation(ref);
      if (resource === undefined) throw new Error(`Automation not found: ${ref}.`);
      if (resource.spec.adapter !== SCHEDULE_ADAPTER) {
        throw new Error(`Automation adapter is not installed: ${resource.spec.adapter}.`);
      }
      if (!resource.spec.enabled) throw new Error(`Automation is disabled: ${ref}.`);
      const binding = await options.store.getBinding(ref);
      if (binding === undefined) throw new Error(`Automation binding not found: ${ref}.`);
      const triggeredAt = now().toISOString();
      const eventId = `manual:${randomUUID()}`;
      await enqueue(ref, binding.generation, {
        eventId,
        scheduledFor: triggeredAt,
        missionId: deterministicUuid(`automation-mission:${eventId}`),
        createdAt: triggeredAt,
      });
      void processQueue(ref);
      return await summaryFor(resource);
    },
    async resetSession(ref, operationId = randomUUID()) {
      return await executeManagementMutation({
        root: join(options.paths.storageStateRoot(), "pragma", "automation-mutations", "v1"),
        operationId,
        target: ref,
        input: { action: "reset", ref },
        stateSchema: z
          .object({
            resource: PragmaAutomationResourceSchema,
            previousBinding: AutomationBindingSchema,
            binding: AutomationBindingSchema,
          })
          .strict(),
        resultSchema: AutomationSummarySchema,
        prepare: async () => {
          const resource = await findAutomation(ref);
          if (resource === undefined) throw new Error(`Automation not found: ${ref}.`);
          const previousBinding = await options.store.getBinding(ref);
          if (previousBinding === undefined)
            throw new Error(`Automation binding not found: ${ref}.`);
          await backfillMissionSourcesForBinding(ref, previousBinding);
          const binding = createAutomationBinding({
            automationRef: ref,
            previous: previousBinding,
            rotateGeneration: true,
            workspace: previousBinding.workspace,
            toolPermissionMode: previousBinding.toolPermissionMode,
            modelOverride: previousBinding.modelOverride,
            contextMounts: previousBinding.contextMounts,
          });
          return { resource, previousBinding, binding };
        },
        apply: async (plan, _publicationId, progress) => {
          await assertMutationBinding(ref, plan.previousBinding, plan.binding);
          await options.store.saveBinding(plan.binding);
          if (!progress.completed("cleaned")) {
            if (await options.store.retireGeneration(ref, plan.previousBinding.generation))
              options.onStorageTrashed?.();
            await progress.complete("cleaned");
          }
          await scheduleResource(plan.resource, plan.binding);
          return await summaryFor(plan.resource);
        },
      });
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

export function automationMissionCreationInput(
  resource: PragmaAutomationResource,
  binding: AutomationBinding,
  missionId: string,
): Parameters<MissionCreator["create"]>[0] {
  return {
    id: missionId,
    workspace: binding.workspace.path,
    executorRef: resource.spec.route.executor.ref,
    missionInput: automationMissionInput(resource),
    toolPermissionMode: binding.toolPermissionMode,
    origin: { type: "automation", automationRef: canonicalPragmaResourceRef(resource) },
    contextMounts: binding.contextMounts,
    ...(binding.modelOverride === undefined ? {} : { modelOverride: binding.modelOverride }),
  };
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
    contextMounts: binding.contextMounts,
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
