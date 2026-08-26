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
import { hashCanonicalRunPayload, type CanonicalRunPayloadInput } from "./run-payload.ts";
import { createRunRedactor, type RunRedactor } from "./redaction.ts";

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
  ) => Promise<{ readonly cursor: string }>;
  readonly releaseAfterLowerLevel: (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly releaseLowerLevel: () => Promise<void>;
  }) => Promise<void>;
}

export interface LocalHostRunApplication {
  readonly start: (
    request: LocalHostRunRequest,
    options?: {
      readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
      readonly onHumanInteraction?:
        | ((
            request: HumanInteractionRequestEnvelope,
          ) => Promise<
            | { readonly kind: "respond"; readonly response: unknown }
            | { readonly kind: "checkpoint" }
          >)
        | undefined;
    },
  ) => Promise<LocalHostRunApplicationHandle>;
  readonly respond: (input: {
    readonly missionId: string;
    readonly executionId: string;
    readonly interactionId: string;
    readonly response: unknown;
    readonly requestId: string;
  }) => Promise<void>;
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

export function createLocalHostRunApplication(options: {
  readonly executors: LocalHostRunExecutorPort;
  readonly mission: LocalHostRunMissionPort;
  readonly redactor?: RunRedactor | (() => RunRedactor) | undefined;
}): LocalHostRunApplication {
  return {
    async start(request, presentation = {}) {
      const redactor =
        typeof options.redactor === "function"
          ? options.redactor()
          : (options.redactor ?? createRunRedactor());
      const executor = await options.executors.resolve({
        ref: request.executor,
        workspace: request.workspace,
        ...(request.project === undefined ? {} : { projectId: request.project.projectId }),
        ...(request.project?.revision === undefined ? {} : { revision: request.project.revision }),
      });
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
      const reservation = await options.mission.controller.reserveRunRequest({
        requestId: request.requestId,
        payloadHash,
      });

      if (reservation.disposition === "existing") {
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
      const existingEvents =
        reservation.disposition === "existing"
          ? (await options.mission.controller.readSnapshot({ missionId: reservation.missionId }))
              .events
          : [];
      let handle: LocalHostRunHandle | undefined;
      const pendingHumanEvents: HumanInteractionRequestEnvelope[] = [];
      let humanProcessing = Promise.resolve();
      let humanFailure: unknown;
      let eventProjection = Promise.resolve();
      let eventProjectionFailure: unknown;
      let missionStarted = existingEvents.some((event) => event.type === "run.started");
      const pendingProjectionEvents: LocalHostRunEvent[] = [];
      const publishEvent = (event: LocalHostRunEvent): void => {
        presentation.onEvent?.(redactEvent(event, redactor));
      };
      const projectEvent = (event: LocalHostRunEvent): void => {
        if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
          publishEvent({ ...redactEvent(event, redactor), replayable: false, cursor: undefined });
          return;
        }
        eventProjection = eventProjection
          .then(async () => {
            const committed = await options.mission.append(
              reservation.missionId,
              guard,
              event.type,
              redactEventData(event.data, redactor),
            );
            publishEvent({
              ...redactEvent(event, redactor),
              replayable: true,
              cursor: committed.cursor,
            });
          })
          .catch((error: unknown) => {
            eventProjectionFailure ??= error;
          });
      };
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
        if (!existingEvents.some((event) => event.type === "mission.created")) {
          await options.mission.append(reservation.missionId, guard, "mission.created", {
            requestId: request.requestId,
            payloadHash,
            executor: runRequest.executor,
            workspace: runRequest.workspace.canonicalPath,
          });
        }
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
        await options.mission.controller
          .release({ missionId: reservation.missionId, guard })
          .catch(() => undefined);
        throw error;
      }
      for (const interaction of pendingHumanEvents.splice(0)) processHumanInteraction(interaction);

      if (handle === undefined) throw new Error("Run executor did not return a handle.");
      if (!existingEvents.some((event) => event.type === "run.started")) {
        await options.mission.append(reservation.missionId, guard, "run.started", {
          executionId: handle.executionId,
        });
      }
      missionStarted = true;
      for (const event of pendingProjectionEvents.splice(0)) projectEvent(event);
      const outcome = handle.result.then(async (terminal) => {
        await eventProjection;
        if (eventProjectionFailure !== undefined) throw eventProjectionFailure;
        await humanProcessing;
        if (humanFailure !== undefined) {
          await handle.cancel?.("Human interaction handling failed").catch(() => undefined);
          throw humanFailure;
        }
        const safeTerminal = redactTerminal(terminal, redactor);
        try {
          await options.mission.append(reservation.missionId, guard, `run.${safeTerminal.status}`, {
            executionId: safeTerminal.executionId,
            ...(safeTerminal.result === undefined ? {} : { result: safeTerminal.result }),
            ...(safeTerminal.interaction === undefined
              ? {}
              : { interaction: safeTerminal.interaction }),
            ...(safeTerminal.usage === undefined ? {} : { usage: safeTerminal.usage }),
            ...(safeTerminal.error === undefined ? {} : { error: safeTerminal.error }),
          });
        } finally {
          await options.mission.releaseAfterLowerLevel({
            missionId: reservation.missionId,
            guard,
            releaseLowerLevel: async () => await handle.release?.(),
          });
        }
        return {
          ...safeTerminal,
          missionId: reservation.missionId,
          executor: runRequest.executor,
          workspace: runRequest.workspace,
        };
      });
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
    },
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

function redactEvent(
  event: LocalHostRunEvent,
  redactor: RunRedactor | undefined,
): LocalHostRunEvent {
  if (redactor === undefined) return event;
  return { ...event, data: redactor.redactJson(event.data) };
}

function redactEventData(
  value: JsonValue,
  redactor: RunRedactor | undefined,
): Record<string, unknown> {
  const redacted = redactor?.redactJson(value) ?? value;
  return redacted as Record<string, unknown>;
}

function redactTerminal(
  terminal: LocalHostRunTerminal,
  redactor: RunRedactor | undefined,
): LocalHostRunTerminal {
  if (redactor === undefined) return terminal;
  return {
    ...terminal,
    ...(terminal.result === undefined ? {} : { result: redactor.redactJson(terminal.result) }),
    ...(terminal.interaction === undefined
      ? {}
      : { interaction: redactInteraction(terminal.interaction, redactor) }),
    ...(terminal.error === undefined
      ? {}
      : {
          error: {
            ...terminal.error,
            message: redactor.redactText(terminal.error.message),
            ...(terminal.error.details === undefined
              ? {}
              : {
                  details: redactor.redactJson(terminal.error.details) as Record<string, JsonValue>,
                }),
          },
        }),
  };
}

function redactInteraction(
  interaction: HumanInteractionRequestEnvelope,
  redactor: RunRedactor | undefined,
): HumanInteractionRequestEnvelope {
  if (redactor === undefined) return interaction;
  return {
    ...interaction,
    interaction: redactor.redactJson(
      interaction.interaction as unknown as JsonValue,
    ) as unknown as HumanInteractionRequestEnvelope["interaction"],
  };
}

export function createControllerRunMissionPort(
  controller: MissionControllerStore,
): LocalHostRunMissionPort {
  return {
    controller,
    claim: async (missionId, claimId) =>
      await controller.claim({ missionId, claimId, leaseMs: 30_000 }),
    append: async (missionId, guard, type, data) => {
      await controller.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent(type, data);
        },
      });
      return { cursor: (await controller.readSnapshot({ missionId })).cursor };
    },
    releaseAfterLowerLevel: async (input) => await controller.releaseAfterLowerLevel(input),
  };
}

function validateExecutorPin(request: LocalHostRunRequest, descriptor: ExecutorDescriptor): void {
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
