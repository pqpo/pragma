import { randomUUID } from "node:crypto";
import { access, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import {
  createControllerRunMissionPort,
  createMissionControlApplication,
  createMissionOwnerScope,
  createLocalHostCoreStores,
  createLocalHostCoreMissionControlAdapter,
  createCoreRunExecutorPort,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostApplication,
  createLocalHostMissionBoardBindings,
  createLocalHostProjectCatalogFromHome,
  createLocalHostRunApplication,
  createLocalHostRuntimeResolver,
  createLocalHostStderrLoggerProvider,
  createLocalHostUsageSink,
  filterLocalHostRuntimeProcessEnvironment,
  createMissionControllerStore,
  findMissionPinnedBinding,
  backfillMissionPinnedBinding,
  LOCAL_HOST_SHARED_BOARD_STORE_ID,
  createExpertSessionPromptQueueProjection,
  createMissionWatchApplication,
  createRuntimeTokenCounter,
  listLocalHostBuiltInExecutorDescriptors,
  hashMissionResumePayload,
  type LocalHostMissionResumeRequest,
  type MissionControlExecutionOutcome,
} from "@pragma/local-host";
import { createIntegrationError, IntegrationErrorSchema } from "@pragma/local-host/wire";
import { HumanInteractionRequestEnvelopeSchema } from "@pragma/shared/integration";

import type { CliLocalHost } from "../commands/types.ts";
import { CLI_VERSION } from "../version.ts";

export function createCliLocalHost(
  input: { readonly localHost?: CliLocalHost } = {},
): CliLocalHost {
  return input.localHost ?? createProductionLocalHost();
}

export function createProductionLocalHost(): CliLocalHost {
  const pragmaHome = process.env["PRAGMA_HOME"]?.trim() || join(homedir(), ".pragma");
  const clientInstanceId = randomUUID();
  const environment = filterLocalHostRuntimeProcessEnvironment(process.env);
  const tokenCounter = createRuntimeTokenCounter();
  const runtimes = [
    createCodexRuntime({
      env: environment,
      tokenCounter,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    }),
    createClaudeCodeRuntime({ env: environment, permissionMode: "default", tokenCounter }),
    createQoderCliRuntime({ env: environment, permissionMode: "default", tokenCounter }),
    createAntigravityRuntime({
      env: environment,
      permissionMode: "request-approval",
      tokenCounter,
    }),
    createPiRuntime({ env: environment, tokenCounter }),
  ];
  const runtimeResolver = createLocalHostRuntimeResolver({
    runtimes,
    defaultRuntimeId: "codex-local",
    runtimeAliases: { codex: "codex-local" },
  });
  const loggerProvider = createLocalHostStderrLoggerProvider();
  const resolveBuiltInExecutor = createLocalHostBuiltInExecutorResolver({
    pragmaHome,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const projectCatalog = createLocalHostProjectCatalogFromHome({
    pragmaHome,
    projectId: process.env["PRAGMA_PROJECT_ID"]?.trim() || undefined,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const missionController = createMissionControllerStore({
    missionsPath: join(pragmaHome, "data", "missions"),
  });
  const missionWatch = createMissionWatchApplication({ controller: missionController });
  const ownerScope = createMissionOwnerScope({ controller: missionController });
  const { executions: executionStore, sessions: expertSessionStore } = createLocalHostCoreStores({
    pragmaHome,
  });
  const promptQueueProjection = createExpertSessionPromptQueueProjection({
    sessions: expertSessionStore,
    resolveSessionId: async (missionId) => (await expertSessionStore.get(missionId))?.sessionId,
    supportsSteer: async (sessionId) => {
      const session = await expertSessionStore.get(sessionId);
      if (session === undefined) return false;
      const rootContext = session.contexts[session.rootContextId];
      if (rootContext === undefined) return false;
      const resolved = await runtimeResolver
        .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
        .catch(() => undefined);
      return resolved?.adapter.descriptor.capabilities?.supportsSteer === true;
    },
    resolvePromptMetadata: async (prompt) => ({
      hasAttachments: hasPromptAttachments(
        (await executionStore.getInvocation(prompt.executionId, prompt.executionId))?.input,
      ),
    }),
  });
  const usageSink = createLocalHostUsageSink({
    path: join(pragmaHome, "data", "usage", "observations.json"),
  });
  const resolveExecutor = async (input: Parameters<typeof projectCatalog.resolve>[0]) =>
    (await resolveBuiltInExecutor({ ref: input.ref, workspace: input.workspace })) ??
    (await projectCatalog.resolve(input));
  const executorPort = createCoreRunExecutorPort({
    pragmaHome,
    runtimes: runtimeResolver,
    usageSink,
    loggerProvider,
    executions: executionStore,
    sessions: expertSessionStore,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome, missionId }),
    executors: resolveExecutor,
  });
  const coreControl = createLocalHostCoreMissionControlAdapter({
    pragmaHome,
    runtimes: runtimeResolver,
    usageSink,
    loggerProvider,
    executions: executionStore,
    sessions: expertSessionStore,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome, missionId }),
    executors: resolveExecutor,
    resolveActiveOwner: executorPort.resolveActiveOwner,
    resolveMissionBinding: async (missionId) =>
      findMissionPinnedBinding((await missionController.readSnapshot({ missionId })).events),
    hasPendingMissionCommands: async (missionId) =>
      (await missionController.listOperations({ missionId })).some(
        (operation) => operation.state === "queued" || operation.state === "applying",
      ),
    releaseMissionOwner: async (missionId) => {
      // Recheck immediately before the lease release. A new command arriving
      // while Core resources are being released must leave the poller alive
      // for the same Mission.
      const hasPending = (await missionController.listOperations({ missionId })).some(
        (operation) => operation.state === "queued" || operation.state === "applying",
      );
      if (hasPending) return;
      await ownerScope.release(missionId);
    },
  });
  const missionControl = createMissionControlApplication({
    controller: missionController,
    ownerScope,
    consumer: coreControl.consumer,
    client: { surface: "cli", version: CLI_VERSION, instanceId: clientInstanceId },
    assertMission: async (missionId) => {
      const snapshot = await missionController.readSnapshot({ missionId });
      if (!snapshot.events.some((event) => event.type === "mission.created")) {
        throw createIntegrationError({
          code: "MISSION_NOT_FOUND",
          category: "not_found",
          message: `Mission not found: ${missionId}.`,
          details: { missionId },
        });
      }
    },
    assertAcquisitionAllowed: coreControl.assertAcquisitionAllowed,
    resolveStrictTarget: coreControl.resolveStrictTarget,
    resolveExecutionTarget: coreControl.resolveExecutionTarget,
    waitExecution: coreControl.waitExecution,
  });
  const run = createLocalHostRunApplication({
    executors: executorPort,
    mission: createControllerRunMissionPort(missionController, { ownerScope }),
    commandConsumer: coreControl.consumer,
  });
  const application = createLocalHostApplication({
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1" as const,
      protocol: "pragma.integration/v2" as const,
      readableVersions: ["pragma.integration/v1" as const, "pragma.integration/v2" as const],
      migratableFromVersions: [],
      features: [
        "run",
        "human-interaction",
        "idempotency",
        "mission.watch",
        "mission.resume",
        "mission.send",
        "mission.steer",
        "mission.respond",
        "mission.interrupt",
        "mission.queue.list",
        "mission.queue.remove",
        "mission.queue.resume",
        "mission.queue.steer",
        "workspace.resolve",
        "board.shared.read",
      ],
    }),
    catalog: {
      listProjects: async () => await projectCatalog.listProjects(),
      getProjectRevision: async (projectId, revision) =>
        await projectCatalog.getProjectRevision(projectId, revision),
      listExecutors: async () =>
        await [
          ...(await listLocalHostBuiltInExecutorDescriptors({ runtimes: runtimeResolver })),
          ...(await projectCatalog.listExecutors()),
        ],
    },
    missions: {
      get: async (missionId) => await readMissionSnapshot(missionController, missionId),
      list: async () =>
        await listMissionSnapshots(missionController, join(pragmaHome, "data", "missions")),
    },
    workspace: {
      stat: async (path) => await stat(path),
      access: async (path, mode) => await access(path, mode === "read" ? 4 : 2),
      realpath: async (path) => await realpath(path),
    },
    board: {
      list: async ({ missionId }) =>
        await readProductionSharedBoardList(missionController, pragmaHome, missionId),
      read: async ({ missionId, id, start, maxBytes }) =>
        await readProductionSharedBoardItem(
          missionController,
          pragmaHome,
          missionId,
          id,
          start,
          maxBytes,
        ),
      search: async ({ missionId, query, maxResults, contextLines, caseSensitive }) =>
        await searchProductionSharedBoard(
          missionController,
          pragmaHome,
          missionId,
          query,
          maxResults,
          contextLines,
          caseSensitive,
        ),
    },
    queue: { list: async (missionId) => await promptQueueProjection.list(missionId) },
    watch: missionWatch,
    missionControl: {
      resume: async (input) => {
        // Run the proof step for every resume.  For a historical project
        // Mission this requires the caller's exact project/revision; for a
        // built-in Mission the authoritative built-in resolver can establish
        // the same binding without project arguments.  In both cases the
        // check happens before reserving the durable operation, so an
        // unprovable M7 Mission cannot be modified merely by attempting
        // resume.
        await backfillMissionPinnedBinding(
          {
            controller: missionController,
            catalog: projectCatalog,
            builtInResolver: async ({ ref, workspace }) =>
              await resolveBuiltInExecutor({ ref, workspace }),
            sessions: expertSessionStore,
            executions: executionStore,
          },
          input,
        );
        await coreControl.assertAcquisitionAllowed(input.missionId);
        const requestId = input.requestId ?? globalThis.crypto.randomUUID();
        const payloadHash = hashMissionResumePayload({
          missionId: input.missionId,
          ...(input.project === undefined ? {} : { project: input.project }),
          ...(input.expectedFingerprint === undefined
            ? {}
            : { expectedFingerprint: input.expectedFingerprint }),
        });
        const reserved = await missionControl.reserveOperation({
          missionId: input.missionId,
          requestId,
          payloadHash,
          kind: "resume",
        });
        if (reserved.operation.state === "applied") {
          return reserved.operation.result ?? { missionId: input.missionId, status: "resumed" };
        }
        if (reserved.operation.state === "rejected" || reserved.operation.state === "failed") {
          throw resumeOperationError(reserved.operation.error, input.missionId);
        }
        const snapshot = await missionController.readSnapshot({ missionId: input.missionId });
        if (
          snapshot.snapshot.lease !== undefined &&
          Date.parse(snapshot.snapshot.lease.expiresAt) > Date.now()
        ) {
          const error = createIntegrationError({
            code: "MISSION_LEASE_HELD",
            category: "conflict",
            message: "Mission already has a live owner.",
            details: { missionId: input.missionId },
          });
          await missionControl.completeOperation({
            missionId: input.missionId,
            requestId,
            payloadHash,
            state: "rejected",
            error,
          });
          throw error;
        }
        let acquired = false;
        let recovered = false;
        let operationCompleted = false;
        try {
          const owner = await missionControl.startOwner(input.missionId);
          if (owner === "live") {
            const error = createIntegrationError({
              code: "MISSION_LEASE_HELD",
              category: "conflict",
              message: "Mission already has a live owner.",
              details: { missionId: input.missionId },
            });
            await missionControl.completeOperation({
              missionId: input.missionId,
              requestId,
              payloadHash,
              state: "rejected",
              error,
            });
            operationCompleted = true;
            throw error;
          }
          acquired = true;
          await coreControl.recoverMission(input.missionId);
          recovered = true;
          const base = {
            missionId: input.missionId,
            status: input.detach ? "accepted" : "resumed",
          } as const;
          let result: Record<string, unknown> = base;
          if (!input.detach) {
            const executionId = await coreControl.resolveExecutionTarget({
              missionId: input.missionId,
            });
            if (executionId !== undefined) {
              const execution = await waitForResumedExecution({
                missionId: input.missionId,
                executionId,
                control: missionControl,
                onHumanInteraction: input.onHumanInteraction,
              });
              if (execution.status === "failed") {
                throw (
                  execution.error ??
                  createIntegrationError({
                    code: "EXECUTION_FAILED",
                    category: "execution",
                    retryable: false,
                    message: "The resumed Mission execution failed.",
                  })
                );
              }
              result = {
                ...base,
                ...(execution.status === "waiting" ? { status: "input_required" as const } : {}),
                execution,
              };
            }
          }
          const operation = await missionControl.completeOperation({
            missionId: input.missionId,
            requestId,
            payloadHash,
            state: "applied",
            result,
            guard: ownerScope.currentGuard(input.missionId),
          });
          operationCompleted = true;
          const completed = { ...result, operation };
          if (!input.detach) {
            await releaseRecoveredOwner({
              missionId: input.missionId,
              coreControl,
              ownerScope,
            });
          }
          return completed;
        } catch (error) {
          const parsedError = IntegrationErrorSchema.safeParse(error);
          const integrationError = parsedError.success
            ? parsedError.data
            : createIntegrationError({
                code: "COMMAND_REJECTED",
                category: "conflict",
                message: error instanceof Error ? error.message : "Mission resume failed.",
              });
          if (!operationCompleted) {
            await missionControl
              .completeOperation({
                missionId: input.missionId,
                requestId,
                payloadHash,
                state: "rejected",
                error: integrationError,
                guard: ownerScope.currentGuard(input.missionId),
              })
              .catch(() => undefined);
          }
          if (acquired && recovered) {
            await releaseRecoveredOwner({
              missionId: input.missionId,
              coreControl,
              ownerScope,
            }).catch(() => undefined);
          } else if (acquired) {
            await coreControl.release(input.missionId).catch(() => undefined);
            await ownerScope.release(input.missionId).catch(() => undefined);
          }
          throw error;
        }
      },
      commands: missionControl,
    },
    runtime: { resolver: runtimeResolver },
    run,
  });
  return application;
}

