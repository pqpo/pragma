import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import type { ExpertSessionStore, ExecutionStore } from "@pragma/core";
import {
  createIntegrationError,
  ExecutorDescriptorSchema,
  ExecutorReferenceSchema,
  IntegrationErrorSchema,
  WorkspaceSelectionSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type WorkspaceSelection,
} from "@pragma/shared/integration";
import { z } from "zod";

import type { LocalHostProjectCatalog } from "../../project-catalog.ts";
import { hashCanonicalRunPayload } from "../../run-payload.ts";
import type { MissionControllerGuard, MissionControllerStore } from "./mission-controller-store.ts";
import {
  createPinnedBindingRecoveryError,
  findMissionPinnedBinding,
  sameMissionPinnedBinding,
  type MissionPinnedBinding,
} from "./pinned-binding.ts";
import type { MissionEvent } from "./schemas.ts";

const MissionCreatedDataSchema = z
  .object({
    requestId: z.string().uuid(),
    payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    executor: ExecutorReferenceSchema,
    workspace: z.string().min(1),
  })
  .passthrough();

const RunAcceptedDataSchema = z
  .object({
    requestId: z.string().uuid(),
    payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .passthrough();

export interface MissionPinnedBindingBackfillInput {
  readonly missionId: string;
  /** Required for a project-backed historical Mission; both fields are atomic. */
  readonly project?:
    | {
        readonly projectId: string;
        readonly revision: number;
      }
    | undefined;
  readonly expectedFingerprint?: string | undefined;
  readonly leaseMs?: number | undefined;
}

export interface MissionPinnedBindingBackfillResult {
  readonly binding: MissionPinnedBinding;
  readonly disposition: "appended" | "existing";
}

export interface MissionPinnedBindingBackfillPorts {
  readonly controller: Pick<
    MissionControllerStore,
    "readSnapshot" | "readRunRequest" | "claim" | "renew" | "release" | "ensurePinnedBinding"
  >;
  /** Exact project revision lookup. Implementations must not fall back to head. */
  readonly catalog: Pick<LocalHostProjectCatalog, "resolve">;
  readonly builtInResolver?: (input: {
    readonly ref: ExecutorReference;
    readonly workspace: WorkspaceSelection;
  }) => Promise<{ readonly descriptor: ExecutorDescriptor } | undefined>;
  readonly sessions?: Pick<ExpertSessionStore, "listPrompts"> | undefined;
  readonly executions?: Pick<ExecutionStore, "get"> | undefined;
}

/**
 * Prove and append the missing Mission identity anchor for one owner. All
 * catalog/Core reads happen outside the aggregate lock; the final append is
 * fenced and idempotent. This function never starts or recovers Core.
 */
export async function backfillMissionPinnedBinding(
  ports: MissionPinnedBindingBackfillPorts,
  input: MissionPinnedBindingBackfillInput,
): Promise<MissionPinnedBindingBackfillResult> {
  validateBackfillInput(input);
  const first = await readHistoricalProof(ports, input);
  if (first.existing !== undefined) {
    return { binding: first.existing, disposition: "existing" };
  }

  const claimId = randomUUID();
  let guard: MissionControllerGuard | undefined;
  try {
    const lease = await ports.controller.claim({
      missionId: input.missionId,
      claimId,
      leaseMs: input.leaseMs ?? 30_000,
    });
    guard = lease;

    const second = await readHistoricalProof(ports, input);
    if (second.existing !== undefined) {
      if (!sameMissionPinnedBinding(first.binding, second.existing)) {
        throw storageCorruption("A competing pin changed the historical Mission binding.");
      }
      return { binding: second.existing, disposition: "existing" };
    }
    if (!sameMissionPinnedBinding(first.binding, second.binding)) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_unprovable",
        missionId: input.missionId,
        executor: first.created.executor,
        message: "The historical Mission evidence changed while its binding was being proven.",
      });
    }

    guard = await ports.controller.renew({
      missionId: input.missionId,
      guard,
      leaseMs: input.leaseMs ?? 30_000,
    });
    const final = await readHistoricalProof(ports, input);
    if (final.existing !== undefined) {
      if (!sameMissionPinnedBinding(first.binding, final.existing)) {
        throw storageCorruption("A competing pin changed the historical Mission binding.");
      }
      return { binding: final.existing, disposition: "existing" };
    }
    if (!sameMissionPinnedBinding(second.binding, final.binding)) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_unprovable",
        missionId: input.missionId,
        executor: final.created.executor,
        message: "The historical Mission evidence changed before its binding was appended.",
      });
    }
    const result = await ports.controller.ensurePinnedBinding({
      missionId: input.missionId,
      guard,
      binding: final.binding,
    });
    return { binding: final.binding, disposition: result.disposition };
  } finally {
    if (guard !== undefined) {
      await ports.controller.release({ missionId: input.missionId, guard }).catch(() => undefined);
    }
  }
}

