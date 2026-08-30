import { randomUUID } from "node:crypto";

import {
  AgentMessageUsageSchema,
  JsonValueSchema,
  type AgentMessageUsage,
  type WorkspaceSelection,
} from "@pragma/shared";
import { HumanInteractionRequestEnvelopeSchema } from "@pragma/shared/integration";
import type {
  ExecutorDescriptor,
  ExecutorReference,
  HumanInteractionRequestEnvelope,
  JsonValue,
} from "@pragma/shared/integration";
import {
  createIntegrationError,
  IntegrationErrorSchema,
  type IntegrationError,
} from "@pragma/shared/integration";

import type {
  MissionControllerGuard,
  MissionControllerStore,
} from "./missions/controller/mission-controller-store.ts";
import {
  createMissionPinnedBinding,
  createPinnedBindingRecoveryError,
  findMissionPinnedBinding,
  type MissionPinnedBinding,
} from "./missions/controller/pinned-binding.ts";
import {
  createMissionOwnerScope,
  type MissionOwnerScope,
} from "./missions/controller/owner-scope.ts";
import type { MissionCommandConsumer } from "./missions/controller/mission-controller-store.ts";
import { hashCanonicalRunPayload, type CanonicalRunPayloadInput } from "./run-payload.ts";
import { createRunRedactor, type RunRedactor } from "./redaction.ts";
import {
  createLocalHostMissionEventProjector,
  redactInteraction,
} from "./mission-event-projector.ts";

export interface LocalHostRunRequest extends Omit<CanonicalRunPayloadInput, "project"> {
  readonly requestId: string;
  readonly workspace: WorkspaceSelection;
  readonly project?:
    { readonly projectId: string; readonly revision?: number | undefined } | undefined;
  readonly expectedFingerprint?: string | undefined;
  readonly detach: boolean;
}

export interface ResolvedRunExecutor {
  readonly descriptor: ExecutorDescriptor;
}

export interface LocalHostRunEvent {
  readonly type: string;
  readonly data: JsonValue;
  /** Durable lower-level event identity, when supplied by Core. */
  readonly eventId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly replayable?: boolean | undefined;
  readonly cursor?: string | undefined;
}

export interface LocalHostRunTerminal {
  readonly status: "succeeded" | "input_required" | "failed" | "interrupted";
  readonly executionId: string;
  readonly result?: JsonValue | undefined;
  readonly interaction?: HumanInteractionRequestEnvelope | undefined;
  readonly usage?: AgentMessageUsage | undefined;
  readonly error?: IntegrationError | undefined;
}

export interface LocalHostRunHandle {
  readonly executionId: string;
  readonly events?: AsyncIterable<LocalHostRunEvent> | undefined;
  readonly result: Promise<LocalHostRunTerminal>;
  /** Release lower-level Runtime/Session resources after the terminal is durable. */
  readonly release?: (() => Promise<void>) | undefined;
  readonly cancel?: ((reason?: string) => Promise<void>) | undefined;
  readonly checkpointWaitingHuman?: (() => Promise<void>) | undefined;
  readonly respondToHumanInteraction?:
    ((interactionId: string, response: unknown, requestId: string) => Promise<void>) | undefined;
}

export interface LocalHostRunExecutorPort {
  readonly resolve: (input: {
    readonly ref: ExecutorReference;
    readonly projectId?: string | undefined;
    readonly revision?: number | undefined;
    readonly workspace: WorkspaceSelection;
  }) => Promise<ResolvedRunExecutor | undefined>;
  /** Validate semantic input before the Mission registry or aggregate is written. */
  readonly validateInput?: (input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
  }) => Promise<void | { readonly input: unknown }>;
  /**
   * Re-validate Host-owned immutable input after the Local Host lease is
   * claimed and before the first durable run event is appended.  A failure
   * leaves the idempotency reservation in place, but must not create Mission
   * events or start the lower-level executor.
   */
  readonly assertStartAllowed?: (input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly payloadHash: string;
  }) => Promise<void>;
  readonly start: (input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
  }) => Promise<LocalHostRunHandle>;
  readonly respond?:
    | ((input: {
        readonly missionId: string;
        readonly executionId: string;
        readonly interactionId: string;
        readonly response: unknown;
        readonly requestId: string;
      }) => Promise<void>)
    | undefined;
}

