import { randomUUID } from "node:crypto";

import {
  createIntegrationError,
  type IntegrationError,
  type MissionCommand,
} from "@pragma/shared/integration";
import type { AgentMessageUsage, JsonValue } from "@pragma/shared";

import {
  hashMissionCommandPayload,
  type CanonicalMissionCommandPayloadInput,
} from "./command-payload.ts";
import type { MissionCommandConsumer, MissionControllerStore } from "./mission-controller-store.ts";
import type { MissionOperationProjection } from "./schemas.ts";
import type { MissionOwnerScope } from "./owner-scope.ts";

export interface MissionControlClient {
  readonly surface: "cli" | "desktop";
  readonly version: string;
  readonly instanceId: string;
}

export interface MissionControlTargetResolution {
  readonly executionId: string;
  readonly turnId: string;
}

export interface MissionControlSubmitInput {
  readonly missionId: string;
  readonly requestId: string;
  readonly kind: MissionCommand["kind"];
  readonly payload: MissionCommand["payload"];
  /** Explicit target is useful to non-CLI callers that already read a CAS target. */
  readonly target?: MissionCommand["target"] | undefined;
  /** CLI-facing optimistic target. It is resolved to executionId + turnId before append. */
  readonly expectedExecutionId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly client?: MissionControlClient | undefined;
}

export interface MissionControlSubmission {
  readonly command: MissionCommand;
  readonly operation: MissionOperationProjection;
  readonly owner: "live" | "scheduled";
}

export interface MissionControlOperationInput {
  readonly missionId: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly kind: string;
  readonly createdAt?: string | undefined;
}

export interface MissionControlExecutionOutcome {
  readonly executionId: string;
  readonly status:
    "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly result?: JsonValue | undefined;
  readonly interaction?: JsonValue | undefined;
  readonly usage?: AgentMessageUsage | undefined;
  readonly error?: IntegrationError | undefined;
}

