import { createHash } from "node:crypto";

import { MissionCommandKindSchema, type MissionCommand } from "@pragma/shared/integration";

type MissionCommandKind = MissionCommand["kind"];
type PayloadHash = string;

/**
 * The semantic input used for Mission command idempotency.
 *
 * Request metadata, presentation flags, wait/detach settings, timeout values,
 * and the CLI instance are deliberately outside this object. Strict target
 * fields are included; targetFencingToken is accepted as input metadata but is
 * not emitted, because Local Host captures that fencing value inside the
 * aggregate lock.
 */
export interface CanonicalMissionCommandPayloadInput {
  readonly missionId: string;
  readonly kind: MissionCommandKind;
  readonly target?: MissionCommand["target"] | undefined;
  readonly payload: MissionCommand["payload"];
  readonly targetFencingToken?: MissionCommand["targetFencingToken"] | undefined;
}

export type CanonicalMissionCommandPayload = {
  readonly missionId: string;
  readonly kind: MissionCommandKind;
  readonly target?: MissionCommand["target"] | undefined;
  readonly payload: MissionCommand["payload"];
};

export interface CanonicalMissionResumePayloadInput {
  readonly missionId: string;
  readonly project?:
    | {
        readonly projectId: string;
        readonly revision: number;
      }
    | undefined;
  readonly expectedFingerprint?: string | undefined;
}

export function canonicalizeMissionCommandPayload(
  input: CanonicalMissionCommandPayloadInput,
): CanonicalMissionCommandPayload {
  const kind = MissionCommandKindSchema.parse(input.kind);
  const payload = normalizeCommandPayload(input.payload);
  return sortJsonObject({
    missionId: input.missionId,
    kind,
    ...(input.target === undefined ? {} : { target: canonicalizeTarget(input.target) }),
    payload,
  }) as CanonicalMissionCommandPayload;
}

export function canonicalMissionCommandPayloadJson(
  input: CanonicalMissionCommandPayloadInput,
): string {
  return JSON.stringify(canonicalizeMissionCommandPayload(input));
}

export function hashMissionCommandPayload(input: CanonicalMissionCommandPayloadInput): PayloadHash {
  return `sha256:${createHash("sha256")
    .update(canonicalMissionCommandPayloadJson(input), "utf8")
    .digest("hex")}` as PayloadHash;
}

/**
 * Resume is a Host recovery operation rather than a MissionCommand kind.  It
 * still uses the same canonical JSON rules so a repeated requestId can be
 * compared without including presentation flags or owner metadata.
 */
export function canonicalMissionResumePayloadJson(
  input: CanonicalMissionResumePayloadInput,
): string {
  return JSON.stringify(
    sortJsonObject({
      missionId: input.missionId,
      kind: "resume",
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.expectedFingerprint === undefined
        ? {}
        : { expectedFingerprint: input.expectedFingerprint }),
    }),
  );
}

export function hashMissionResumePayload(input: CanonicalMissionResumePayloadInput): PayloadHash {
  return `sha256:${createHash("sha256")
    .update(canonicalMissionResumePayloadJson(input), "utf8")
    .digest("hex")}` as PayloadHash;
}

/** Aliases kept next to the canonical names for callers that use the M7 term. */
export const canonicalCommandPayloadJson = canonicalMissionCommandPayloadJson;
export const hashCanonicalCommandPayload = hashMissionCommandPayload;

function normalizeCommandPayload(payload: MissionCommand["payload"]): MissionCommand["payload"] {
  if (
    payload.kind === "send" ||
    payload.kind === "steer" ||
    (payload.kind === "queue.steer" && payload.input !== undefined)
  ) {
    return {
      ...payload,
      input: {
        prompt: normalizePrompt(payload.input!.prompt),
        attachments: [...(payload.input!.attachments ?? [])],
      },
    };
  }
  return sortJsonObject(payload) as MissionCommand["payload"];
}

function normalizePrompt(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/** Normalize the actual prompt sent to Core, not only the idempotency hash. */
export const normalizeMissionPrompt = normalizePrompt;

function canonicalizeTarget(target: NonNullable<MissionCommand["target"]>): unknown {
  return sortJsonObject(target);
}

function sortJsonObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonObject);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonObject(item)]),
  );
}