export interface LocalHostRunMissionPort {
  readonly controller: MissionControllerStore;
  readonly claim: (missionId: string, claimId: string) => Promise<MissionControllerGuard>;
  readonly append: (
    missionId: string,
    guard: MissionControllerGuard,
    type: string,
    data: Record<string, unknown>,
    eventId?: string | undefined,
  ) => Promise<{ readonly cursor: string }>;
  readonly ensurePinnedBinding: (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly binding: MissionPinnedBinding;
  }) => Promise<{ readonly disposition: "appended" | "existing" }>;
  readonly startPolling?: (input: {
    readonly missionId: string;
    readonly consumer: MissionCommandConsumer;
    readonly initialDelayMs?: number | undefined;
    readonly maxDelayMs?: number | undefined;
    readonly jitter?: (() => number) | undefined;
  }) => Promise<{ stop(): Promise<void> }>;
  readonly release: (missionId: string) => Promise<void>;
  readonly releaseAfterLowerLevel: (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly releaseLowerLevel: () => Promise<void>;
  }) => Promise<void>;
}

export interface LocalHostRunApplication {
  readonly start: (
    request: LocalHostRunRequest,
    options?: LocalHostRunPresentation,
  ) => Promise<LocalHostRunApplicationHandle>;
  /** Start a run for a Mission identity supplied by the Host composition. */
  readonly startAttached: (
    input: { readonly missionId: string; readonly request: LocalHostRunRequest },
    options?: LocalHostRunPresentation,
  ) => Promise<LocalHostRunApplicationHandle>;
  readonly respond: (input: {
    readonly missionId: string;
    readonly executionId: string;
    readonly interactionId: string;
    readonly response: unknown;
    readonly requestId: string;
  }) => Promise<void>;
}

export interface LocalHostRunPresentation {
  readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
  readonly onHumanInteraction?:
    | ((
        request: HumanInteractionRequestEnvelope,
      ) => Promise<
        { readonly kind: "respond"; readonly response: unknown } | { readonly kind: "checkpoint" }
      >)
    | undefined;
}

export interface LocalHostRunApplicationHandle {
  readonly request: LocalHostRunRequest;
  readonly missionId: string;
  readonly payloadHash: string;
  readonly disposition: "reserved" | "existing";
  readonly executionId?: string | undefined;
  readonly events?: AsyncIterable<LocalHostRunEvent> | undefined;
  readonly outcome: Promise<LocalHostRunApplicationOutcome>;
  readonly cancel: (reason?: string) => Promise<void>;
}

export type LocalHostRunApplicationOutcome =
  | {
      readonly status: "accepted";
      readonly missionId: string;
      readonly executionId?: string | undefined;
      readonly executor: ExecutorReference;
      readonly workspace: WorkspaceSelection;
      readonly result: JsonValue;
      readonly usage?: AgentMessageUsage | undefined;
    }
  | (LocalHostRunTerminal & {
      readonly missionId: string;
      readonly executor: ExecutorReference;
      readonly workspace: WorkspaceSelection;
    });

type RunMissionTarget =
  { readonly kind: "allocate" } | { readonly kind: "attach"; readonly missionId: string };