function resumeOperationError(error: Record<string, unknown> | undefined, missionId: string) {
  const parsed = IntegrationErrorSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Mission resume was rejected: " + missionId + ".",
      });
}

async function waitForResumedExecution(options: {
  readonly missionId: string;
  readonly executionId: string;
  readonly control: ReturnType<typeof createMissionControlApplication>;
  readonly onHumanInteraction?: LocalHostMissionResumeRequest["onHumanInteraction"];
}): Promise<MissionControlExecutionOutcome> {
  for (;;) {
    const execution = await options.control.waitExecution!({
      missionId: options.missionId,
      executionId: options.executionId,
    });
    if (execution.status !== "waiting" || execution.interaction === undefined) return execution;
    const interaction = HumanInteractionRequestEnvelopeSchema.parse(execution.interaction);
    if (options.onHumanInteraction === undefined) return execution;
    const decision = await options.onHumanInteraction(interaction);
    if (decision.kind === "checkpoint") return execution;
    const responseRequestId = globalThis.crypto.randomUUID();
    await options.control.submit({
      missionId: options.missionId,
      requestId: responseRequestId,
      kind: "respond",
      payload: { kind: "respond", response: decision.response },
      target: { interactionId: interaction.interactionId },
    });
    const responseOperation = await options.control.wait({
      missionId: options.missionId,
      requestId: responseRequestId,
    });
    assertAppliedOperation(responseOperation, options.missionId);
  }
}