interface HistoricalProof {
  readonly binding: MissionPinnedBinding;
  readonly existing?: MissionPinnedBinding | undefined;
  readonly created: MissionCreatedData;
}

type MissionCreatedData = z.infer<typeof MissionCreatedDataSchema>;

async function readHistoricalProof(
  ports: MissionPinnedBindingBackfillPorts,
  input: MissionPinnedBindingBackfillInput,
): Promise<HistoricalProof> {
  const snapshot = await ports.controller.readSnapshot({ missionId: input.missionId });
  const events = snapshot.events;
  const created = readCreated(events, input);
  const existing = findMissionPinnedBinding(events);
  const registry = await ports.controller.readRunRequest({ requestId: created.requestId });
  if (registry === undefined) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      executor: created.executor,
      message: "The historical run registry entry required to prove this Mission is missing.",
    });
  }
  if (registry.missionId !== input.missionId || registry.payloadHash !== created.payloadHash) {
    throw storageCorruption("Mission created data conflicts with its run registry entry.");
  }
  validateAcceptedEvents(events, created, input.missionId);

  if (existing !== undefined) {
    validateExistingBinding(existing, created, input);
    const workspace = historicalWorkspace(created.workspace, input.missionId);
    const resolutionInput =
      existing.executor.source === "project"
        ? {
            ...input,
            project: input.project ?? {
              projectId: existing.executor.project.projectId,
              revision: existing.executor.project.revision,
            },
            expectedFingerprint: input.expectedFingerprint ?? existing.executor.project.fingerprint,
          }
        : input;
    const descriptor = await resolveHistoricalExecutor(
      ports,
      resolutionInput,
      created.executor,
      workspace,
    );
    if (!sameExecutorPin(existing.executor, executorPin(descriptor))) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_unprovable",
        missionId: input.missionId,
        executor: created.executor,
        message: "The exact current executor candidate does not match the pinned Mission anchor.",
      });
    }
    return { binding: existing, existing, created };
  }

  const workspace = historicalWorkspace(created.workspace, input.missionId);
  const descriptor = await resolveHistoricalExecutor(ports, input, created.executor, workspace);
  const payload = await reconstructCanonicalPayload({
    ports,
    missionId: input.missionId,
    created,
    descriptor,
    workspace,
  });
  const payloadHash = hashCanonicalRunPayload(payload);
  if (payloadHash !== created.payloadHash || payloadHash !== registry.payloadHash) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_unprovable",
      missionId: input.missionId,
      executor: created.executor,
      message: "The reconstructed historical payload hash does not match the M7 hash.",
    });
  }

  return {
    created,
    binding: {
      schemaVersion: "pragma.mission-pinned-binding/v1",
      requestId: created.requestId,
      payloadHash,
      command: commandForExecutor(created.executor),
      executor: executorPin(descriptor),
      workspace: {
        canonicalPath: workspace.canonicalPath,
        identityHash: workspace.identityHash,
      },
      provenance: "m7_payload_hash_backfill",
    },
  };
}