export function createLocalHostRunApplication(options: {
  readonly executors: LocalHostRunExecutorPort;
  readonly mission: LocalHostRunMissionPort;
  /** Optional live-owner Inbox consumer supplied by the Host composition. */
  readonly commandConsumer?: MissionCommandConsumer | undefined;
  readonly redactor?: RunRedactor | (() => RunRedactor) | undefined;
}): LocalHostRunApplication {
  const startRun = async (input: {
    readonly request: LocalHostRunRequest;
    readonly target: RunMissionTarget;
    readonly presentation: LocalHostRunPresentation;
  }): Promise<LocalHostRunApplicationHandle> => {
    const { request, target, presentation } = input;
    const redactor =
      typeof options.redactor === "function"
        ? options.redactor()
        : (options.redactor ?? createRunRedactor());
    const registered = await options.mission.controller.readRunRequest({
      requestId: request.requestId,
    });
    const targetMissionId = target.kind === "attach" ? target.missionId : registered?.missionId;
    const existingPinnedBinding =
      targetMissionId === undefined
        ? undefined
        : await readExistingPinnedBinding(options.mission.controller, targetMissionId, request);
    const executorLookup =
      existingPinnedBinding === undefined
        ? {
            ref: request.executor,
            workspace: request.workspace,
            ...(request.project === undefined ? {} : { projectId: request.project.projectId }),
            ...(request.project?.revision === undefined
              ? {}
              : { revision: request.project.revision }),
          }
        : {
            ref: existingPinnedBinding.executor.ref,
            workspace: request.workspace,
            ...(existingPinnedBinding.executor.source === "project"
              ? {
                  projectId: existingPinnedBinding.executor.project.projectId,
                  revision: existingPinnedBinding.executor.project.revision,
                }
              : {}),
          };
    const executor = await options.executors.resolve({ ...executorLookup });
    if (executor === undefined) {
      throw createIntegrationError({
        code: "EXECUTOR_NOT_FOUND",
        category: "not_found",
        message: `Executor not found: ${request.executor.kind}:${request.executor.id}.`,
      });
    }
    validateExecutorPin(request, executor.descriptor);
    validateExecutorAvailability(executor.descriptor);
    const validated = await options.executors.validateInput?.({ request, executor });
    const runRequest = validated === undefined ? request : { ...request, input: validated.input };
    const canonicalRequest = {
      command: runRequest.command,
      workspace: runRequest.workspace,
      ...(runRequest.prompt === undefined ? {} : { prompt: runRequest.prompt }),
      ...(runRequest.input === undefined ? {} : { input: runRequest.input }),
    };
    const payloadHash = hashCanonicalRunPayload({
      ...canonicalRequest,
      executor: executor.descriptor.ref,
      ...(executor.descriptor.project === undefined
        ? {}
        : { project: executor.descriptor.project }),
    });
    const reservation =
      target.kind === "attach"
        ? await options.mission.controller.reserveAttachedRunRequest({
            requestId: request.requestId,
            payloadHash,
            missionId: target.missionId,
          })
        : await options.mission.controller.reserveRunRequest({
            requestId: request.requestId,
            payloadHash,
          });

    const current = await options.mission.controller.readSnapshot({
      missionId: reservation.missionId,
    });
    if (findMissionPinnedBinding(current.events) === undefined) {
      assertUnpinnedRunRetryAllowed({
        missionId: reservation.missionId,
        request,
        descriptor: executor.descriptor,
        events: current.events,
        allowEmptyReservationGap: current.events.length === 0,
      });
    }
    const existing = await readExistingRunState(
      options.mission.controller,
      reservation.missionId,
      runRequest,
    );
    if (existing.kind === "terminal") {
      return {
        request: runRequest,
        missionId: reservation.missionId,
        payloadHash,
        disposition: reservation.disposition,
        executionId: existing.outcome.executionId,
        outcome: Promise.resolve(existing.outcome),
        cancel: async () => undefined,
      };
    }
    if (existing.active) {
      if (request.detach) {
        return acceptedExistingHandle({
          request: runRequest,
          missionId: reservation.missionId,
          payloadHash,
          executionId: existing.executionId,
        });
      }
      throw createIntegrationError({
        code: "MISSION_LEASE_HELD",
        category: "conflict",
        message: "The existing Mission is still owned by another run.",
        details: {
          missionId: reservation.missionId,
          ...(existing.executionId === undefined ? {} : { executionId: existing.executionId }),
        },
      });
    }

    const claimId = randomUUID();
    let guard: MissionControllerGuard;
    try {
      guard = await options.mission.claim(reservation.missionId, claimId);
    } catch (error) {
      if (
        reservation.disposition === "existing" &&
        request.detach &&
        isIntegrationErrorCode(error, "MISSION_LEASE_HELD")
      ) {
        return acceptedExistingHandle({
          request: runRequest,
          missionId: reservation.missionId,
          payloadHash,
        });
      }
      throw error;
    }
    const existingEvents = (
      await options.mission.controller.readSnapshot({ missionId: reservation.missionId })
    ).events;
    let handle: LocalHostRunHandle | undefined;
    const pendingHumanEvents: HumanInteractionRequestEnvelope[] = [];
    let humanProcessing = Promise.resolve();
    let humanFailure: unknown;
    let missionStarted = existingEvents.some((event) => event.type === "run.started");
    const pendingProjectionEvents: LocalHostRunEvent[] = [];
    const eventProjector = createLocalHostMissionEventProjector({
      missionId: reservation.missionId,
      guard,
      mission: options.mission,
      redactor,
      onEvent: presentation.onEvent,
      knownEventIds: existingEvents.map((event) => event.eventId),
    });
    const projectEvent = (event: LocalHostRunEvent): void => eventProjector.enqueue(event);
    const processHumanInteraction = (interaction: HumanInteractionRequestEnvelope): void => {
      humanProcessing = humanProcessing
        .then(async () => {
          const decision = await presentation.onHumanInteraction?.(interaction);
          if (decision?.kind === "respond") {
            if (options.executors.respond === undefined) {
              throw createIntegrationError({
                code: "DEPENDENCY_UNAVAILABLE",
                category: "dependency",
                message: "Human interaction response is not available in this Host composition.",
              });
            }
            await options.executors.respond({
              missionId: reservation.missionId,
              executionId: interaction.executionId,
              interactionId: interaction.interactionId,
              response: decision.response,
              requestId: request.requestId,
            });
            return;
          }
          await handle?.checkpointWaitingHuman?.();
        })
        .catch((error: unknown) => {
          humanFailure ??= error;
        });
    };
    try {
      await options.executors.assertStartAllowed?.({
        request: runRequest,
        executor,
        missionId: reservation.missionId,
        payloadHash,
      });
      if (!existingEvents.some((event) => event.type === "mission.created")) {
        await options.mission.append(reservation.missionId, guard, "mission.created", {
          requestId: request.requestId,
          payloadHash,
          executor: runRequest.executor,
          workspace: runRequest.workspace.canonicalPath,
        });
      }
      await options.mission.ensurePinnedBinding({
        missionId: reservation.missionId,
        guard,
        binding: createRunPinnedBinding({
          missionId: reservation.missionId,
          request: runRequest,
          descriptor: executor.descriptor,
          payloadHash,
        }),
      });
      if (!existingEvents.some((event) => event.type === "run.accepted")) {
        await options.mission.append(reservation.missionId, guard, "run.accepted", {
          requestId: runRequest.requestId,
          payloadHash,
        });
      }
      handle = await options.executors.start({
        request: runRequest,
        executor,
        missionId: reservation.missionId,
        onEvent: (event) => {
          if (event.type === "human.interaction.requested") {
            const parsed = HumanInteractionRequestEnvelopeSchema.safeParse(event.data);
            if (parsed.success) {
              const interaction = redactInteraction(parsed.data, redactor);
              if (handle === undefined) pendingHumanEvents.push(interaction);
              else processHumanInteraction(interaction);
            }
          }
          if (missionStarted) projectEvent(event);
          else pendingProjectionEvents.push(event);
        },
      });
    } catch (error) {
      await options.mission.release(reservation.missionId).catch(() => undefined);
      throw error;
    }
    for (const interaction of pendingHumanEvents.splice(0)) processHumanInteraction(interaction);

    if (handle === undefined) throw new Error("Run executor did not return a handle.");
    try {
      if (!existingEvents.some((event) => event.type === "run.started")) {
        await options.mission.append(reservation.missionId, guard, "run.started", {
          executionId: handle.executionId,
        });
      }
      if (options.commandConsumer !== undefined) {
        if (options.mission.startPolling === undefined) {
          throw createIntegrationError({
            code: "DEPENDENCY_UNAVAILABLE",
            category: "dependency",
            message: "Mission Inbox polling is not available in this Host composition.",
          });
        }
        await options.mission.startPolling({
          missionId: reservation.missionId,
          consumer: options.commandConsumer,
        });
      }
    } catch (error) {
      if (handle.cancel !== undefined) {
        await handle.cancel("Mission run setup failed").catch(() => undefined);
      }
      await options.mission
        .releaseAfterLowerLevel({
          missionId: reservation.missionId,
          guard,
          releaseLowerLevel: async () => await handle.release?.(),
        })
        .catch(() => undefined);
      throw error;
    }
    missionStarted = true;
    for (const event of pendingProjectionEvents.splice(0)) projectEvent(event);
    const releaseRun = async (): Promise<void> =>
      await options.mission.releaseAfterLowerLevel({
        missionId: reservation.missionId,
        guard,
        releaseLowerLevel: async () => await handle.release?.(),
      });
    const outcome = handle.result.then(
      async (terminal) => {
        try {
          await humanProcessing;
          if (humanFailure !== undefined) throw humanFailure;
          const safeTerminal = await eventProjector.appendTerminal(terminal);
          return {
            ...safeTerminal,
            missionId: reservation.missionId,
            executor: runRequest.executor,
            workspace: runRequest.workspace,
          };
        } catch (error) {
          if (handle.cancel !== undefined) {
            await handle.cancel("Mission run finalization failed").catch(() => undefined);
          }
          throw error;
        } finally {
          await releaseRun();
        }
      },
      async (error: unknown) => {
        try {
          if (handle.cancel !== undefined) {
            await handle.cancel("Mission executor failed").catch(() => undefined);
          }
        } finally {
          await releaseRun();
        }
        throw error;
      },
    );
    const result = request.detach
      ? Promise.resolve({
          status: "accepted" as const,
          missionId: reservation.missionId,
          executionId: handle.executionId,
          result: { missionId: reservation.missionId, executionId: handle.executionId },
          executor: runRequest.executor,
          workspace: runRequest.workspace,
        })
      : outcome;
    if (request.detach) void outcome.catch(() => undefined);
    return {
      request: runRequest,
      missionId: reservation.missionId,
      payloadHash,
      disposition: reservation.disposition,
      executionId: handle.executionId,
      events: handle.events,
      outcome: result,
      cancel: async (reason) => await handle.cancel?.(reason),
    };
  };

  return {
    start: async (request, presentation = {}) =>
      await startRun({ request, target: { kind: "allocate" }, presentation }),
    startAttached: async (input, presentation = {}) =>
      await startRun({
        request: input.request,
        target: { kind: "attach", missionId: input.missionId },
        presentation,
      }),
    async respond(input) {
      if (options.executors.respond === undefined) {
        throw createIntegrationError({
          code: "DEPENDENCY_UNAVAILABLE",
          category: "dependency",
          message: "Human interaction response is not available in this Host composition.",
          details: { missionId: input.missionId, executionId: input.executionId },
        });
      }
      await options.executors.respond(input);
    },
  };
}