export interface MissionControlApplication {
  submit(input: MissionControlSubmitInput): Promise<MissionControlSubmission>;
  waitForAcceptance(input: {
    readonly missionId: string;
    readonly requestId: string;
    readonly timeoutMs?: number | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<MissionOperationProjection>;
  waitForTerminal(input: {
    readonly missionId: string;
    readonly requestId: string;
    readonly timeoutMs?: number | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<MissionOperationProjection>;
  reserveOperation(input: MissionControlOperationInput): Promise<{
    readonly operation: MissionOperationProjection;
    readonly disposition: "reserved" | "existing";
  }>;
  completeOperation(
    input: Parameters<MissionControllerStore["completeOperation"]>[0],
  ): Promise<MissionOperationProjection>;
  /** Follow a Core execution after the command acknowledgement when requested. */
  readonly waitExecution?:
    | ((input: {
        readonly missionId: string;
        readonly executionId: string;
        readonly pollIntervalMs?: number | undefined;
      }) => Promise<MissionControlExecutionOutcome>)
    | undefined;
  startOwner(missionId: string): Promise<"live" | "acquired">;
  stopOwner(missionId: string): Promise<void>;
}

/**
 * Common Mission mutation application layer used by CLI and Host adapters.
 *
 * It owns only command canonicalisation, Inbox append, owner acquisition and
 * polling. Core/Runtime work is always delegated to the injected consumer and
 * therefore remains outside the aggregate lock held by MissionControllerStore.
 */
export function createMissionControlApplication(options: {
  readonly controller: MissionControllerStore;
  readonly ownerScope: MissionOwnerScope;
  readonly consumer: MissionCommandConsumer;
  readonly client?: MissionControlClient | undefined;
  readonly assertMission?: ((missionId: string) => Promise<void>) | undefined;
  readonly assertAcquisitionAllowed?: ((missionId: string) => Promise<void>) | undefined;
  readonly resolveStrictTarget?:
    | ((input: {
        readonly missionId: string;
        readonly expectedExecutionId?: string | undefined;
      }) => Promise<MissionControlTargetResolution | undefined>)
    | undefined;
  readonly resolveExecutionTarget?:
    | ((input: {
        readonly missionId: string;
        readonly expectedExecutionId?: string | undefined;
      }) => Promise<string | undefined>)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly waitExecution?: MissionControlApplication["waitExecution"];
  readonly onOwnerStartError?:
    | ((input: { readonly missionId: string; readonly error: unknown }) => Promise<void> | void)
    | undefined;
}): MissionControlApplication {
  const now = options.now ?? (() => new Date());
  options.ownerScope.bindConsumer(options.consumer);

  const startOwner = async (missionId: string): Promise<"live" | "acquired"> => {
    const current = options.ownerScope.currentGuard(missionId);
    if (current !== undefined) {
      return "live";
    }

    const snapshot = await options.controller.readSnapshot({ missionId });
    if (hasLiveLease(snapshot.snapshot.lease, now())) return "live";

    await options.assertAcquisitionAllowed?.(missionId);
    try {
      await options.ownerScope.acquire(missionId);
    } catch (error) {
      if (isIntegrationErrorCode(error, "MISSION_LEASE_HELD")) return "live";
      throw error;
    }
    return "acquired";
  };

  return {
    startOwner,
    stopOwner: async (missionId) => await options.ownerScope.stop(missionId),
    reserveOperation: async (input) => await options.controller.reserveOperation(input),
    completeOperation: async (input) => await options.controller.completeOperation(input),
    ...(options.waitExecution === undefined ? {} : { waitExecution: options.waitExecution }),
    async submit(input) {
      await options.assertMission?.(input.missionId);
      const createdAt = input.createdAt ?? now().toISOString();
      const strict = input.kind === "steer" || input.kind === "queue.steer";
      // Resolve a moving target only for a new request. A retry must be
      // compared with the durable command's original target; otherwise a
      // completed steer/interrupt becomes impossible to replay after its
      // execution has naturally disappeared from the live projection.
      const existingCommand = await options.controller.getCommand({
        missionId: input.missionId,
        requestId: input.requestId,
      });
      const target =
        existingCommand === undefined
          ? await resolveTarget(options, input, strict)
          : retryTarget(input, existingCommand);
      // An interrupt without an optimistic execution is allowed to capture
      // the execution that is current at append time, but that moving value
      // is not part of the caller's semantic request.  Keeping it out of the
      // hash makes a retry idempotent after the interrupted execution has
      // become terminal.
      const canonicalTarget =
        input.kind === "interrupt" && input.expectedExecutionId === undefined
          ? input.target
          : target;
      const canonical: CanonicalMissionCommandPayloadInput = {
        missionId: input.missionId,
        kind: input.kind,
        ...(canonicalTarget === undefined ? {} : { target: canonicalTarget }),
        payload: input.payload,
      };
      const payloadHash = hashMissionCommandPayload(canonical);
      const snapshot = await options.controller.readSnapshot({ missionId: input.missionId });
      const liveLease = hasLiveLease(snapshot.snapshot.lease, now());
      const replayingTerminalCommand =
        existingCommand !== undefined && isTerminalCommandState(existingCommand.state);

      if (strict && !liveLease && !replayingTerminalCommand) {
        throw createIntegrationError({
          code: "STEER_TARGET_NOT_ACTIVE",
          category: "conflict",
          message: "Strict Mission steer requires a live Mission owner.",
          details: { missionId: input.missionId },
        });
      }
      if (!liveLease && !replayingTerminalCommand)
        await options.assertAcquisitionAllowed?.(input.missionId);

      const appended = await options.controller.appendCommand({
        request: {
          schemaVersion: "pragma.integration-request/v1",
          requestId: input.requestId,
          payloadHash,
          requestedAt: createdAt,
          client: input.client ?? options.client ?? defaultClient(),
        },
        missionId: input.missionId,
        kind: input.kind,
        ...(target === undefined ? {} : { target }),
        payload: input.payload,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      });

      // A retry of an already terminal command is satisfied by the durable
      // projection.  Do not reacquire a Mission lease merely to replay an
      // operation whose side effect has already been recorded.
      if (isTerminalOperation(appended.operation.state)) {
        return { ...appended, owner: "live" };
      }

      // A command is durable before owner acquisition. If the process races a
      // live owner, MISSION_LEASE_HELD is treated as successful routing to that
      // owner and the existing poller consumes the same Inbox item.
      if (options.ownerScope.currentGuard(input.missionId) !== undefined) {
        return { ...appended, owner: "live" };
      }
      void startOwner(input.missionId).catch(async (error: unknown) => {
        try {
          await options.onOwnerStartError?.({ missionId: input.missionId, error });
        } catch {
          // The command is already durable. Diagnostics must not create an
          // unhandled rejection or change its idempotent retry semantics.
        }
      });
      return { ...appended, owner: "scheduled" };
    },
    async waitForAcceptance(input) {
      return await options.controller.waitForAcceptanceOperation(input);
    },
    async waitForTerminal(input) {
      return await options.controller.waitForTerminalOperation(input);
    },
  };
}

function isTerminalOperation(state: MissionOperationProjection["state"]): boolean {
  return state === "applied" || state === "rejected" || state === "expired" || state === "failed";
}

function isTerminalCommandState(state: MissionCommand["state"]): boolean {
  return state === "applied" || state === "rejected" || state === "expired";
}

function retryTarget(
  input: MissionControlSubmitInput,
  existing: MissionCommand,
): MissionCommand["target"] | undefined {
  if (input.kind === "interrupt") {
    if (input.expectedExecutionId === undefined) return input.target;
    return { ...(input.target ?? {}), executionId: input.expectedExecutionId };
  }
  if (input.kind !== "steer" && input.kind !== "queue.steer") return input.target;

  // The CLI supplies queueItemId and (optionally) an optimistic execution,
  // while the persisted command also contains the resolved turnId. Merge
  // caller-owned stable fields with the original resolved target so a retry
  // can hash the same request without consulting a moving Runtime projection.
  return {
    ...(existing.target ?? {}),
    ...(input.target ?? {}),
    ...(input.expectedExecutionId === undefined ? {} : { executionId: input.expectedExecutionId }),
  };
}

async function resolveTarget(
  options: Parameters<typeof createMissionControlApplication>[0],
  input: MissionControlSubmitInput,
  strict: boolean,
): Promise<MissionCommand["target"] | undefined> {
  if (!strict) {
    // Interrupt applies to the current execution when no optimistic target
    // was supplied. The caller-facing canonical hash deliberately excludes
    // this moving target; see the submit path below.
    const shouldResolveExecution =
      input.expectedExecutionId !== undefined || input.kind === "interrupt";
    if (!shouldResolveExecution || options.resolveExecutionTarget === undefined)
      return input.target;
    const executionId = await options.resolveExecutionTarget({
      missionId: input.missionId,
      expectedExecutionId: input.expectedExecutionId,
    });
    return executionId === undefined ? input.target : { ...(input.target ?? {}), executionId };
  }
  if (input.target?.executionId !== undefined && input.target.turnId !== undefined) {
    if (options.resolveStrictTarget !== undefined) {
      const current = await options.resolveStrictTarget({
        missionId: input.missionId,
        expectedExecutionId: input.expectedExecutionId ?? input.target.executionId,
      });
      if (current === undefined) throw targetNotActiveError(input.missionId);
      if (
        current.executionId !== input.target.executionId ||
        current.turnId !== input.target.turnId
      ) {
        throw targetChangedError(input.missionId);
      }
    }
    if (
      input.expectedExecutionId !== undefined &&
      input.target.executionId !== input.expectedExecutionId
    ) {
      throw targetChangedError(input.missionId);
    }
    return input.target;
  }
  if (options.resolveStrictTarget === undefined) {
    throw createIntegrationError({
      code: "STEER_TARGET_NOT_ACTIVE",
      category: "conflict",
      message: "Strict Mission command requires an active execution and turn.",
      details: { missionId: input.missionId },
    });
  }
  const resolved = await options.resolveStrictTarget({
    missionId: input.missionId,
    expectedExecutionId: input.expectedExecutionId,
  });
  if (resolved === undefined) throw targetNotActiveError(input.missionId);
  return { ...(input.target ?? {}), ...resolved };
}

function hasLiveLease(lease: { readonly expiresAt: string } | undefined, now: Date): boolean {
  return lease !== undefined && Date.parse(lease.expiresAt) > now.getTime();
}

function defaultClient(): MissionControlClient {
  return {
    surface: "cli",
    version: "unknown",
    instanceId: randomUUID(),
  };
}

function targetNotActiveError(missionId: string): IntegrationError {
  return createIntegrationError({
    code: "STEER_TARGET_NOT_ACTIVE",
    category: "conflict",
    message: "Mission has no active execution turn for strict steer.",
    details: { missionId },
  });
}

function targetChangedError(missionId: string): IntegrationError {
  return createIntegrationError({
    code: "STEER_TARGET_CHANGED",
    category: "conflict",
    message: "Strict Mission steer target changed before command submission.",
    details: { missionId },
  });
}

function isIntegrationErrorCode(error: unknown, code: IntegrationError["code"]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "schemaVersion" in error &&
    (error as { readonly schemaVersion?: unknown }).schemaVersion ===
      "pragma.integration-error/v1" &&
    (error as { readonly code?: unknown }).code === code
  );
}