function readCreated(
  events: readonly MissionEvent[],
  input: MissionPinnedBindingBackfillInput,
): MissionCreatedData {
  const createdEvents = events.filter((event) => event.type === "mission.created");
  if (createdEvents.length === 0) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      message: "The historical Mission has no mission.created evidence to reconstruct.",
    });
  }
  if (createdEvents.length !== 1) {
    throw storageCorruption(
      "The historical Mission must contain exactly one mission.created event.",
    );
  }
  try {
    const created = MissionCreatedDataSchema.parse(createdEvents[0]!.data);
    if (created.requestId.length === 0 || created.payloadHash.length === 0)
      throw storageCorruption("The historical mission.created evidence is incomplete.");
    return created;
  } catch (error) {
    const parsed = IntegrationErrorSchema.safeParse(error);
    if (parsed.success) throw parsed.data;
    throw storageCorruption("The historical mission.created evidence is unreadable.");
  }
}

function validateBackfillInput(input: MissionPinnedBindingBackfillInput): void {
  if (input.missionId.trim() === "") {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Mission resume requires a Mission ID.",
    });
  }
  if (input.project !== undefined) {
    if (
      input.project.projectId.trim() === "" ||
      !Number.isInteger(input.project.revision) ||
      input.project.revision <= 0
    ) {
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "Mission resume requires a positive exact project revision.",
      });
    }
  } else if (input.expectedFingerprint !== undefined) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "--expected-fingerprint requires --project and --revision.",
    });
  }
  if (
    input.expectedFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/u.test(input.expectedFingerprint)
  ) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "--expected-fingerprint must be 64 lowercase hexadecimal characters.",
    });
  }
}

function validateExistingBinding(
  binding: MissionPinnedBinding,
  created: MissionCreatedData,
  input: MissionPinnedBindingBackfillInput,
): void {
  const workspace = historicalWorkspace(created.workspace, input.missionId);
  const expectedCommand = commandForExecutor(created.executor);
  if (
    binding.requestId !== created.requestId ||
    binding.payloadHash !== created.payloadHash ||
    binding.command !== expectedCommand ||
    !sameExecutorReference(binding.executor.ref, created.executor) ||
    binding.workspace.canonicalPath !== workspace.canonicalPath ||
    binding.workspace.identityHash !== workspace.identityHash
  ) {
    throw storageCorruption("The pinned binding conflicts with the historical Mission evidence.");
  }
  if (binding.executor.source === "built_in") {
    if (input.project !== undefined || input.expectedFingerprint !== undefined) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_unprovable",
        missionId: input.missionId,
        executor: created.executor,
        message: "The supplied project binding does not match the built-in Mission anchor.",
      });
    }
    return;
  }
  if (
    input.project !== undefined &&
    (binding.executor.project.projectId !== input.project.projectId ||
      binding.executor.project.revision !== input.project.revision)
  ) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_unprovable",
      missionId: input.missionId,
      executor: created.executor,
      message: "The supplied exact project revision does not match the Mission anchor.",
    });
  }
  if (
    input.expectedFingerprint !== undefined &&
    binding.executor.project.fingerprint !== input.expectedFingerprint
  ) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_unprovable",
      missionId: input.missionId,
      executor: created.executor,
      message: "The supplied project fingerprint does not match the Mission anchor.",
    });
  }
}

function validateAcceptedEvents(
  events: readonly MissionEvent[],
  created: MissionCreatedData,
  missionId: string,
): void {
  for (const event of events.filter((candidate) => candidate.type === "run.accepted")) {
    const accepted = RunAcceptedDataSchema.safeParse(event.data);
    if (!accepted.success) {
      throw storageCorruption("A run.accepted event is malformed.");
    }
    if (
      accepted.data.requestId !== created.requestId ||
      accepted.data.payloadHash !== created.payloadHash
    ) {
      throw storageCorruption("run.accepted conflicts with mission.created.");
    }
  }
  if (events.some((event) => event.missionId !== missionId)) {
    throw storageCorruption("Mission event ownership is inconsistent.");
  }
}