export function createControllerRunMissionPort(
  controller: MissionControllerStore,
  options: {
    readonly ownerScope?: MissionOwnerScope | undefined;
    readonly leaseMs?: number | undefined;
    readonly onLeaseLost?: ((missionId: string) => Promise<void> | void) | undefined;
  } = {},
): LocalHostRunMissionPort {
  const ownerScope =
    options.ownerScope ??
    createMissionOwnerScope({
      controller,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.onLeaseLost === undefined ? {} : { onLeaseLost: options.onLeaseLost }),
    });
  return {
    controller,
    claim: async (missionId, claimId) => await ownerScope.acquire(missionId, claimId),
    append: async (missionId, guard, type, data, eventId) => {
      const currentGuard = ownerScope.currentGuard(missionId) ?? guard;
      await controller.write({
        missionId,
        guard: currentGuard,
        operation: async ({ appendEvent }) => {
          await appendEvent(type, data, validMissionEventId(eventId));
        },
      });
      return { cursor: (await controller.readSnapshot({ missionId })).cursor };
    },
    ensurePinnedBinding: async (input) =>
      await controller.ensurePinnedBinding({
        ...input,
        guard: ownerScope.currentGuard(input.missionId) ?? input.guard,
      }),
    startPolling: async (input) => await ownerScope.startPolling(input),
    release: async (missionId) => await ownerScope.release(missionId),
    releaseAfterLowerLevel: async (input) =>
      await ownerScope.releaseAfterLowerLevel(input.missionId, input.releaseLowerLevel),
  };
}

