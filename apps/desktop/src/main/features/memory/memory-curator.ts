import { consumeUnstartedMissionPreparationFailure } from "@pragma/local-host";
import { waitForInternalMissionRetry } from "@pragma/local-host";
import { cleanupInternalMission } from "@pragma/local-host";
import { waitForInternalMissionTerminal } from "@pragma/local-host";
import type { LocalHostSystemExecutorSource } from "@pragma/local-host";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  PragmaPaths,
  withFileLock,
  createPragmaLogger,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import {
  MEMORY_CURATOR_REF as BUILT_IN_MEMORY_CURATOR_REF,
  builtInAgentFingerprint,
  createBuiltInMemoryCurator,
  createMemoryCuratorTools,
  memoryCuratorResource,
} from "@pragma/built-in-agents";
import {
  MEMORY_CURATOR_PROMPT_VERSION,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  DEFAULT_MEMORY_STORAGE_POLICY,
  createMemoryExtractionSessionStore,
  type EpisodicMemoryExtractor,
  type SemanticMemoryExtractor,
  type ConversationMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
  type MemoryExtractionSession,
} from "@pragma/memory";
import type { MemoryExtractionFailureDiagnostic } from "@pragma/shared";

import type { LocalHostMissionApplication } from "@pragma/local-host";
import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";
import { z } from "zod";
import type {
  DesktopMemoryExtractionRun,
  DesktopMemoryExtractionRunChatUpdate,
  MissionConversationSnapshot,
} from "../../../shared/contracts/index.ts";
import {
  createMemoryExtractionRunArchive,
  type MemoryExtractionRunArchive,
} from "./memory-extraction-run-archive.ts";

const CuratorMissionRegistrySchema = z.object({
  schemaVersion: z.literal("pragma.memory-curator-mission-registry/v1"),
  entries: z
    .array(
      z.object({
        missionId: z.string().uuid(),
        jobId: z.string().min(1),
        createdAt: z.string().datetime(),
      }),
    )
    .max(DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries),
});

export interface DesktopMemoryCurator {
  readonly conversationExtractor: ConversationMemoryExtractor;
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
  source(input: {
    readonly missionId: string;
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<LocalHostSystemExecutorSource>;
  fingerprint(): Promise<string>;
  recoverOrphans(): Promise<number>;
  retireJobs(jobIds: readonly string[]): Promise<void>;
  listRuns(input: {
    readonly module: DesktopMemoryExtractionRun["module"];
    readonly jobId: string;
  }): Promise<readonly DesktopMemoryExtractionRun[]>;
  getRunChat(runId: string): Promise<MissionConversationSnapshot | undefined>;
  subscribeRunChat(listener: (update: DesktopMemoryExtractionRunChatUpdate) => void): () => void;
}

export function createDesktopMemoryCurator(options: {
  readonly profiles: MemoryExtractorProfileStore;
  readonly missions: MissionStore;
  readonly application: LocalHostMissionApplication;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly now?: (() => Date) | undefined;
}): DesktopMemoryCurator {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.memory-curator",
  });
  const now = options.now ?? (() => new Date());
  const runArchive = createMemoryExtractionRunArchive(options.pragmaHome, {
    onMaintenanceError(error) {
      logger.warn(
        "desktop.memory_curator_run_archive_maintenance_failed",
        "Memory Curator run archive maintenance could not be completed.",
        { error },
      );
    },
  });
  const activeRuns = new Map<string, DesktopMemoryExtractionRun>();
  const activeSessions = new Map<string, MemoryExtractionSession>();
  const budgetStops = new Set<string>();
  const runChatListeners = new Set<(update: DesktopMemoryExtractionRunChatUpdate) => void>();
  options.application.subscribeChat(({ update }) => {
    const run = activeRuns.get(update.missionId);
    if (run === undefined) return;
    const wrapped = { module: run.module, jobId: run.jobId, runId: run.runId, update };
    for (const listener of runChatListeners) listener(wrapped);
  });

