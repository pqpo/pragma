import { SteerNotDispatchedError } from "@pragma/core";
import type { ExpertSession, ExpertTurn, RuntimeModelSelection } from "@pragma/core";
import { MissionSemanticWritePendingError } from "./missions/controller/mission-controller-store.ts";
import { createIntegrationError } from "@pragma/shared/integration";
import type { ExpertPromptAttachment } from "@pragma/shared";

export type LocalHostMissionPromptAdmissionHook = (
  missionId: string,
  requestId: string,
) => Promise<void | (() => Promise<void>)>;

/** Optional Memory admission must neither reject Core work nor mask its failure. */
export async function beginLocalHostMissionPromptAdmission(
  hook: LocalHostMissionPromptAdmissionHook | undefined,
  missionId: string,
  requestId: string,
  onError?: ((error: unknown) => void) | undefined,
): Promise<(() => Promise<void>) | undefined> {
  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      /* Diagnostic failures do not change prompt admission. */
    }
  };
  try {
    const rollback = await hook?.(missionId, requestId);
    if (rollback === undefined) return undefined;
    return async () => {
      try {
        await rollback();
      } catch (error) {
        report(error);
      }
    };
  } catch (error) {
    report(error);
    return undefined;
  }
}

const missionAdmissionFactory = Symbol("local-host.mission-command-admission");

export interface LocalHostMissionCommandAdmission<Result> {
  (input: MissionMessageAdmissionInput): Promise<Result>;
  readonly [missionAdmissionFactory]: true;
  mapResult<Next>(
    map: (result: Result) => Next | Promise<Next>,
  ): LocalHostMissionCommandAdmission<Next>;
}

function bindAdmission<Result>(
  accept: (input: MissionMessageAdmissionInput) => Promise<Result>,
): LocalHostMissionCommandAdmission<Result> {
  return Object.assign(accept, {
    [missionAdmissionFactory]: true as const,
    mapResult<Next>(map: (result: Result) => Next | Promise<Next>) {
      return bindAdmission(async (input) => {
        const accepted = await accept(input);
        try {
          return await map(accepted);
        } catch (error: unknown) {
          throw error instanceof MissionSemanticWritePendingError
            ? error
            : new MissionSemanticWritePendingError({ cause: error });
        }
      });
    },
  });
}

export interface MissionMessageAdmissionInput {
  readonly id: string;
  readonly content: string;
  readonly requestId: string;
  readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
  readonly mode?: "enqueue" | "steer" | undefined;
  readonly requestedAt?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly target?:
    { readonly executionId?: string | undefined; readonly turnId?: string | undefined } | undefined;
}

export interface MissionMessageAdmissionMission {
  readonly id: string;
  readonly lifecycleStatus: string;
  readonly executor: { readonly kind: string };
  readonly execution?: unknown;
  readonly branch?: unknown;
}

/** R1 preparation boundary. Compilation and Session construction move in R2/R3. */
export interface PreparedMissionMessage {
  readonly session?: ExpertSession | undefined;
  readonly definitionChanged: boolean;
  readonly contextStoresChanged: boolean;
  readonly promptModelSelection?: RuntimeModelSelection | undefined;
  readonly createSession: (successor: boolean) => Promise<ExpertSession>;
  readonly rememberSession: (session: ExpertSession) => void;
}

/**
 * Owns chat command admission, successor fencing and Core acceptance. Host ports
 * retain compilation and timeline/observer projection until their scheduled stages.
 * In particular, no Host port accepts a MissionCommand or sends a prompt.
 */
export function createLocalHostMissionCommandAdmission<
  Mission extends MissionMessageAdmissionMission,
  Prepared extends PreparedMissionMessage,
  Result,
  PreparationScope = undefined,