function validMissionEventId(eventId: string | undefined): string | undefined {
  return eventId !== undefined && MISSION_EVENT_ID_PATTERN.test(eventId) ? eventId : undefined;
}

const MISSION_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function createRunPinnedBinding(input: {
  readonly missionId: string;
  readonly request: LocalHostRunRequest;
  readonly descriptor: ExecutorDescriptor;
  readonly payloadHash: string;
}): MissionPinnedBinding {
  const descriptor = input.descriptor;
  if (descriptor.source === "built_in") {
    return createMissionPinnedBinding({
      requestId: input.request.requestId,
      payloadHash: input.payloadHash,
      command: input.request.command,
      executor: { source: "built_in", ref: descriptor.ref },
      workspace: {
        canonicalPath: input.request.workspace.canonicalPath,
        identityHash: input.request.workspace.identityHash,
      },
      provenance: "new_run",
    });
  }
  if (descriptor.source === "project" && descriptor.project !== undefined) {
    return createMissionPinnedBinding({
      requestId: input.request.requestId,
      payloadHash: input.payloadHash,
      command: input.request.command,
      executor: { source: "project", ref: descriptor.ref, project: descriptor.project },
      workspace: {
        canonicalPath: input.request.workspace.canonicalPath,
        identityHash: input.request.workspace.identityHash,
      },
      provenance: "new_run",
    });
  }
  throw createIntegrationError({
    code: "STORAGE_VERSION_UNSUPPORTED",
    category: "protocol",
    message: "This executor source cannot be persisted as a Mission binding anchor.",
    details: {
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      executor: descriptor.ref,
      requiredOptions: ["--project", "--revision"],
    },
  });
}