  const resolveRuntime = async (
    profile: MemoryExtractorProfile,
    runtimes: RuntimeResolver = options.runtimes,
    inheritedRuntimeId?: string,
  ) => {
    if (
      profile.mode === "pinned" &&
      (profile.runtimeId === undefined ||
        profile.providerId === undefined ||
        profile.modelId === undefined)
    ) {
      throw new Error("memory_extractor_profile_invalid");
    }
    const runtimeId: string =
      profile.mode === "pinned"
        ? profile.runtimeId!
        : (inheritedRuntimeId ?? (await runtimes.getDefaultRuntimeId()));
    const requested: RuntimeModelSelection | undefined =
      profile.mode === "pinned"
        ? {
            model: { providerId: profile.providerId!, modelId: profile.modelId! },
            ...(profile.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: profile.thinkingLevel }),
          }
        : undefined;
    const resolved = await runtimes.bind({
      runtimeId,
      ...(requested === undefined ? {} : { modelSelection: requested }),
    });
    let modelSelection: RuntimeModelSelection | undefined = requested;
    if (modelSelection === undefined) {
      const models = await resolved.adapter.listModels?.();
      const model = models?.find((candidate) => candidate.default === true) ?? models?.[0];
      if (model !== undefined) {
        modelSelection = { model: { providerId: model.provider.id, modelId: model.id } };
      }
    }
    return { profile, runtimeId, resolved, modelSelection };
  };

  const source = async (input: {
    readonly missionId: string;
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<LocalHostSystemExecutorSource> => {
    const activeRun = activeRuns.get(input.missionId);
    if (activeRun === undefined) throw new Error("memory_curator_run_unavailable");
    const mission = await options.missions.get(input.missionId);
    const runtime = {
      runtimeId: activeRun.runtimeId,
      modelSelection:
        mission.modelOverride === undefined
          ? undefined
          : {
              model: {
                providerId: mission.modelOverride.providerId,
                modelId: mission.modelOverride.modelId,
              },
              ...(mission.modelOverride.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: mission.modelOverride.thinkingLevel }),
            },
    };
    const session = activeSessions.get(input.missionId);
    if (session === undefined) throw new Error("memory_curator_session_unavailable");
    await session.assertCurrent();
    const resource = memoryCuratorResource(session.toolContractVersion);
    for (const capability of resource.spec.capabilities) {
      if (capability.kind === "tools") capability.tools = [...session.toolNames];
    }
    resource.spec.toolPolicy = {
      ...resource.spec.toolPolicy,
      allowedTools: [...session.toolNames],
    };
    // A warm compiled Expert retains its tools across prompts. Resolve the live admission on
    // every call, rather than retaining a finished claim's cancellation/permission closures.
    const currentSession = (): MemoryExtractionSession => {
      const current = activeSessions.get(input.missionId);
      if (current === undefined || current.key !== session.key)
        throw new Error("memory_curator_session_unavailable");
      return current;
    };

    return {
      ref: BUILT_IN_MEMORY_CURATOR_REF,
      expertResource: resource,
      adapterHost: {
        environmentId: "desktop",
        projectRoot: input.workspace,
        async resolveBinding(ref) {
          return ref === "binding:pragma.memory-curator"
            ? {
                ref,
                revision: "1",
                // Include the tool contract in the identity without changing the SHA-256 format.
                fingerprint: createHash("sha256")
                  .update(
                    JSON.stringify({
                      sessionKey: session.key,
                      toolContractVersion: session.toolContractVersion,
                    }),
                  )
                  .digest("hex"),
                value: {
                  contribution: {
                    tools: createMemoryCuratorTools(
                      {
                        module: session.module,
                        toolContractVersion: session.toolContractVersion,
                        toolNames: session.toolNames,
                        subjectAliases: session.subjectAliases,
                        call: (name, args) => currentSession().call(name, args),
                        async deliverErrorResponse(text, feedback) {
                          try {
                            return await currentSession().deliverErrorResponse(text, feedback);
                          } catch (error) {
                            if (
                              error instanceof Error &&
                              error.message === "memory_curator_budget_exhausted" &&
                              !budgetStops.has(input.missionId)
                            ) {
                              budgetStops.add(input.missionId);
                              // Do not await Native teardown from inside its pending tool call.
                              void options.application
                                .interrupt(input.missionId)
                                .catch((failure: unknown) =>
                                  logger.warn(
                                    "desktop.memory_curator_budget_stop_unconfirmed",
                                    "Memory Curator budget was exhausted but Native cancellation could not be confirmed.",
                                    { missionId: input.missionId, error: failure },
                                  ),
                                );
                            }
                            throw error;
                          }
                        },
                      },
                      async () => {
                        const current = currentSession();
                        await current.assertCurrent();
                        const snapshot = await options.application.getInternalContextWindow(
                          input.missionId,
                        );
                        const usage = snapshot.contextWindow?.usage;
                        if (usage !== undefined) {
                          await current.setContextBudget(usage.contextWindowTokens - 12000);
                          if (
                            usage.usedTokens !== null &&
                            usage.contextWindowTokens - usage.usedTokens < 4000
                          )
                            await current.setContextBudget(1);
                        }
                      },
                    ),
                  },
                },
              }
            : undefined;
        },
        async resolveArtifact() {
          throw new Error("memory_curator_artifact_denied");
        },
        async resolveSecret() {
          return undefined;
        },
      },
      environmentId: "desktop",
      definitionStateRoot: join(input.pragmaHome, "cache", "built-in-agents", "definitions"),
      workspace: input.workspace,
      pragmaHome: input.pragmaHome,
      runtimes: input.runtimes,
      rootExecutionOverride: {
        runtimeId: runtime.runtimeId,
        ...(runtime.modelSelection === undefined ? {} : { modelSelection: runtime.modelSelection }),
      },
      ...(runtime.modelSelection === undefined
        ? {}
        : { defaultModelSelection: runtime.modelSelection }),
      loggerProvider: input.loggerProvider,
    };
  };

  const curator = createBuiltInMemoryCurator({
    profiles: options.profiles,
    pragmaHome: options.pragmaHome,
    now,
    execution: {
      async run(input) {
        const persisted = await input.session.executionState();
        let admitted = persisted.admitted;
        try {
          const savedMission =
            persisted.missionId === undefined
              ? undefined
              : await options.missions.get(persisted.missionId);
          const profile =
            savedMission === undefined || persisted.provenance === undefined
              ? input.profile
              : savedMission.modelOverride === undefined
                ? {
                    schemaVersion: input.profile.schemaVersion,
                    revision: persisted.provenance.profileRevision,
                    mode: "inherit-default" as const,
                    updatedAt: input.profile.updatedAt,
                  }
                : {
                    ...input.profile,
                    mode: "pinned" as const,
                    runtimeId: persisted.provenance.runtimeId,
                    providerId: savedMission.modelOverride.providerId,
                    modelId: savedMission.modelOverride.modelId,
                    thinkingLevel: savedMission.modelOverride.thinkingLevel,
                  };
          const runtime = await resolveRuntime(
            profile,
            options.runtimes,
            persisted.provenance?.runtimeId,
          );
          if (persisted.provenance === undefined)
            await input.session.setProvenance({
              curatorRef: MEMORY_CURATOR_REF,
              promptVersion: input.session.promptVersion,
              profileRevision: input.profile.revision,
              runtimeId: runtime.runtimeId,
              providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
              modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
              extractedAt: now().toISOString(),
            });
          await runCuratorMission({
            options,
            runtime,
            jobId: input.jobId,
            module: input.module,
            title: input.title,
            goal: input.prompt,
            signal: input.signal,
            runArchive,
            activeRuns,
            activeSessions,
            session: input.session,
            onAdmission() {
              admitted = true;
              input.onAdmission?.();
            },
          });
        } catch (error) {
          if (!admitted && error instanceof Error) Object.assign(error, { preAdmission: true });
          throw error;
        } finally {
          for (const id of budgetStops) if (!activeRuns.has(id)) budgetStops.delete(id);
        }
      },
    },
  });

  return {
    source,
    async retireJobs(jobIds) {
      const entries = (await readCuratorMissionRegistry(options.pragmaHome)).filter((entry) =>
        jobIds.includes(entry.jobId),
      );
      for (const entry of entries) {
        let mission;
        try {
          mission = await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await unregisterCuratorMission(options.pragmaHome, entry.missionId);
            continue;
          }
          throw error;
        }
        if (
          mission.execution !== undefined &&
          ["queued", "running", "waiting"].includes(mission.execution.status)
        )
          await options.application.interrupt(entry.missionId);
        const archived = (
          await Promise.all(
            (["episodic", "semantic", "conversation"] as const).map((module) =>
              runArchive.listForJob({ module, jobId: entry.jobId }),
            ),
          )
        )
          .flat()
          .find((run) => run.missionId === entry.missionId);
        if (archived?.chat === undefined) {
          const chat = await retryCuratorResultOperation(() =>
            options.application.getInternalConversationSnapshot(entry.missionId),
          );
          const snapshot = await createMemoryExtractionSessionStore(options).forMission(
            entry.missionId,
          );
          const state = await snapshot?.executionState();
          if (archived === undefined && state?.provenance === undefined)
            throw new Error("memory_curator_archive_unavailable");
          const provenance = state?.provenance;
          await runArchive.save(
            archived === undefined
              ? {
                  schemaVersion: "pragma.desktop-memory-extraction-run/v2",
                  runId: randomUUID(),
                  missionId: entry.missionId,
                  module: snapshot!.module,
                  jobId: entry.jobId,
                  status: (await snapshot!.completed()) ? "succeeded" : "failed",
                  startedAt: entry.createdAt,
                  finishedAt: now().toISOString(),
                  runtimeId: provenance!.runtimeId,
                  providerId: provenance!.providerId,
                  modelId: provenance!.modelId,
                  continuations: state!.continuations,
                  chat,
                }
              : { ...archived, chat },
          );
        }
        // The shared deletion owner graph refuses uncertain Native teardown. The transcript is
        // already durable, so a fresh admission cannot overlap a previous billable owner.
        if (
          !(await cleanupInternalMission({
            missionId: entry.missionId,
            deleteMission: (id) => options.application.delete(id),
            interruptMission: (id) => options.application.interrupt(id),
          }))
        )
          throw new Error("memory_curator_retirement_unconfirmed");
        await unregisterCuratorMission(options.pragmaHome, entry.missionId);
      }
    },
    async listRuns(input) {
      const archived = await runArchive.listForJob(input);
      const active = [...activeRuns.values()].filter(
        (run) => run.module === input.module && run.jobId === input.jobId,
      );
      return [...active, ...archived]
        .filter(
          (run, index, all) =>
            all.findIndex((candidate) => candidate.runId === run.runId) === index,
        )
        .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, 20);
    },
    async getRunChat(runId) {
      const active = [...activeRuns.values()].find((run) => run.runId === runId);
      if (active !== undefined) {
        return await options.application.getInternalConversationSnapshot(active.missionId);
      }
      const archived = await runArchive.get(runId);
      if (archived === undefined) return undefined;
      if (archived.status === "succeeded" && archived.chat !== undefined) return archived.chat;
      // Failed reads can recover later. Prefer the retained execution over an incomplete archive.
      try {
        return await options.application.getInternalConversationSnapshot(archived.missionId);
      } catch (error) {
        if (archived.chat === undefined) throw error;
        return archived.chat;
      }
    },
    subscribeRunChat(listener) {
      runChatListeners.add(listener);
      return () => runChatListeners.delete(listener);
    },
    async recoverOrphans() {
      await removeStaleCuratorTemps(options.pragmaHome);
      const entries = await readCuratorMissionRegistry(options.pragmaHome);
      let recovered = 0;
      for (const entry of entries.slice(0, 100)) {
        let mission;
        try {
          mission = await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await unregisterCuratorMission(options.pragmaHome, entry.missionId);
            continue;
          }
          logger.warn(
            "desktop.memory_curator_orphan_read_failed",
            "A registered Memory Curator Mission could not be inspected and was retained for retry.",
            { error, missionId: entry.missionId },
          );
          continue;
        }
        const terminal =
          mission.execution !== undefined &&
          ["succeeded", "failed", "cancelled"].includes(mission.execution.status);
        const stale =
          Date.now() - Date.parse(entry.createdAt) >=
          DEFAULT_MEMORY_STORAGE_POLICY.curatorOrphanGraceMs;
        if (!terminal && !stale) continue;
        const archived = (
          await Promise.all(
            (["episodic", "semantic", "conversation", "knowledge", "skill"] as const).map(
              (module) => runArchive.listForJob({ module, jobId: entry.jobId }),
            ),
          )
        )
          .flat()
          .find((run) => run.missionId === entry.missionId);
        // Do not destroy the only durable provider result after a failed read/archive or crash.
        if (
          (archived?.chat === undefined || archived.status !== "succeeded") &&
          Date.now() - Date.parse(entry.createdAt) <
            DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs
        )
          continue;

        if (
          await cleanupInternalMission({
            missionId: entry.missionId,
            deleteMission: (id) => options.application.delete(id),
            interruptMission: (id) => options.application.interrupt(id),
          })
        ) {
          await unregisterCuratorMission(options.pragmaHome, entry.missionId);
          recovered += 1;
        }
      }
      return recovered;
    },
    async fingerprint() {
      return await createFingerprint(await options.profiles.get());
    },
    episodicExtractor: curator.episodicExtractor,
    semanticExtractor: curator.semanticExtractor,
    conversationExtractor: curator.conversationExtractor,
  };
}

