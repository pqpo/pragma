import type {
  ExpertDefinition,
  ExpertSession,
  ExpertSessionStore,
  ExpertTurn,
  ExecutionStore,
  ExecutionView,
  FlowExecution,
  PragmaApp,
} from "@pragma/core";
import { StoredExecutionView } from "@pragma/core";
import { createIntegrationError } from "@pragma/shared/integration";
import {
  beginLocalHostMissionPromptAdmission,
  type LocalHostMissionPromptAdmissionHook,
} from "./prompt-admission.ts";
import { openLocalHostFlowExecution, releaseLocalHostFlowExecution } from "./flow-lifecycle.ts";
import { openLocalHostExpertSession, releaseLocalHostExpertSession } from "./session-lifecycle.ts";
import { shouldCreateSuccessorExpertSession } from "./mission-session-upgrade.ts";
import type { MissionExecutionOwnerAccess } from "./execution-owner.ts";

type ExpertApplication = PragmaApp["experts"];
type FlowApplication = PragmaApp["flows"];

/** In-memory execution facts. This is never serialized as a Mission envelope. */
export interface MissionExecutionSubject {
  readonly missionId: string;
  readonly intent?: "start" | "recover" | "continue" | "read" | undefined;
  readonly priorExecution?:
    | {
        readonly id: string;
        readonly status: string;
        readonly sessionId?: string | undefined;
      }
    | undefined;
  readonly sessionId?: string | undefined;
  readonly request: {
    readonly requestId: string;
    readonly prompt?: string | undefined;
    readonly input?: unknown;
    readonly attachments?: Parameters<ExpertSession["prompt"]>[1] extends infer T
      ? NonNullable<T> extends { attachments?: infer A }
        ? A
        : never
      : never;
  };
}

/** Resource mappings contain Core parameters, never a lifecycle callback. */
export type MissionExecutionResources =
  | {
      readonly kind: "session";
      readonly app: PragmaApp;
      readonly definition: ExpertDefinition;
      readonly existingSession?: ExpertSession | undefined;
      readonly createOptions?: Parameters<ExpertApplication["createSession"]>[1] | undefined;
      readonly resumeOptions?:
        | Omit<NonNullable<Parameters<ExpertApplication["resumeSession"]>[1]>, "sessionId">
        | undefined;
      readonly successorOnMismatch?: boolean | undefined;
    }
  | {
      readonly kind: "flow";
      readonly app: PragmaApp;
      readonly definition: Parameters<FlowApplication["start"]>[0];
      readonly startOptions?:
        Omit<NonNullable<Parameters<FlowApplication["start"]>[1]>, "input"> | undefined;
      readonly recoverOptions?:
        Omit<NonNullable<Parameters<FlowApplication["recover"]>[1]>, "executionId"> | undefined;
    };

export type MissionNativeOwner =
  | { readonly kind: "session"; readonly session: ExpertSession }
  | { readonly kind: "flow"; readonly execution: FlowExecution };
export interface MissionExecutionRecoveryResources {
  readonly subject: MissionExecutionSubject;
  readonly resources: MissionExecutionResources;
  readonly projectOwner?: ((owner: MissionNativeOwner) => Promise<void>) | undefined;
}
export type MissionNativeReleaseOwner =
  | { readonly kind: "session"; readonly session: ExpertSession }
  | {
      readonly kind: "flow";
      readonly execution: Parameters<typeof releaseLocalHostFlowExecution>[0] & {
        readonly executionId: string;
        readonly checkpointWaitingHuman?: (() => Promise<void>) | undefined;
      };
    };

const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled", "interrupted"].includes(status);