function validateExecutorPin(request: LocalHostRunRequest, descriptor: ExecutorDescriptor): void {
  if (descriptor.ref.kind !== request.executor.kind || descriptor.ref.id !== request.executor.id) {
    throw createIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      category: "not_found",
      message: "The resolved executor does not match the requested executor.",
    });
  }
  const project = descriptor.project;
  if (request.expectedFingerprint !== undefined && project === undefined) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "--expected-fingerprint is only valid for a project executor.",
    });
  }
  if (request.project !== undefined) {
    if (
      project === undefined ||
      project.projectId !== request.project.projectId ||
      (request.project.revision !== undefined && project.revision !== request.project.revision) ||
      (request.expectedFingerprint !== undefined &&
        project.fingerprint !== request.expectedFingerprint)
    ) {
      throw createIntegrationError({
        code: "EXECUTOR_NOT_FOUND",
        category: "not_found",
        message: "The requested executor revision is not available.",
      });
    }
  }
  if (
    request.expectedFingerprint !== undefined &&
    project?.fingerprint !== request.expectedFingerprint
  ) {
    throw createIntegrationError({
      code: "IDEMPOTENCY_CONFLICT",
      category: "conflict",
      message: "Executor fingerprint does not match the expected revision.",
      details: { expectedFingerprint: request.expectedFingerprint },
    });
  }
}

