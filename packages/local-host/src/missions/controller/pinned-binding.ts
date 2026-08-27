import {
  createIntegrationError,
  ExecutorReferenceSchema,
  PayloadHashSchema,
  RequestIdSchema,
  type ExecutorReference,
  type IntegrationError,
} from "@pragma/shared/integration";
import { z } from "zod";

import type { MissionEvent } from "./schemas.ts";

export const MISSION_PINNED_BINDING_EVENT_TYPE = "mission.binding.pinned" as const;
export const MISSION_PINNED_BINDING_SCHEMA_VERSION = "pragma.mission-pinned-binding/v1" as const;

const ProjectBindingSchema = z
  .object({
    projectId: z.string().trim().min(1),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const ExecutorPinSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("built_in"),
      ref: ExecutorReferenceSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("project"),
      ref: ExecutorReferenceSchema,
      project: ProjectBindingSchema,
    })
    .strict(),
]);

export const MissionPinnedBindingSchema = z
  .object({
    schemaVersion: z.literal(MISSION_PINNED_BINDING_SCHEMA_VERSION),
    requestId: RequestIdSchema,
    payloadHash: PayloadHashSchema,
    command: z.enum(["team.run", "expert.run", "flow.run"]),
    executor: ExecutorPinSchema,
    workspace: z
      .object({
        canonicalPath: z.string().min(1),
        identityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    provenance: z.enum(["new_run", "m7_payload_hash_backfill"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedKind = value.command.slice(0, value.command.indexOf("."));
    if (value.executor.ref.kind !== expectedKind) {
      context.addIssue({
        code: "custom",
        path: ["executor", "ref", "kind"],
        message: `Executor kind must match command ${value.command}.`,
      });
    }
  });

export type MissionPinnedBinding = z.infer<typeof MissionPinnedBindingSchema>;
export type MissionPinnedBindingExecutor = MissionPinnedBinding["executor"];

export type MissionPinnedBindingFailureReason =
  "mission_pinned_binding_required" | "mission_pinned_binding_unprovable";

export function createMissionPinnedBinding(
  input: Omit<MissionPinnedBinding, "schemaVersion">,
): MissionPinnedBinding {
  return MissionPinnedBindingSchema.parse({
    schemaVersion: MISSION_PINNED_BINDING_SCHEMA_VERSION,
    ...input,
  });
}

/**
 * Parse only the current pin contract. A future pin is deliberately distinct
 * from malformed current data so callers can fail closed with the stable
 * storage-version diagnostic instead of silently ignoring the anchor.
 */
export function parseMissionPinnedBindingData(value: unknown): MissionPinnedBinding {
  if (
    isRecord(value) &&
    "schemaVersion" in value &&
    value.schemaVersion !== MISSION_PINNED_BINDING_SCHEMA_VERSION
  ) {
    throw unsupportedPinnedBindingError({ reason: "mission_pinned_binding_required" });
  }
  try {
    return MissionPinnedBindingSchema.parse(value);
  } catch (error) {
    if (isIntegrationError(error)) throw error;
    throw createIntegrationError({
      code: "STORAGE_CORRUPTED",
      category: "protocol",
      message: "The Mission pinned binding event is malformed.",
    });
  }
}

export function findMissionPinnedBinding(
  events: readonly Pick<MissionEvent, "type" | "data">[],
): MissionPinnedBinding | undefined {
  let binding: MissionPinnedBinding | undefined;
  for (const event of events) {
    if (event.type !== MISSION_PINNED_BINDING_EVENT_TYPE) continue;
    const candidate = parseMissionPinnedBindingData(event.data);
    if (binding === undefined) {
      binding = candidate;
      continue;
    }
    if (!sameMissionPinnedBinding(binding, candidate)) {
      throw createIntegrationError({
        code: "STORAGE_CORRUPTED",
        category: "protocol",
        message: "A Mission contains conflicting pinned binding anchors.",
      });
    }
  }
  return binding;
}

export function sameMissionPinnedBinding(
  left: MissionPinnedBinding,
  right: MissionPinnedBinding,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Pinned bindings are permanent identity anchors and must survive compaction. */
export function isPermanentMissionEventType(type: string): boolean {
  return type === MISSION_PINNED_BINDING_EVENT_TYPE;
}

export function createPinnedBindingRecoveryError(input: {
  readonly reason: MissionPinnedBindingFailureReason;
  readonly missionId: string;
  readonly executor?: ExecutorReference | undefined;
  readonly message?: string | undefined;
}): IntegrationError {
  return createIntegrationError({
    code: "STORAGE_VERSION_UNSUPPORTED",
    category: "protocol",
    message:
      input.message ??
      (input.reason === "mission_pinned_binding_required"
        ? "This Mission requires an exact pinned executor binding before it can be resumed."
        : "The historical executor binding cannot be proven from the Mission data."),
    details: {
      reason: input.reason,
      missionId: input.missionId,
      ...(input.executor === undefined ? {} : { executor: input.executor }),
      requiredOptions: ["--project", "--revision"],
    },
  });
}

export function unsupportedPinnedBindingError(input: {
  readonly reason: MissionPinnedBindingFailureReason;
  readonly missionId?: string | undefined;
  readonly executor?: ExecutorReference | undefined;
}): IntegrationError {
  return createIntegrationError({
    code: "STORAGE_VERSION_UNSUPPORTED",
    category: "protocol",
    message: "The Mission pinned binding version cannot be read safely.",
    details: {
      reason: input.reason,
      ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
      ...(input.executor === undefined ? {} : { executor: input.executor }),
      requiredOptions: ["--project", "--revision"],
    },
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegrationError(value: unknown): value is IntegrationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === "pragma.integration-error/v1"
  );
}