async function resolveHistoricalExecutor(
  ports: MissionPinnedBindingBackfillPorts,
  input: MissionPinnedBindingBackfillInput,
  ref: ExecutorReference,
  workspace: WorkspaceSelection,
): Promise<ExecutorDescriptor> {
  if (input.project === undefined) {
    let builtIn: { readonly descriptor: ExecutorDescriptor } | undefined;
    try {
      builtIn = await ports.builtInResolver?.({ ref, workspace });
    } catch (error) {
      throw mapExecutorResolutionError(error, input, ref, "mission_pinned_binding_required");
    }
    if (builtIn === undefined) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_required",
        missionId: input.missionId,
        executor: ref,
        message: "An exact project and revision are required to prove this historical executor.",
      });
    }
    let descriptor: ExecutorDescriptor;
    try {
      descriptor = ExecutorDescriptorSchema.parse(builtIn.descriptor);
    } catch (error) {
      throw mapExecutorResolutionError(error, input, ref);
    }
    if (descriptor.source !== "built_in" || !sameExecutorReference(descriptor.ref, ref)) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_unprovable",
        missionId: input.missionId,
        executor: ref,
        message: "The authoritative built-in executor does not match the historical Mission.",
      });
    }
    return descriptor;
  }

  let resolved: Awaited<ReturnType<MissionPinnedBindingBackfillPorts["catalog"]["resolve"]>>;
  try {
    resolved = await ports.catalog.resolve({
      ref,
      projectId: input.project.projectId,
      revision: input.project.revision,
      workspace,
    });
  } catch (error) {
    throw mapExecutorResolutionError(error, input, ref, "mission_pinned_binding_required");
  }
  if (resolved === undefined) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      executor: ref,
      message: "The requested exact project revision is unavailable.",
    });
  }
  let descriptor: ExecutorDescriptor;
  try {
    descriptor = ExecutorDescriptorSchema.parse(resolved.descriptor);
  } catch (error) {
    throw mapExecutorResolutionError(error, input, ref);
  }
  if (
    descriptor.source !== "project" ||
    descriptor.project === undefined ||
    !sameExecutorReference(descriptor.ref, ref) ||
    descriptor.project.projectId !== input.project.projectId ||
    descriptor.project.revision !== input.project.revision ||
    (input.expectedFingerprint !== undefined &&
      descriptor.project.fingerprint !== input.expectedFingerprint)
  ) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_unprovable",
      missionId: input.missionId,
      executor: ref,
      message: "The exact project revision does not match the historical executor binding.",
    });
  }
  return descriptor;
}

async function reconstructCanonicalPayload(input: {
  readonly ports: MissionPinnedBindingBackfillPorts;
  readonly missionId: string;
  readonly created: MissionCreatedData;
  readonly descriptor: ExecutorDescriptor;
  readonly workspace: WorkspaceSelection;
}): Promise<{
  readonly command: "team.run" | "expert.run" | "flow.run";
  readonly executor: ExecutorReference;
  readonly project?: {
    readonly projectId: string;
    readonly revision: number;
    readonly fingerprint: string;
  };
  readonly workspace: Pick<WorkspaceSelection, "canonicalPath" | "identityHash">;
  readonly prompt?: string;
  readonly input?: unknown;
}> {
  const command = commandForExecutor(input.created.executor);
  const project = input.descriptor.project === undefined ? undefined : input.descriptor.project;
  if (command === "flow.run") {
    let execution: Awaited<
      ReturnType<NonNullable<MissionPinnedBindingBackfillPorts["executions"]>["get"]>
    >;
    try {
      execution = await input.ports.executions?.get(input.missionId);
    } catch (error) {
      throw mapEvidenceReadError(error, input.missionId, input.created.executor);
    }
    if (execution === undefined || execution.executionId !== input.missionId) {
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_required",
        missionId: input.missionId,
        executor: input.created.executor,
        message: "The historical Flow execution input is unavailable.",
      });
    }
    if (execution.kind !== "flow") {
      throw storageCorruption("The historical Flow Mission points to a non-Flow execution.");
    }
    if (
      execution.definition.kind !== "flow" ||
      execution.definition.id !== input.created.executor.id
    ) {
      throw storageCorruption(
        "The historical Flow execution definition conflicts with its Mission.",
      );
    }
    return {
      command,
      executor: input.created.executor,
      ...(project === undefined ? {} : { project }),
      workspace: {
        canonicalPath: input.workspace.canonicalPath,
        identityHash: input.workspace.identityHash,
      },
      input: execution.input,
    };
  }

  let prompts:
    | Awaited<ReturnType<NonNullable<MissionPinnedBindingBackfillPorts["sessions"]>["listPrompts"]>>
    | undefined;
  try {
    prompts = await input.ports.sessions?.listPrompts(input.missionId);
  } catch (error) {
    throw mapEvidenceReadError(error, input.missionId, input.created.executor);
  }
  if (prompts === undefined) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      executor: input.created.executor,
      message: "The historical ExpertSession prompt store is unavailable.",
    });
  }
  const matches = prompts.filter((prompt) => prompt.requestId === input.created.requestId);
  if (matches.length === 0) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId: input.missionId,
      executor: input.created.executor,
      message: "The historical PromptRequest required to reconstruct this Mission is missing.",
    });
  }
  if (matches.length !== 1 || matches[0]!.sessionId !== input.missionId) {
    throw storageCorruption("The historical Mission does not have one unique owner PromptRequest.");
  }
  return {
    command,
    executor: input.created.executor,
    ...(project === undefined ? {} : { project }),
    workspace: {
      canonicalPath: input.workspace.canonicalPath,
      identityHash: input.workspace.identityHash,
    },
    prompt: matches[0]!.content,
  };
}