export function createMissionExecutionKernel(options: {
  readonly executions: ExecutionStore;
  readonly sessions: ExpertSessionStore;
  readonly owners: MissionExecutionOwnerAccess;
}) {
  const interruptSupersededSession = async (subject: MissionExecutionSubject): Promise<void> => {
    const sessionId = subject.priorExecution?.sessionId ?? subject.sessionId;
    if (
      sessionId === undefined ||
      (subject.priorExecution !== undefined && terminal(subject.priorExecution.status))
    )
      return;
    const state = await options.sessions.get(sessionId);
    const executionId = subject.priorExecution?.id ?? state?.activeExecutionId;
    if (state === undefined || executionId === undefined) return;
    const execution = await options.executions.get(executionId);
    const now = new Date().toISOString();
    if (execution !== undefined && !terminal(execution.status)) {
      const invocations = await options.executions.listInvocations(executionId);
      await options.executions.commit({
        commitId: crypto.randomUUID(),
        executionId,
        executionPatch: { status: "interrupted" },
        invocationPatches: invocations
          .filter((invocation) => !terminal(invocation.status))
          .map((invocation) => ({
            invocationId: invocation.invocationId,
            patch: { status: "interrupted", updatedAt: now },
          })),
      });
    }
    await options.sessions.transact(sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        activeExecutionId:
          session.activeExecutionId === executionId ? undefined : session.activeExecutionId,
        lastStatus: "interrupted",
        updatedAt: now,
        queuedRequestIds: session.queuedRequestIds.filter(
          (requestId) =>
            !prompts.some(
              (prompt) => prompt.requestId === requestId && prompt.executionId === executionId,
            ),
        ),
      },
      prompts: prompts.map((prompt) =>
        prompt.executionId === executionId &&
        (prompt.status === "queued" || prompt.status === "running")
          ? { ...prompt, status: "interrupted" as const, updatedAt: now }
          : prompt,
      ),
    }));
  };
  const openSession = async (
    subject: MissionExecutionSubject,
    resources: Extract<MissionExecutionResources, { kind: "session" }>,
  ): Promise<ExpertSession> => {
    if (resources.existingSession !== undefined) return resources.existingSession;
    const priorSessionId =
      subject.intent === "start" &&
      subject.priorExecution !== undefined &&
      terminal(subject.priorExecution.status)
        ? undefined
        : subject.priorExecution?.sessionId;
    const sessionId = priorSessionId ?? subject.sessionId;
    if (sessionId === undefined && subject.intent === "recover")
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: `Session association is missing: ${subject.missionId}`,
        details: { missionId: subject.missionId, reason: "session_not_found" },
      });
    const record = sessionId === undefined ? undefined : await options.sessions.get(sessionId);
    if (
      sessionId !== undefined &&
      record === undefined &&
      (subject.intent === "recover" || subject.priorExecution?.sessionId !== undefined)
    )
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: `Session not found: ${sessionId}`,
        details: { missionId: subject.missionId, reason: "session_not_found" },
      });
    const create = async () =>
      await openLocalHostExpertSession(resources.app, resources.definition, {
        kind: "create",
        options: resources.createOptions,
      });
    if (record === undefined || sessionId === undefined) return await create();
    const resume = { ...resources.resumeOptions, sessionId };
    try {
      return record.status === "closed"
        ? await openLocalHostExpertSession(resources.app, resources.definition, {
            kind: "recover-closed",
            options: {
              ...resume,
              reason: `Mission ${subject.missionId} still owns this ExpertSession.`,
            },
          })
        : await openLocalHostExpertSession(resources.app, resources.definition, {
            kind: "resume",
            options: resume,
          });
    } catch (error) {
      if (resources.successorOnMismatch !== true || !shouldCreateSuccessorExpertSession(error))
        throw error;
      const successor = await create();
      try {
        await interruptSupersededSession({ ...subject, sessionId });
      } catch (retirementError) {
        try {
          await successor.close(
            "Successor Mission Session could not retire its previous execution.",
          );
          await options.sessions.delete(successor.sessionId);
        } catch (cleanupError) {
          throw new AggregateError(
            [retirementError, cleanupError],
            "Mission successor retirement failed.",
            { cause: cleanupError },
          );
        }
        throw retirementError;
      }
      return successor;
    }
  };
  const openOwner = async (
    subject: MissionExecutionSubject,
    resources: MissionExecutionResources,
  ): Promise<MissionNativeOwner> => {
    if (resources.kind === "session")
      return { kind: "session", session: await openSession(subject, resources) };
    const prior = subject.priorExecution;
    if (prior === undefined && (subject.intent === "recover" || subject.intent === "read"))
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: `Execution association is missing: ${subject.missionId}`,
        details: { missionId: subject.missionId, reason: "execution_not_found" },
      });
    const recovering =
      prior !== undefined &&
      (subject.intent === "recover" ||
        subject.intent === "read" ||
        ["queued", "running", "waiting"].includes(prior.status));
    if (prior !== undefined && recovering) {
      if ((await options.executions.get(prior.id)) === undefined)
        throw createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message: `Execution not found: ${prior.id}`,
          details: { missionId: subject.missionId, reason: "execution_not_found" },
        });
      return {
        kind: "flow",
        execution: await openLocalHostFlowExecution(resources.app, resources.definition, {
          kind: "recover",
          options: { ...resources.recoverOptions, executionId: prior.id },
        }),
      };
    }
    return {
      kind: "flow",
      execution: await openLocalHostFlowExecution(resources.app, resources.definition, {
        kind: "start",
        options: {
          ...resources.startOptions,
          input: subject.request.input === undefined ? {} : subject.request.input,
        },
      }),
    };
  };
  const assertSuccessorReady = async (
    subject: MissionExecutionSubject,
    session?: ExpertSession,
  ): Promise<void> => {
    const sessionId = session?.sessionId ?? subject.priorExecution?.sessionId ?? subject.sessionId;
    if (sessionId === undefined) return;
    const [state, prompts] =
      session === undefined
        ? await Promise.all([
            options.sessions.get(sessionId!),
            options.sessions.listPrompts(sessionId!),
          ])
        : await Promise.all([session.getState(), session.getPromptQueue()]);
    if (
      state?.activeExecutionId !== undefined ||
      state?.lastStatus === "waiting" ||
      prompts.some((prompt) => prompt.status === "running" || prompt.status === "queued")
    )
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message:
          "Finish or remove pending Mission messages before changing the execution environment.",
        details: {
          missionId: subject.missionId,
          reason: "execution_environment_changed_pending_prompts",
        },
      });
  };
  const openPromptSession = async (
    subject: MissionExecutionSubject,
    resources: Extract<MissionExecutionResources, { kind: "session" }>,
    successor: boolean,
  ): Promise<ExpertSession> =>
    await openSession(
      successor
        ? {
            missionId: subject.missionId,
            intent: "start",
            request: subject.request,
          }
        : subject,
      successor ? { ...resources, existingSession: undefined } : resources,
    );
  const preparePromptSession = async (input: {
    readonly subject: MissionExecutionSubject;
    readonly resources?: Extract<MissionExecutionResources, { kind: "session" }> | undefined;
    readonly session?: ExpertSession | undefined;
    readonly definitionChanged: boolean;
    readonly contextStoresChanged: boolean;
    readonly hasActive: boolean;
    readonly previousEnvironmentAvailable?: boolean | undefined;
  }): Promise<{ readonly session: ExpertSession; readonly replaced: boolean }> => {
    const successor = input.definitionChanged || (input.contextStoresChanged && !input.hasActive);
    if (input.definitionChanged && input.previousEnvironmentAvailable === false)
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The previous Session environment cannot authorize a successor.",
        details: {
          missionId: input.subject.missionId,
          reason: "executor_environment_changed_requires_successor",
        },
      });
    if (!successor && input.session !== undefined)
      return { session: input.session, replaced: false };
    if (input.resources === undefined)
      throw new Error(`Mission Session resources are missing: ${input.subject.missionId}`);
    if (successor) await assertSuccessorReady(input.subject, input.session);
    const session = await openPromptSession(input.subject, input.resources, successor);
    if (successor && input.session !== undefined && session !== input.session) {
      try {
        await input.session.close(
          input.definitionChanged
            ? "Mission executor environment changed."
            : "Mission context bindings changed.",
        );
      } catch (error) {
        // The new Session is still unlinked. Remove it only after native stop
        // has completed; the original owner remains installed on failure.
        try {
          await session.close("Successor Mission Session could not replace its owner.");
          await options.sessions.delete(session.sessionId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Mission successor cleanup failed.", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    }
    return { session, replaced: input.session !== undefined && session !== input.session };
  };
  const start = async (
    subject: MissionExecutionSubject,
    resources: MissionExecutionResources,
  ): Promise<
    | {
        readonly kind: "native";
        readonly owner: MissionNativeOwner;
        readonly handle: ExpertTurn | FlowExecution;
        readonly acceptance: "new" | "recovered" | "receipt";
      }
    | { readonly kind: "receipt"; readonly acceptance: "receipt"; readonly view: ExecutionView }
  > => {
    let receiptExecutionId: string | undefined;
    if (
      resources.kind === "flow" &&
      subject.priorExecution !== undefined &&
      (subject.intent === "recover" ||
        subject.intent === "read" ||
        ["queued", "running", "waiting"].includes(subject.priorExecution.status))
    )
      receiptExecutionId = subject.priorExecution.id;
    if (resources.kind === "session") {
      const sessionId =
        resources.existingSession?.sessionId ??
        subject.priorExecution?.sessionId ??
        subject.sessionId;
      const prompts =
        resources.existingSession !== undefined
          ? await resources.existingSession.getPromptQueue()
          : sessionId === undefined || (await options.sessions.get(sessionId)) === undefined
            ? []
            : await options.sessions.listPrompts(sessionId);
      receiptExecutionId = prompts.find(
        (prompt) => prompt.requestId === subject.request.requestId,
      )?.executionId;
    }
    if (receiptExecutionId !== undefined) {
      const record = await options.executions.get(receiptExecutionId);
      if (record !== undefined && terminal(record.status))
        return {
          kind: "receipt",
          acceptance: "receipt",
          view:
            resources.kind === "flow"
              ? await resources.app.flows.open({ executionId: receiptExecutionId })
              : new StoredExecutionView(receiptExecutionId, options.executions),
        };
    }
    const owner = await openOwner(subject, resources);
    if (owner.kind === "flow")
      return {
        kind: "native",
        owner,
        handle: owner.execution,
        acceptance: subject.priorExecution === undefined ? "new" : "recovered",
      };
    const prior = subject.priorExecution;
    const prompts = await owner.session.getPromptQueue();
    if (prior !== undefined && ["queued", "running", "waiting"].includes(prior.status)) {
      const queued = prompts.find(
        (prompt) =>
          prompt.executionId === prior.id &&
          prompt.mode === "enqueue" &&
          prompt.status === "queued",
      );
      if (queued !== undefined) {
        const handle = (await owner.session.listTurns()).find(
          (turn) => turn.executionId === prior.id,
        );
        if (handle === undefined) throw new Error(`Recoverable Expert turn not found: ${prior.id}`);
        return { kind: "native", owner, handle, acceptance: "recovered" };
      }
    }
    const handle = await owner.session.prompt(
      subject.request.prompt ?? JSON.stringify(subject.request.input ?? null),
      {
        requestId: subject.request.requestId,
        ...(subject.request.attachments === undefined
          ? {}
          : { attachments: subject.request.attachments }),
      },
    );
    return {
      kind: "native",
      owner,
      handle,
      acceptance: prompts.some((prompt) => prompt.requestId === subject.request.requestId)
        ? resources.kind === "session" && resources.existingSession === undefined
          ? "recovered"
          : "receipt"
        : "new",
    };
  };
  const admit = async <T>(
    subject: MissionExecutionSubject,
    hooks: MissionNativeAdmissionHooks & {
      readonly admissionOwned?: boolean | undefined;
    },
    operation: (admission: MissionNativeAdmission) => Promise<T>,
  ): Promise<T> => {
    const execute = async () => await withMissionNativeAdmission(subject, hooks, operation);
    return hooks.admissionOwned === true
      ? await execute()
      : await options.owners.admit(subject.missionId, execute);
  };
  const settlement = async (
    owner: MissionNativeReleaseOwner,
  ): Promise<{
    readonly ready: boolean;
    readonly boundary: "terminal" | "checkpoint";
    readonly executionIds: readonly string[];
  }> => {
    if (owner.kind === "session") {
      const [state, prompts] = await Promise.all([
        owner.session.getState(),
        owner.session.getPromptQueue(),
      ]);
      return {
        ready:
          state.activeExecutionId === undefined &&
          !prompts.some((prompt) => prompt.status === "running"),
        boundary:
          state.lastStatus === "waiting" || prompts.some((prompt) => prompt.status === "queued")
            ? "checkpoint"
            : "terminal",
        executionIds: state.executionIds,
      };
    }
    const state = await options.executions.get(owner.execution.executionId);
    const waiting =
      state !== undefined &&
      !terminal(state.status) &&
      (await options.executions.listInvocations(state.executionId)).some(
        (invocation) => invocation.status === "waiting" && invocation.waitReason === "human_input",
      );
    return {
      ready: state === undefined || terminal(state.status) || waiting,
      boundary: waiting ? "checkpoint" : "terminal",
      executionIds: [owner.execution.executionId],
    };
  };
  const idleReady = async (
    subject: MissionExecutionSubject,
    owner: MissionNativeReleaseOwner | undefined,
    timeoutMs: number,
  ): Promise<{ readonly ready: boolean; readonly executionId?: string | undefined }> => {
    const sessionId =
      owner?.kind === "session"
        ? owner.session.sessionId
        : (subject.priorExecution?.sessionId ?? subject.sessionId);
    if (owner?.kind === "session" || sessionId !== undefined) {
      const [state, prompts] =
        owner?.kind === "session"
          ? await Promise.all([owner.session.getState(), owner.session.getPromptQueue()])
          : await Promise.all([
              options.sessions.get(sessionId!),
              options.sessions.listPrompts(sessionId!),
            ]);
      if (state === undefined) return { ready: false };
      return {
        executionId: state.executionIds.at(-1),
        ready:
          state.activeExecutionId === undefined &&
          !["queued", "running", "waiting"].includes(state.lastStatus ?? "") &&
          !prompts.some((prompt) => prompt.status === "queued" || prompt.status === "running") &&
          Date.now() - Date.parse(state.updatedAt) >= timeoutMs,
      };
    }
    const executionId =
      owner?.kind === "flow" ? owner.execution.executionId : subject.priorExecution?.id;
    const execution =
      executionId === undefined ? undefined : await options.executions.get(executionId);
    return {
      executionId,
      ready:
        execution === undefined
          ? subject.priorExecution === undefined || terminal(subject.priorExecution.status)
          : terminal(execution.status) && Date.now() - Date.parse(execution.updatedAt) >= timeoutMs,
    };
  };
  const release = async (
    owner: MissionNativeReleaseOwner,
    boundary: "idle" | "terminal" | "checkpoint" | "control" = "idle",
  ) => {
    if (owner.kind === "session")
      await releaseLocalHostExpertSession(
        owner.session,
        boundary === "control" ? "terminal" : boundary,
      );
    else {
      const checkpointed =
        boundary === "checkpoint" ||
        (boundary === "control" && (await settlement(owner)).boundary === "checkpoint");
      if (checkpointed && !terminal((await owner.execution.getState()).status)) {
        if (owner.execution.checkpointWaitingHuman === undefined)
          throw new Error("Recovered waiting Flow has no checkpoint release boundary.");
        await owner.execution.checkpointWaitingHuman();
      }
      await releaseLocalHostFlowExecution(owner.execution);
    }
  };
  const receiptStatus = async (executionId: string): Promise<string | undefined> =>
    (await options.executions.get(executionId))?.status;
  return {
    openOwner,
    openSession,
    openPromptSession,
    preparePromptSession,
    assertSuccessorReady,
    start,
    admit,
    settlement,
    idleReady,
    interruptSupersededSession,
    release,
    receiptStatus,
  };
}

export interface MissionNativeAdmission {
  accepted(executionId: string): void;
}
export interface MissionNativeAdmissionHooks {
  readonly onPromptAdmitting?: LocalHostMissionPromptAdmissionHook | undefined;
  readonly onFailure?: ((error: unknown) => void) | undefined;
}
/** Hold the resource generation from preparation until native acceptance or rollback. */
export async function withMissionNativeAdmission<T>(
  subject: MissionExecutionSubject,
  hooks: MissionNativeAdmissionHooks,
  operation: (admission: MissionNativeAdmission) => Promise<T>,
): Promise<T> {
  let accepted = false;
  const rollback = await beginLocalHostMissionPromptAdmission(
    hooks.onPromptAdmitting,
    subject.missionId,
    subject.request.requestId,
    hooks.onFailure ?? (() => undefined),
  );
  try {
    const result = await operation({
      accepted: () => {
        accepted = true;
      },
    });
    if (!accepted) await rollback?.();
    return result;
  } catch (error) {
    if (!accepted) await rollback?.();
    throw error;
  }
}