>(options: {
  readonly onPromptAdmitting?: LocalHostMissionPromptAdmissionHook | undefined;
  readonly onPromptAdmissionError?: ((error: unknown) => void) | undefined;
  readonly onAccepted?: ((input: MissionMessageAdmissionInput) => void) | undefined;
  readonly onPhase?:
    | ((input: {
        readonly missionId: string;
        readonly requestId: string;
        readonly phase: string;
        readonly startedAt: number;
        readonly acceptedAt: number;
        readonly cacheHit?: boolean;
      }) => void)
    | undefined;
  readonly getMission: (id: string) => Promise<Mission>;
  readonly admit: <T>(id: string, operation: () => Promise<T>, requestId: string) => Promise<T>;
  readonly withController: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
  readonly settleTerminal: (mission: Mission) => Promise<boolean>;
  readonly contextBindingsChanging: (id: string) => boolean;
  readonly successorRequired: (mission: Mission) => boolean;
  readonly hasActive: (id: string) => boolean;
  readonly session: (id: string) => ExpertSession | undefined;
  readonly createPreparationScope?: ((mission: Mission) => PreparationScope) | undefined;
  readonly assertReady: (mission: Mission, scope: PreparationScope | undefined) => Promise<void>;
  readonly startInitialRun: (mission: Mission) => Promise<unknown>;
  readonly prepare: (
    mission: Mission,
    input: MissionMessageAdmissionInput,
    acceptedAt: number,
    scope: PreparationScope | undefined,
  ) => Promise<Prepared>;
  readonly forgetSession: (id: string) => void;
  readonly projectAccepted: (input: {
    readonly mission: Mission;
    readonly prepared: Prepared;
    readonly turn: ExpertTurn;
    readonly requestedMode: "enqueue" | "steer";
    readonly input: MissionMessageAdmissionInput & { readonly requestedAt: string };
    readonly acceptedAt: number;
  }) => Promise<Result>;
}): LocalHostMissionCommandAdmission<Result> {
  return bindAdmission(
    async (input: MissionMessageAdmissionInput): Promise<Result> =>
      await options.admit(
        input.id,
        async () =>
          await options.withController(input.id, async () => {
            const initialReadAt = performance.now();
            let mission = await options.getMission(input.id);
            if (
              input.mode !== "steer" &&
              mission.lifecycleStatus === "active" &&
              mission.executor.kind !== "flow" &&
              mission.execution === undefined &&
              mission.branch === undefined
            ) {
              await options.startInitialRun(mission);
              mission = await options.getMission(input.id);
            }
            const acceptedAt = performance.now();
            const phase = (name: string, startedAt: number, cacheHit?: boolean) =>
              options.onPhase?.({
                missionId: input.id,
                requestId: input.requestId,
                phase: name,
                startedAt,
                acceptedAt,
                ...(cacheHit === undefined ? {} : { cacheHit }),
              });
            options.onAccepted?.(input);
            phase("mission_read_initial", initialReadAt);
            if (await options.settleTerminal(mission)) {
              const startedAt = performance.now();
              mission = await options.getMission(input.id);
              phase("mission_read_after_settlement", startedAt);
            }
            if (options.contextBindingsChanging(mission.id)) {
              throw new Error(
                "Wait for the Mission Knowledge change to finish before sending a message.",
              );
            }
            if (options.successorRequired(mission)) {
              if (options.hasActive(mission.id)) {
                throw new Error(
                  "Wait for the current execution to finish before sending a message with the new Mission Knowledge.",
                );
              }
              const prompts = await options.session(mission.id)?.getPromptQueue();
              if (
                prompts?.some((prompt) => prompt.status === "queued" || prompt.status === "running")
              ) {
                throw new Error(
                  "Remove or finish queued Mission messages before continuing with the new Mission Knowledge.",
                );
              }
            }
            const preparationScope = options.createPreparationScope?.(mission);
            const readinessStartedAt = performance.now();
            await options.assertReady(mission, preparationScope);
            phase("executor_readiness", readinessStartedAt);
            if (mission.executor.kind === "flow") {
              throw new Error(
                "Flow missions accept input through workflow steps, not chat messages.",
              );
            }
            if (mission.lifecycleStatus !== "active") {
              throw new Error("Reopen this mission before sending another message.");
            }
            const prepared = await options.prepare(mission, input, acceptedAt, preparationScope);
            const sessionOpenStartedAt = performance.now();
            let session = prepared.session;
            if (prepared.definitionChanged && session !== undefined) {
              await session.close("Mission executor environment changed.");
              options.forgetSession(mission.id);
              session = undefined;
            }
            if (
              prepared.contextStoresChanged &&
              session !== undefined &&
              !options.hasActive(mission.id)
            ) {
              await session.close("Mission context bindings changed.");
              options.forgetSession(mission.id);
              session = undefined;
            }
            const sessionCacheHit = session !== undefined;
            session ??= await prepared.createSession(
              prepared.definitionChanged || prepared.contextStoresChanged,
            );
            prepared.rememberSession(session);
            phase("expert_session_open", sessionOpenStartedAt, sessionCacheHit);
            if (input.signal?.aborted)
              throw createIntegrationError({
                code: "COMMAND_RESULT_TIMEOUT",
                category: "conflict",
                message: "Mission command application was cancelled before Core acceptance.",
                details: { missionId: input.id, requestId: input.requestId },
              });
            const requestedMode = input.mode ?? "enqueue";
            if (requestedMode === "steer" && input.target !== undefined) {
              const prompts = await session.getPromptQueue();
              const duplicate = prompts.find(
                (prompt) =>
                  prompt.requestId === input.requestId &&
                  prompt.mode === "steer" &&
                  prompt.status === "succeeded" &&
                  prompt.deliveryAttempt?.state === "confirmed",
              );
              if (duplicate === undefined) {
                const state = await session.getState();
                const current = prompts.find(
                  (prompt) =>
                    prompt.executionId === state.activeExecutionId &&
                    prompt.mode === "enqueue" &&
                    prompt.status === "running",
                );
                if (
                  current === undefined ||
                  current.executionId !== input.target.executionId ||
                  current.requestId !== input.target.turnId
                ) {
                  throw createIntegrationError({
                    code: "STEER_TARGET_CHANGED",
                    category: "conflict",
                    message: "Strict Mission steer target changed before Core acceptance.",
                    details: {
                      missionId: input.id,
                      ...(input.target.executionId === undefined
                        ? {}
                        : { expectedExecutionId: input.target.executionId }),
                      ...(input.target.turnId === undefined
                        ? {}
                        : { expectedTurnId: input.target.turnId }),
                      ...(current === undefined
                        ? {}
                        : { executionId: current.executionId, turnId: current.requestId }),
                    },
                  });
                }
              }
            }
            const rollbackPromptAdmission = await beginLocalHostMissionPromptAdmission(
              options.onPromptAdmitting,
              mission.id,
              input.requestId,
              options.onPromptAdmissionError,
            );
            const promptStartedAt = performance.now();
            const turn = await session
              .prompt(input.content, {
                requestId: input.requestId,
                mode: requestedMode,
                ...(input.target === undefined ||
                input.target.executionId === undefined ||
                input.target.turnId === undefined
                  ? {}
                  : {
                      target: {
                        executionId: input.target.executionId,
                        turnId: input.target.turnId,
                      },
                    }),
                ...(input.attachments === undefined || input.attachments.length === 0
                  ? {}
                  : { attachments: input.attachments }),
                ...(prepared.promptModelSelection === undefined
                  ? {}
                  : { modelSelection: prepared.promptModelSelection }),
              })
              .catch(async (error: unknown) => {
                await rollbackPromptAdmission?.();
                if (
                  requestedMode === "steer" &&
                  error instanceof SteerNotDispatchedError &&
                  error.reason === "target_changed"
                )
                  throw createIntegrationError({
                    code: "STEER_TARGET_CHANGED",
                    category: "conflict",
                    message: "Strict Mission steer target changed before native dispatch.",
                    details: { missionId: input.id },
                  });
                throw error;
              });
            phase("expert_session_prompt", promptStartedAt);
            return await options
              .projectAccepted({
                mission,
                prepared,
                turn,
                requestedMode,
                acceptedAt,
                input: { ...input, requestedAt: input.requestedAt ?? new Date().toISOString() },
              })
              .catch((error: unknown) => {
                throw error instanceof MissionSemanticWritePendingError
                  ? error
                  : new MissionSemanticWritePendingError({ cause: error });
              });
          }),
        input.requestId,
      ),
  );
}