function historicalWorkspace(canonicalPath: string, missionId: string): WorkspaceSelection {
  if (!isAbsolute(canonicalPath)) {
    throw createPinnedBindingRecoveryError({
      reason: "mission_pinned_binding_required",
      missionId,
      message: "The historical workspace path is not an absolute canonical path.",
    });
  }
  return WorkspaceSelectionSchema.parse({
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: canonicalPath,
    canonicalPath,
    displayName: basename(canonicalPath) || canonicalPath,
    identityHash: `sha256:${createHash("sha256").update(canonicalPath).digest("hex")}`,
    access: { exists: true, readable: true, writable: true },
    source: "mission",
  });
}

function commandForExecutor(ref: ExecutorReference): "team.run" | "expert.run" | "flow.run" {
  return `${ref.kind}.run` as "team.run" | "expert.run" | "flow.run";
}

function executorPin(descriptor: ExecutorDescriptor): MissionPinnedBinding["executor"] {
  if (descriptor.source === "built_in") return { source: "built_in", ref: descriptor.ref };
  if (descriptor.source === "project" && descriptor.project !== undefined) {
    return { source: "project", ref: descriptor.ref, project: descriptor.project };
  }
  throw storageCorruption("Resolved executor has no supported pinned source.");
}

function sameExecutorReference(left: ExecutorReference, right: ExecutorReference): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameExecutorPin(
  left: MissionPinnedBinding["executor"],
  right: MissionPinnedBinding["executor"],
): boolean {
  if (left.source !== right.source || !sameExecutorReference(left.ref, right.ref)) return false;
  if (left.source === "built_in" || right.source === "built_in") return true;
  return (
    left.project.projectId === right.project.projectId &&
    left.project.revision === right.project.revision &&
    left.project.fingerprint === right.project.fingerprint
  );
}

function storageCorruption(message: string): never {
  throw createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message,
  });
}

function mapExecutorResolutionError(
  error: unknown,
  input: MissionPinnedBindingBackfillInput,
  ref: ExecutorReference,
  reason:
    | "mission_pinned_binding_required"
    | "mission_pinned_binding_unprovable" = "mission_pinned_binding_unprovable",
): never {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success && parsed.data.code === "STORAGE_CORRUPTED") throw parsed.data;
  throw createPinnedBindingRecoveryError({
    reason,
    missionId: input.missionId,
    executor: ref,
    message: "The exact historical executor candidate could not be validated.",
  });
}

function mapEvidenceReadError(
  error: unknown,
  missionId: string,
  executor: ExecutorReference,
): never {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success && parsed.data.code === "STORAGE_CORRUPTED") throw parsed.data;
  throw createPinnedBindingRecoveryError({
    reason: "mission_pinned_binding_required",
    missionId,
    executor,
    message: "The historical Core owner evidence is unavailable or unreadable.",
  });
}