async function runCuratorMission(input: {
  readonly options: Pick<
    Parameters<typeof createDesktopMemoryCurator>[0],
    "project" | "missions" | "application" | "workspace" | "pragmaHome" | "loggerProvider" | "now"
  >;
  readonly runtime: {
    readonly runtimeId: string;
    readonly modelSelection?: RuntimeModelSelection | undefined;
  };
  readonly jobId: string;
  readonly module: "episodic" | "semantic" | "conversation" | "knowledge" | "skill";
  readonly title: string;
  readonly goal: string;
  readonly signal?: AbortSignal | undefined;
  readonly runArchive: MemoryExtractionRunArchive;
  readonly activeRuns: Map<string, DesktopMemoryExtractionRun>;
  readonly activeSessions: Map<string, MemoryExtractionSession>;
  readonly session: MemoryExtractionSession;
  readonly onAdmission?: (() => void) | undefined;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const project = await input.options.project.ensurePublished();
  const prior = input.module === "conversation" ? await input.session.executionState() : undefined;
  const mission =
    prior?.missionId === undefined
      ? await input.options.missions.create({
          workspace: {
            path: input.options.workspace,
            basename: basename(input.options.workspace),
          },
          goal: input.goal,
          title: input.title,
          project: { id: project.projectId, revision: project.revision },
          executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
          origin: { type: "system-memory", jobId: input.jobId },
          ...(input.runtime.modelSelection === undefined
            ? {}
            : {
                modelOverride: {
                  providerId: input.runtime.modelSelection.model.providerId,
                  modelId: input.runtime.modelSelection.model.modelId,
                  ...(input.runtime.modelSelection.thinkingLevel === undefined
                    ? {}
                    : { thinkingLevel: input.runtime.modelSelection.thinkingLevel }),
                },
              }),
        })
      : await input.options.missions.get(prior.missionId);
  const pragmaHome = input.options.pragmaHome;
  const logger = createPragmaLogger(input.options.loggerProvider, {
    component: "desktop.memory-curator",
  });
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const activeRun: DesktopMemoryExtractionRun = {
    schemaVersion: "pragma.desktop-memory-extraction-run/v2",
    runId,
    missionId: mission.id,
    module: input.module,
    jobId: input.jobId,
    status: "running",
    startedAt,
    runtimeId: input.runtime.runtimeId,
    continuations: prior?.continuations ?? 0,
    ...(input.runtime.modelSelection === undefined
      ? {}
      : {
          providerId: input.runtime.modelSelection.model.providerId,
          modelId: input.runtime.modelSelection.model.modelId,
        }),
  };
  await input.session.bindMission(mission.id);
  input.activeSessions.set(mission.id, input.session);
  input.activeRuns.set(mission.id, activeRun);
  const pendingTypesAtStart = await input.session.pendingTypes();
  let failure: MemoryExtractionFailureDiagnostic | undefined;
  let finalStatus: DesktopMemoryExtractionRun["status"] = "failed";
  let executionRequested = false;
  let resultReadRequested = false;
  let resultChat: MissionConversationSnapshot | undefined;
  const interrupt = (): void => {
    void input.options.application.interrupt(mission.id).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", interrupt, { once: true });
  const reserveRepair = async (previousExecutionId: string): Promise<void> => {
    const code = await input.session.failure();
    if (code !== undefined && /budget|capacity|denied|stale|unavailable|claim|snapshot/u.test(code))
      throw Object.assign(new Error(code), { code, retryable: false });
    await input.session.reserveContinuation({
      previousExecutionId,
      prompt: await input.session.continuationPrompt(),
    });
    input.activeRuns.set(mission.id, {
      ...activeRun,
      continuations: (await input.session.executionState()).continuations,
    });
  };
  const prepareTurnProvenance = async (): Promise<void> => {
    const current = (await input.session.executionState()).provenance;
    if (current === undefined) return;
    await input.session.setProvenance(
      {
        ...current,
        responseModel: undefined,
        extractedAt: (input.options.now?.() ?? new Date()).toISOString(),
      },
      [],
    );
  };
  try {
    await registerCuratorMission(pragmaHome, mission.id, input.jobId);
    input.signal?.throwIfAborted();
    await input.session.assertCurrent();
    // Once admitted, provider execution/billing may have happened even if a later read fails.
    executionRequested = true;
    if (prior?.missionId === undefined || !prior.admitted) {
      await prepareTurnProvenance();
      await input.session.markAdmitted();
      input.onAdmission?.();
      try {
        await input.options.application.startRun(mission.id);
      } catch (error) {
        if (consumeUnstartedMissionPreparationFailure(error, mission.id)) {
          await input.session.withdrawUnstartedAdmission();
          executionRequested = false;
          Object.assign(error as object, { preAdmission: true });
        }
        throw error;
      }
    } else if (
      prior.pendingContinuation === undefined &&
      (mission.execution === undefined ||
        ["queued", "running", "waiting"].includes(mission.execution.status))
    )
      throw Object.assign(new Error("memory_curator_execution_unconfirmed"), { retryable: false });
    else if (input.module === "conversation" && prior.pendingContinuation === undefined) {
      // Reopening an attention task authorizes continuation. Crash recovery reaches
      // this path only with its already reserved command; it must not revive a cancelled turn.
      await reserveRepair(mission.execution!.id);
    }
    let finished: Awaited<ReturnType<typeof input.options.missions.get>>;
    let pendingTypesForTurn = pendingTypesAtStart;
    for (;;) {
      const state = await input.session.executionState();
      let expectedExecutionId: string | undefined;
      if (input.module === "conversation" && state.pendingContinuation !== undefined) {
        const pending = state.pendingContinuation;
        pendingTypesForTurn = await input.session.pendingTypes();
        await waitForInternalMissionRetry(
          Math.max(0, Date.parse(pending.retryAt) - Date.now()),
          input.signal,
        );
        await input.session.assertCurrent();
        await prepareTurnProvenance();
        input.onAdmission?.();
        const continued = await input.options.application.continueInternalMemoryMission({
          id: mission.id,
          content: pending.prompt,
          requestId: pending.requestId,
          previousExecutionId: pending.previousExecutionId,
        });
        expectedExecutionId = continued.executionId;
        await input.session.acknowledgeContinuation(pending.requestId);
      }
      await waitForInternalMissionTerminal({
        getMission: (id) => input.options.missions.get(id),
        missionId: mission.id,
        timeoutMessage: "memory_curator_timeout",
        signal: input.signal,
        executionId: expectedExecutionId,
      });
      finished = await input.options.missions.get(mission.id);
      const pendingAfterTurn = await input.session.pendingTypes();
      const completedTypes = pendingTypesForTurn.filter((type) => !pendingAfterTurn.includes(type));
      if (completedTypes.length > 0) {
        let responseModel: string | undefined;
        try {
          responseModel = (
            await retryCuratorResultOperation(
              () => input.options.application.getTerminalRuntimeOutputDiagnostic(mission.id),
              input.signal,
            )
          )?.responseModel;
        } catch (error) {
          input.signal?.throwIfAborted();
          logger.warn(
            "desktop.memory_curator_provenance_read_failed",
            "Extraction completed; supplementary Runtime provenance could not be read.",
            { error, missionId: mission.id },
          );
        }
        for (const type of completedTypes) {
          const receipt = await input.session.receiptFor(type);
          if (receipt === undefined) continue;
          try {
            await retryCuratorResultOperation(
              () =>
                input.session.setProvenance(
                  {
                    ...receipt.provenance,
                    ...(responseModel === undefined ? {} : { responseModel }),
                    extractedAt:
                      finished.execution?.finishedAt ??
                      (input.options.now?.() ?? new Date()).toISOString(),
                  },
                  [type],
                ),
              input.signal,
            );
          } catch (error) {
            logger.warn(
              "desktop.memory_curator_provenance_update_failed",
              "Extraction completed; supplementary provenance could not be fully updated.",
              { error, missionId: mission.id, type },
            );
          }
        }
      }
      if (input.module !== "conversation" || (await input.session.completed())) break;
      const runtimeFailure =
        finished.execution?.status === "failed"
          ? await input.options.application.getTerminalRuntimeFailure(mission.id)
          : undefined;
      if (
        finished.execution?.status === "cancelled" ||
        (finished.execution?.status === "failed" && runtimeFailure?.retryable !== true)
      )
        break;
      if (finished.execution === undefined) throw new Error("memory_curator_execution_unconfirmed");
      await reserveRepair(finished.execution.id);
    }
    if (
      !(await input.session.completed()) &&
      (await input.session.failure()) === "memory_curator_budget_exhausted"
    )
      throw Object.assign(new Error("memory_curator_budget_exhausted"), {
        code: "memory_curator_budget_exhausted",
        retryable: false,
      });
    if (
      finished.execution?.status !== "succeeded" &&
      !(input.module === "conversation" && (await input.session.completed()))
    ) {
      const runtimeFailure = await input.options.application.getTerminalRuntimeFailure(mission.id);
      const message =
        runtimeFailure?.message ?? finished.execution?.error ?? "Memory Curator failed.";
      const error = Object.assign(new Error(message), {
        code: runtimeFailure?.code ?? "memory_curator_failed",
        retryable: finished.execution?.status === "failed" && (runtimeFailure?.retryable ?? true),
        runtimeId: input.runtime.runtimeId,
        providerId: input.runtime.modelSelection?.model.providerId,
        modelId: input.runtime.modelSelection?.model.modelId,
        ...(runtimeFailure?.httpStatus === undefined
          ? {}
          : { httpStatus: runtimeFailure.httpStatus }),
        ...(runtimeFailure?.requestId === undefined ? {} : { requestId: runtimeFailure.requestId }),
        ...(runtimeFailure?.endpoint === undefined ? {} : { endpoint: runtimeFailure.endpoint }),
      });
      failure = curatorFailureDiagnostic(error, activeRun, startedAt);
      finalStatus = finished.execution?.status === "cancelled" ? "cancelled" : "failed";
      throw error;
    }
    resultReadRequested = true;
    const receipt = await input.session.receipt();
    if (receipt === undefined)
      throw Object.assign(
        new Error((await input.session.failure()) ?? "memory_curator_result_unavailable"),
        { retryable: false },
      );
    try {
      resultChat = await retryCuratorResultOperation(
        () => input.options.application.getInternalConversationSnapshot(mission.id),
        input.signal,
      );
    } catch (error) {
      logger.warn(
        "desktop.memory_curator_archive_read_failed",
        "Extraction completed; its transcript could not be read for archiving.",
        { error, missionId: mission.id },
      );
    }
    finalStatus = "succeeded";
    return;
  } catch (error) {
    let failureError = error;
    if (executionRequested) {
      failureError = Object.assign(
        new Error(error instanceof Error ? error.message : String(error), { cause: error }),
        {
          code:
            typeof (error as { code?: unknown } | null)?.code === "string"
              ? (error as { code: string }).code
              : "memory_curator_result_unavailable",
          // A retryable local read must not authorize replay of a succeeded, billable execution.
          retryable:
            resultReadRequested || input.signal?.aborted === true
              ? false
              : ((error as { retryable?: boolean } | null)?.retryable ?? false),
        },
      );
    }
    failure ??= curatorFailureDiagnostic(failureError, activeRun, startedAt);
    if (input.signal?.aborted === true) finalStatus = "cancelled";
    throw failureError;
  } finally {
    input.signal?.removeEventListener("abort", interrupt);
    const chat = resultReadRequested
      ? resultChat
      : await input.options.application
          .getInternalConversationSnapshot(mission.id)
          .catch(() => undefined);
    let archived = false;
    const continuations = await input.session
      .executionState()
      .then((state) => state.continuations)
      .catch(() => input.activeRuns.get(mission.id)?.continuations ?? activeRun.continuations);
    await input.runArchive
      .save({
        ...activeRun,
        continuations,
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        ...(failure === undefined ? {} : { failure }),
        ...(chat === undefined ? {} : { chat }),
      })
      .then(() => {
        archived = true;
      })
      .catch((error: unknown) => {
        logger.warn(
          "desktop.memory_curator_run_archive_failed",
          "A completed Memory Curator transcript could not be archived.",
          { error, missionId: mission.id, runId },
        );
      });
    input.activeRuns.delete(mission.id);
    input.activeSessions.delete(mission.id);
    if (
      archived &&
      chat !== undefined &&
      finalStatus === "succeeded" &&
      (await cleanupInternalMission({
        missionId: mission.id,
        deleteMission: (id) => input.options.application.delete(id),
        interruptMission: (id) => input.options.application.interrupt(id),
      }))
    ) {
      await unregisterCuratorMission(pragmaHome, mission.id).catch((error: unknown) => {
        logger.warn(
          "desktop.memory_curator_registry_cleanup_failed",
          "A completed Memory Curator Mission remains registered for later cleanup.",
          { error, missionId: mission.id },
        );
      });
    }
  }
}

function curatorFailureDiagnostic(
  error: unknown,
  run: DesktopMemoryExtractionRun,
  startedAt: string,
): MemoryExtractionFailureDiagnostic {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  return {
    schemaVersion: "pragma.memory-extraction-failure/v1",
    code: typeof record.code === "string" ? record.code : "memory_curator_failed",
    message: redactCuratorDiagnosticText(message).slice(0, 4_096),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    phase: "curator_run",
    failedAt: new Date().toISOString(),
    startedAt,
    durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    runtime: {
      runtimeId: run.runtimeId,
      ...(run.providerId === undefined ? {} : { providerId: run.providerId }),
      ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
      ...(typeof record.endpoint === "string" ? { endpoint: record.endpoint } : {}),
    },
    ...(typeof record.httpStatus === "number" || typeof record.requestId === "string"
      ? {
          transport: {
            ...(typeof record.httpStatus === "number" ? { httpStatus: record.httpStatus } : {}),
            ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
          },
        }
      : {}),
  };
}

function redactCuratorDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)=([^\s&]+)/giu, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^\s&#]+/giu, "$1[REDACTED]");
}