function validateExecutorAvailability(descriptor: ExecutorDescriptor): void {
  if (descriptor.availability.status === "ready") return;
  const blockingCodes = descriptor.availability.blockingCodes;
  const code = blockingCodes.includes("RUNTIME_UNAVAILABLE")
    ? "RUNTIME_UNAVAILABLE"
    : blockingCodes.includes("KEYCHAIN_UNAVAILABLE")
      ? "KEYCHAIN_UNAVAILABLE"
      : blockingCodes.includes("SECRET_STORE_LOCKED")
        ? "SECRET_STORE_LOCKED"
        : "DEPENDENCY_UNAVAILABLE";
  throw createIntegrationError({
    code,
    category: "dependency",
    message:
      blockingCodes.length === 0
        ? `Executor is ${descriptor.availability.status}.`
        : `Executor is unavailable: ${blockingCodes.join(", ")}.`,
    details: { blockingCodes },
  });
}

function acceptedExistingHandle(input: {
  readonly request: LocalHostRunRequest;
  readonly missionId: string;
  readonly payloadHash: string;
  readonly executionId?: string | undefined;
}): LocalHostRunApplicationHandle {
  const outcome: LocalHostRunApplicationOutcome = {
    status: "accepted",
    missionId: input.missionId,
    executor: input.request.executor,
    workspace: input.request.workspace,
    result: {
      missionId: input.missionId,
      reused: true,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    },
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
  };
  return {
    request: input.request,
    missionId: input.missionId,
    payloadHash: input.payloadHash,
    disposition: "existing",
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    outcome: Promise.resolve(outcome),
    cancel: async () => undefined,
  };
}

type ExistingRunState =
  | { readonly kind: "terminal"; readonly outcome: LocalHostRunApplicationOutcome }
  | {
      readonly kind: "active";
      readonly active: boolean;
      readonly executionId?: string | undefined;
    };

async function readExistingRunState(
  controller: MissionControllerStore,
  missionId: string,
  request: LocalHostRunRequest,
): Promise<ExistingRunState> {
  const snapshot = await controller.readSnapshot({ missionId });
  for (const event of [...snapshot.events].toReversed()) {
    if (
      event.type !== "run.succeeded" &&
      event.type !== "run.input_required" &&
      event.type !== "run.failed" &&
      event.type !== "run.interrupted"
    ) {
      continue;
    }
    const data = event.data;
    const executionId = typeof data["executionId"] === "string" ? data["executionId"] : undefined;
    if (executionId === undefined) continue;
    const usage = parseUsage(data["usage"]);
    if (event.type === "run.succeeded") {
      const result = JsonValueSchema.safeParse(data["result"]);
      if (!result.success) continue;
      return {
        kind: "terminal",
        outcome: {
          status: "succeeded",
          missionId,
          executionId,
          executor: request.executor,
          workspace: request.workspace,
          result: result.data,
          ...(usage === undefined ? {} : { usage }),
        },
      };
    }
    if (event.type === "run.input_required") {
      const interaction = HumanInteractionRequestEnvelopeSchema.safeParse(data["interaction"]);
      if (!interaction.success) continue;
      return {
        kind: "terminal",
        outcome: {
          status: "input_required",
          missionId,
          executionId,
          executor: request.executor,
          workspace: request.workspace,
          interaction: interaction.data,
          ...(usage === undefined ? {} : { usage }),
        },
      };
    }
    if (event.type === "run.failed") {
      const error = IntegrationErrorSchema.safeParse(data["error"]);
      if (!error.success) continue;
      return {
        kind: "terminal",
        outcome: {
          status: "failed",
          missionId,
          executionId,
          executor: request.executor,
          workspace: request.workspace,
          error: error.data,
          ...(usage === undefined ? {} : { usage }),
        },
      };
    }
    return {
      kind: "terminal",
      outcome: {
        status: "interrupted",
        missionId,
        executionId,
        executor: request.executor,
        workspace: request.workspace,
        ...(usage === undefined ? {} : { usage }),
      },
    };
  }
  const started = [...snapshot.events].toReversed().find((event) => event.type === "run.started");
  const startedData = started?.data;
  const executionId =
    typeof startedData?.["executionId"] === "string" ? startedData["executionId"] : undefined;
  return {
    kind: "active",
    active:
      snapshot.snapshot.lease !== undefined &&
      Date.parse(snapshot.snapshot.lease.expiresAt) > Date.now(),
    ...(executionId === undefined ? {} : { executionId }),
  };
}