function assertAppliedOperation(
  operation: { readonly state: string; readonly error?: Record<string, unknown> },
  missionId: string,
): void {
  if (operation.state === "applied") return;
  throw resumeOperationError(operation.error, missionId);
}

async function releaseRecoveredOwner(options: {
  readonly missionId: string;
  readonly coreControl: ReturnType<typeof createLocalHostCoreMissionControlAdapter>;
  readonly ownerScope: ReturnType<typeof createMissionOwnerScope>;
}): Promise<void> {
  try {
    await options.coreControl.releaseAfterHumanCheckpoint(options.missionId);
  } catch (error) {
    // A recovered owner may have started a subsequent queued execution while
    // the requested execution was being observed. Keep that owner alive and
    // let its poller continue; the command outcome is already durable.
    if (!(error instanceof Error) || !error.message.includes("active execution")) throw error;
    return;
  }
  await options.ownerScope.release(options.missionId);
}

async function openProductionSharedBoardStore(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
) {
  let snapshot;
  try {
    snapshot = await controller.readSnapshot({ missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  if (!snapshot.events.some((event) => event.type === "mission.created")) {
    throw createIntegrationError({
      code: "MISSION_NOT_FOUND",
      category: "not_found",
      message: `Mission not found: ${missionId}.`,
      details: { missionId },
    });
  }
  let bindings;
  try {
    bindings = await createLocalHostMissionBoardBindings({ pragmaHome, missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  const shared = bindings.find((binding) => binding.namespace === LOCAL_HOST_SHARED_BOARD_STORE_ID);
  if (shared === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "The Local Host shared Mission Board is unavailable.",
    });
  }
  return shared.store;
}

async function readProductionSharedBoardList(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const result = await store.listContext({});
  return unwrapBoardContextResult(result).map((item) => ({
    ...item,
    namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
  }));
}

async function readProductionSharedBoardItem(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
  id: string,
  start: number,
  maxBytes: number,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const result = await store.readContext({ id, start, offset: maxBytes });
  return {
    ...unwrapBoardContextResult(result),
    namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
  };
}

async function searchProductionSharedBoard(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
  query: string,
  maxResults: number,
  contextLines: number,
  caseSensitive: boolean | undefined,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const [searchResult, listResult] = await Promise.all([
    store.searchContext({ query, maxResults, contextLines, caseSensitive }),
    store.listContext({}),
  ]);
  const summaries = unwrapBoardContextResult(listResult);
  const summariesById = new Map(
    summaries.map((item) => [item.id, { ...item, namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID }]),
  );
  return unwrapBoardContextResult(searchResult).map((match) => ({
    ...match,
    item: summariesById.get(match.id) ?? {
      id: match.id,
      namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
      metadata: { trigger: "manual" as const, priority: "normal" as const },
      revision: "unknown",
      sizeBytes: 0,
    },
  }));
}

function unwrapBoardContextResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): T {
  if (result.ok) return result.value;
  switch (result.error.code) {
    case "context_not_found":
      throw createIntegrationError({
        code: "BOARD_ITEM_NOT_FOUND",
        category: "not_found",
        message: "Mission Board item not found.",
      });
    case "permission_denied":
      throw createIntegrationError({
        code: "PERMISSION_DENIED",
        category: "permission",
        message: "Private Mission Board namespaces are not readable.",
      });
    case "invalid_input":
    case "context_too_large":
    case "context_budget_exceeded":
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "The Mission Board request is invalid.",
      });
    case "store_unavailable":
      throw createIntegrationError({
        code: "DEPENDENCY_UNAVAILABLE",
        category: "dependency",
        message: "The Mission Board storage is unavailable.",
      });
    case "store_error":
    default:
      throw createIntegrationError({
        code: "STORAGE_CORRUPTED",
        category: "protocol",
        message: "The Mission Board storage is corrupted.",
      });
  }
}

function rethrowBoardStorageError(error: unknown): never {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success) throw parsed.data;
  throw createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message: "The Mission Board storage is corrupted.",
  });
}