/** Retry local result reads and idempotent metadata writes; never rerun the model. */
async function retryCuratorResultOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 3) throw error;
      await waitForInternalMissionRetry(5_000, signal);
    }
  }
}

async function createFingerprint(profile: MemoryExtractorProfile): Promise<string> {
  return createHash("sha256")
    .update(
      JSON.stringify({
        episodicCurator: MEMORY_CURATOR_PROMPT_VERSION,
        semanticCurator: SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
        definition: builtInAgentFingerprint(BUILT_IN_MEMORY_CURATOR_REF),
        profile,
      }),
    )
    .digest("hex");
}

async function registerCuratorMission(
  pragmaHome: string,
  missionId: string,
  jobId: string,
): Promise<void> {
  await updateCuratorMissionRegistry(pragmaHome, (entries) => [
    ...entries
      .filter((entry) => entry.missionId !== missionId)
      .slice(-(DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries - 1)),
    { missionId, jobId, createdAt: new Date().toISOString() },
  ]);
}

async function unregisterCuratorMission(pragmaHome: string, missionId: string): Promise<void> {
  await updateCuratorMissionRegistry(pragmaHome, (entries) =>
    entries.filter((entry) => entry.missionId !== missionId),
  );
}

async function readCuratorMissionRegistry(pragmaHome: string) {
  const path = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  try {
    return CuratorMissionRegistrySchema.parse(JSON.parse(await readFile(path, "utf8"))).entries;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function updateCuratorMissionRegistry(
  pragmaHome: string,
  update: (
    entries: z.infer<typeof CuratorMissionRegistrySchema>["entries"],
  ) => z.infer<typeof CuratorMissionRegistrySchema>["entries"],
): Promise<void> {
  const path = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  await withFileLock(`${path}.lock`, async () => {
    const entries = await readCuratorMissionRegistry(pragmaHome);
    const next = CuratorMissionRegistrySchema.parse({
      schemaVersion: "pragma.memory-curator-mission-registry/v1",
      entries: update(entries),
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

async function removeStaleCuratorTemps(pragmaHome: string): Promise<void> {
  const registry = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  const root = dirname(registry);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const cutoff = Date.now() - DEFAULT_MEMORY_STORAGE_POLICY.atomicTempRetentionMs;
  for (const name of names.filter((value) => value.endsWith(".tmp"))) {
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