function parseUsage(value: unknown): AgentMessageUsage | undefined {
  const parsed = AgentMessageUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isIntegrationErrorCode(error: unknown, code: IntegrationError["code"]): boolean {
  const parsed = IntegrationErrorSchema.safeParse(error);
  return parsed.success && parsed.data.code === code;
}

async function readExistingPinnedBinding(
  controller: MissionControllerStore,
  missionId: string,
  request: LocalHostRunRequest,
): Promise<MissionPinnedBinding | undefined> {
  const snapshot = await controller.readSnapshot({ missionId });
  const binding = findMissionPinnedBinding(snapshot.events);
  if (binding === undefined) {
    if (
      snapshot.events.some((event) => event.type === "mission.created") &&
      snapshot.events.some((event) => event.type !== "mission.created")
    ) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_required",
        missionId,
        executor: request.executor,
        message:
          "This historical Mission must be repaired with mission resume before it can be acquired.",
      });
    }
    return undefined;
  }
  if (
    binding.requestId !== request.requestId ||
    binding.command !== request.command ||
    binding.executor.ref.kind !== request.executor.kind ||
    binding.executor.ref.id !== request.executor.id ||
    binding.workspace.canonicalPath !== request.workspace.canonicalPath ||
    binding.workspace.identityHash !== request.workspace.identityHash
  ) {
    throw createIntegrationError({
      code: "IDEMPOTENCY_CONFLICT",
      category: "conflict",
      message: "The request identity does not match the existing Mission binding.",
      details: { missionId, requestId: request.requestId },
    });
  }
  return binding;
}

function assertUnpinnedRunRetryAllowed(input: {
  readonly missionId: string;
  readonly request: LocalHostRunRequest;
  readonly descriptor: ExecutorDescriptor;
  readonly events: readonly { readonly type: string }[];
  readonly allowEmptyReservationGap?: boolean | undefined;
}): void {
  const isExactProjectRetry =
    input.descriptor.source === "project" && input.request.project?.revision !== undefined;
  const isAuthoritativeBuiltInRetry = input.descriptor.source === "built_in";
  const isCreationOnlyGap =
    input.events.length === 1 && input.events[0]?.type === "mission.created";
  const isEmptyReservationGap =
    input.allowEmptyReservationGap === true && input.events.length === 0;
  if (
    (isExactProjectRetry || isAuthoritativeBuiltInRetry) &&
    (isCreationOnlyGap || isEmptyReservationGap)
  )
    return;
  throw createPinnedBindingRecoveryError({
    reason: "mission_pinned_binding_required",
    missionId: input.missionId,
    executor: input.request.executor,
    message:
      "This historical Mission must be repaired with mission resume before it can be acquired.",
  });
}
