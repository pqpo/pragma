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
  MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF,
  builtInAgentFingerprint,
  compileBuiltInAgent,
  createBuiltInMemoryCurator,
  createSkillDraftSession,
  type SkillDraftSession,
} from "@pragma/built-in-agents";
import type { CompiledResource, InvocableResource, PragmaBindingRecord } from "@pragma/interpreter";
import {
  MEMORY_CURATOR_PROMPT_VERSION,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
  SKILL_MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  DEFAULT_MEMORY_STORAGE_POLICY,
  type EpisodicMemoryExtractor,
  type KnowledgeMemoryExtractor,
  type SemanticMemoryExtractor,
  type SkillMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
} from "@pragma/memory";
import type { MemoryExtractionFailureDiagnostic } from "@pragma/shared";

import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { z } from "zod";
import type {
  DesktopMemoryExtractionRun,
  DesktopMemoryExtractionRunChatUpdate,
  MissionChatSnapshot,
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
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
  readonly knowledgeExtractor: KnowledgeMemoryExtractor;
  readonly skillExtractor: SkillMemoryExtractor;
  compile(input: {
    readonly missionId: string;
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(): Promise<string>;
  recoverOrphans(): Promise<number>;
  listRuns(input: {
    readonly module: DesktopMemoryExtractionRun["module"];
    readonly jobId: string;
  }): Promise<readonly DesktopMemoryExtractionRun[]>;
  getRunChat(runId: string): Promise<MissionChatSnapshot | undefined>;
  subscribeRunChat(listener: (update: DesktopMemoryExtractionRunChatUpdate) => void): () => void;
}

export function createDesktopMemoryCurator(options: {
  readonly profiles: MemoryExtractorProfileStore;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
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
  const skillDraftSessions = new Map<string, SkillDraftSession>();
  const runChatListeners = new Set<(update: DesktopMemoryExtractionRunChatUpdate) => void>();
  options.runner.subscribeChat(({ update }) => {
    const run = activeRuns.get(update.missionId);
    if (run === undefined) return;
    const wrapped = { module: run.module, jobId: run.jobId, runId: run.runId, update };
    for (const listener of runChatListeners) listener(wrapped);
  });

  const resolveRuntime = async (
    profile: MemoryExtractorProfile,
    runtimes: RuntimeResolver = options.runtimes,
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
      profile.mode === "pinned" ? profile.runtimeId! : await runtimes.getDefaultRuntimeId();
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

  const compile = async (input: {
    readonly missionId: string;
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<CompiledResource<InvocableResource>> => {
    const runtime = await resolveRuntime(await options.profiles.get(), input.runtimes);
    const tools = skillDraftSessions.get(input.missionId)?.tools ?? [];
    return await compileBuiltInAgent({
      ref: BUILT_IN_MEMORY_CURATOR_REF,
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
      adapterHost: {
        environmentId: "desktop",
        projectRoot: input.workspace,
        async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
          if (ref !== MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF) return undefined;
          return {
            ref,
            // Skill draft tools close over Mission-local mutable state. Keep the binding
            // revision Mission-specific so Interpreter environment caches can never reuse
            // another Mission's tool instances.
            revision: input.missionId,
            fingerprint: createHash("sha256")
              .update(
                JSON.stringify(
                  {
                    missionId: input.missionId,
                    tools: tools.map((tool) => ({
                      name: tool.name,
                      inputSchema: tool.inputSchema,
                      approval: tool.approval?.mode,
                    })),
                  },
                ),
              )
              .digest("hex"),
            value: { contribution: { tools } },
          };
        },
        async resolveArtifact(source) {
          throw new Error(`Unexpected Memory Curator artifact: ${JSON.stringify(source)}`);
        },
        async resolveSecret() {
          return undefined;
        },
      },
    });
  };

  const curator = createBuiltInMemoryCurator({
    profiles: options.profiles,
    now,
    execution: {
      async run(input) {
        const runtime = await resolveRuntime(input.profile);
        const result = await runCuratorMission({
          options,
          runtime,
          jobId: input.jobId,
          module: input.module,
          title: input.title,
          goal: input.prompt,
          signal: input.signal,
          runArchive,
          activeRuns,
          skillDraftSessions,
          skillInput: input.skillInput,
        });
        return {
          ...result,
          runtimeId: runtime.runtimeId,
          providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
          modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
        };
      },
    },
  });

  return {
    compile,
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
        return await options.runner.getChat({ id: active.missionId, limit: 100 });
      }
      return (await runArchive.get(runId))?.chat;
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
        if (await cleanupCuratorMission(options.runner, entry.missionId)) {
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
    knowledgeExtractor: curator.knowledgeExtractor,
    skillExtractor: curator.skillExtractor,
  };
}

async function runCuratorMission(input: {
  readonly options: Pick<
    Parameters<typeof createDesktopMemoryCurator>[0],
    "project" | "missions" | "runner" | "workspace" | "pragmaHome" | "loggerProvider"
  >;
  readonly runtime: {
    readonly runtimeId: string;
    readonly modelSelection?: RuntimeModelSelection | undefined;
  };
  readonly jobId: string;
  readonly module: "episodic" | "semantic" | "knowledge" | "skill";
  readonly title: string;
  readonly goal: string;
  readonly signal?: AbortSignal | undefined;
  readonly runArchive: MemoryExtractionRunArchive;
  readonly activeRuns: Map<string, DesktopMemoryExtractionRun>;
  readonly skillDraftSessions: Map<string, SkillDraftSession>;
  readonly skillInput?: import("@pragma/shared").SkillExtractionInput | undefined;
}): Promise<{
  readonly content: string;
  readonly responseModel?: string | undefined;
  readonly finishReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
  readonly usage?: import("@pragma/shared").AgentMessageUsage | undefined;
  readonly skillOutput?: import("@pragma/shared").SkillExtractionOutput | undefined;
}> {
  input.signal?.throwIfAborted();
  if (input.module === "skill" && input.skillInput === undefined) {
    throw new Error("skill_extraction_input_missing");
  }
  const skillDraftSession =
    input.module === "skill" ? createSkillDraftSession(input.skillInput!) : undefined;
  const project = await input.options.project.ensurePublished();
  const mission = await input.options.missions.create({
    workspace: {
      path: input.options.workspace,
      basename: basename(input.options.workspace),
    },
    goal: input.goal,
    title: input.title,
    project: { id: project.projectId, revision: project.revision },
    executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
    origin: { type: "system-memory", jobId: input.jobId },
    toolPermissionMode: "request-approval",
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
  });
  const pragmaHome = input.options.pragmaHome;
  const logger = createPragmaLogger(input.options.loggerProvider, {
    component: "desktop.memory-curator",
  });
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const activeRun: DesktopMemoryExtractionRun = {
    schemaVersion: "pragma.desktop-memory-extraction-run/v1",
    runId,
    missionId: mission.id,
    module: input.module,
    jobId: input.jobId,
    status: "running",
    startedAt,
    runtimeId: input.runtime.runtimeId,
    ...(input.runtime.modelSelection === undefined
      ? {}
      : {
          providerId: input.runtime.modelSelection.model.providerId,
          modelId: input.runtime.modelSelection.model.modelId,
        }),
  };
  input.activeRuns.set(mission.id, activeRun);
  if (skillDraftSession !== undefined) {
    input.skillDraftSessions.set(mission.id, skillDraftSession);
  }
  let failure: MemoryExtractionFailureDiagnostic | undefined;
  let finalStatus: DesktopMemoryExtractionRun["status"] = "failed";
  const interrupt = (): void => {
    void input.options.runner.interrupt(mission.id).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    await registerCuratorMission(pragmaHome, mission.id, input.jobId);
    input.signal?.throwIfAborted();
    await input.options.runner.run(mission.id);
    await waitForMission(input.options.missions, mission.id, input.signal);
    const finished = await input.options.missions.get(mission.id);
    if (finished.execution?.status !== "succeeded") {
      const runtimeFailure = await input.options.runner.getTerminalRuntimeFailure(mission.id);
      const message =
        runtimeFailure?.message ?? finished.execution?.error ?? "Memory Curator failed.";
      const error = Object.assign(new Error(message), {
        code: runtimeFailure?.code ?? "memory_curator_failed",
        retryable: runtimeFailure?.retryable ?? true,
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
    const chat = await input.options.runner.getChat({ id: mission.id, limit: 100 });
    const content = chat.entries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.content)
      .at(-1);
    if (content === undefined) throw new Error("memory_curator_output_missing");
    const runtimeOutput = await input.options.runner.getTerminalRuntimeOutputDiagnostic(mission.id);
    if (skillDraftSession?.repairExhausted() === true) {
      throw Object.assign(new Error("skill_draft_repair_exhausted"), {
        code: "skill_draft_repair_exhausted",
        retryable: true,
      });
    }
    const skillOutput = skillDraftSession?.output();
    finalStatus = "succeeded";
    return {
      content,
      ...(runtimeOutput?.responseModel === undefined
        ? {}
        : { responseModel: runtimeOutput.responseModel }),
      ...(runtimeOutput?.finishReason === undefined
        ? {}
        : { finishReason: runtimeOutput.finishReason }),
      ...(runtimeOutput?.usage === undefined ? {} : { usage: runtimeOutput.usage }),
      ...(skillOutput === undefined ? {} : { skillOutput }),
    };
  } catch (error) {
    failure ??= curatorFailureDiagnostic(error, activeRun, startedAt);
    if (input.signal?.aborted === true) finalStatus = "cancelled";
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", interrupt);
    const [chat] = await Promise.all([
      input.options.runner.getChat({ id: mission.id, limit: 100 }).catch(() => undefined),
    ]);
    await input.runArchive
      .save({
        ...activeRun,
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        ...(failure === undefined ? {} : { failure }),
        ...(chat === undefined ? {} : { chat }),
      })
      .catch((error: unknown) => {
        logger.warn(
          "desktop.memory_curator_run_archive_failed",
          "A completed Memory Curator transcript could not be archived.",
          { error, missionId: mission.id, runId },
        );
      });
    input.activeRuns.delete(mission.id);
    input.skillDraftSessions.delete(mission.id);
    if (await cleanupCuratorMission(input.options.runner, mission.id)) {
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

async function waitForMission(
  missions: MissionStore,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 200);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("memory_curator_timeout");
}

async function createFingerprint(profile: MemoryExtractorProfile): Promise<string> {
  return createHash("sha256")
    .update(
      JSON.stringify({
        episodicCurator: MEMORY_CURATOR_PROMPT_VERSION,
        semanticCurator: SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
        knowledgeCurator: KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
        skillCurator: SKILL_MEMORY_CURATOR_PROMPT_VERSION,
        definition: builtInAgentFingerprint(BUILT_IN_MEMORY_CURATOR_REF),
        profile,
      }),
    )
    .digest("hex");
}

async function cleanupCuratorMission(runner: MissionRunner, missionId: string): Promise<boolean> {
  try {
    await runner.delete(missionId);
    return true;
  } catch {
    await runner.interrupt(missionId).catch(() => undefined);
    return await runner
      .delete(missionId)
      .then(() => true)
      .catch(() => false);
  }
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