function hasPromptAttachments(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

async function readMissionSnapshot(
  controller: ReturnType<typeof createMissionControllerStore>,
  missionId: string,
): Promise<unknown> {
  return await controller.readSnapshot({ missionId });
}

/**
 * The CLI has no dependency on Desktop's MissionStore. Its production list
 * projection therefore reads only the Local Host event index and never
 * opens every Core/Runtime resource. Backfill and resume remain target-only
 * operations; this is the ordinary read-only `mission list` projection.
 */
async function listMissionSnapshots(
  controller: ReturnType<typeof createMissionControllerStore>,
  missionsPath: string,
): Promise<readonly Record<string, unknown>[]> {
  let directories;
  try {
    directories = await readdir(missionsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const snapshots: Array<Record<string, unknown> | undefined> = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const snapshot = await controller.readSnapshot({ missionId: entry.name });
        const created = snapshot.events.find((event) => event.type === "mission.created");
        if (created === undefined) return undefined;
        const latest = snapshot.events.at(-1);
        const status = missionStatus(snapshot.events.map((event) => event.type));
        const executor = created.data["executor"];
        return {
          id: entry.name,
          missionId: entry.name,
          title: entry.name,
          ...(executor === undefined ? {} : { executor }),
          ...(created.data["workspace"] === undefined
            ? {}
            : { workspace: { canonicalPath: created.data["workspace"] } }),
          status,
          lifecycleStatus: ["succeeded", "failed", "cancelled"].includes(status)
            ? "completed"
            : status === "queued"
              ? "queued"
              : "active",
          execution: executionSummary(snapshot.events),
          createdAt: created.occurredAt,
          updatedAt: latest?.occurredAt ?? created.occurredAt,
          eventSequence: snapshot.snapshot.eventSequence,
          cursor: snapshot.cursor,
        };
      }),
  );
  const listed = snapshots.filter(
    (snapshot): snapshot is Record<string, unknown> => snapshot !== undefined,
  );
  return listed.toSorted((left, right) =>
    String(right["updatedAt"]).localeCompare(String(left["updatedAt"])),
  );
}

function missionStatus(
  eventTypes: readonly string[],
): "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" {
  for (const type of eventTypes.toReversed()) {
    switch (type) {
      case "run.succeeded":
        return "succeeded";
      case "run.failed":
        return "failed";
      case "run.interrupted":
        return "cancelled";
      case "run.input_required":
      case "human.requested":
      case "human.interaction.requested":
        return "waiting";
      case "run.started":
      case "execution.started":
        return "running";
      case "run.accepted":
        return "queued";
    }
  }
  return "queued";
}

function executionSummary(
  events: readonly { readonly type: string; readonly data: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  const started = events.toReversed().find((event) => event.type === "run.started");
  if (started === undefined) return undefined;
  const executionId = started.data["executionId"];
  const status = missionStatus(events.map((event) => event.type));
  return {
    ...(typeof executionId === "string" ? { id: executionId } : {}),
    status: status === "cancelled" ? "interrupted" : status,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
