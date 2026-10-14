import { createHash } from "node:crypto";
import {
  createIntegrationError,
  ContentSelectorSchema,
  MissionContentReferenceSchema,
  MissionContentReadSchema,
  type ContentSelector,
} from "@pragma/shared/integration";

export function missionContentReference(
  missionId: string,
  source: ContentSelector["source"],
  id: string,
  value: unknown,
  maxBytes = 8_000,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64000)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Content reference budget must be 0..64000 bytes.",
    });
  const { bytes, encoding } = encodeContent(value);
  if (bytes.length <= maxBytes) return undefined;
  const range = maxBytes < 4 ? { content: "", end: 0 } : readUtf8(bytes, 0, maxBytes);
  return MissionContentReferenceSchema.parse({
    schemaVersion: "pragma.mission-content-reference/v1",
    missionId,
    source,
    id,
    fingerprint: hash(bytes),
    encoding,
    totalBytes: bytes.length,
    preview: range.content,
    end: range.end,
  });
}

export function readMissionContentValue(
  missionId: string,
  selector: ContentSelector,
  value: unknown,
) {
  const parsed = ContentSelectorSchema.safeParse(selector);
  if (!parsed.success)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Invalid content selector or UTF-8 byte range (max-bytes: 4..64000).",
    });
  const { bytes, encoding } = encodeContent(value);
  const validated = parsed.data;
  if (hash(bytes) !== validated.fingerprint)
    throw createIntegrationError({
      code: "CURSOR_EXPIRED",
      category: "conflict",
      message: "The referenced content changed. Query its new reference.",
    });
  const range = readUtf8(bytes, validated.start, validated.maxBytes);
  return MissionContentReadSchema.parse({
    schemaVersion: "pragma.mission-content/v1",
    missionId,
    source: validated.source,
    id: validated.id,
    fingerprint: validated.fingerprint,
    encoding,
    content: range.content,
    contentRange: {
      start: validated.start,
      end: range.end,
      totalBytes: bytes.length,
      ...(range.end < bytes.length ? { nextStart: range.end } : {}),
    },
  });
}
function readUtf8(bytes: Buffer, start: number, maxBytes: number) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > bytes.length ||
    (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
  )
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Content start must be a valid UTF-8 byte boundary.",
    });
  let end = Math.min(bytes.length, start + maxBytes);
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end === start && start < bytes.length)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Increase max-bytes to fit a UTF-8 character.",
    });
  return { content: bytes.subarray(start, end).toString("utf8"), end };
}
function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Compact mutation receipts preserve operation metadata while offloading the canonical execution result. */
export function boundMissionMutationResult(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const execution = result["execution"];
  if (
    typeof execution !== "object" ||
    execution === null ||
    Array.isArray(execution) ||
    !("result" in execution) ||
    execution.result === undefined ||
    !("executionId" in execution) ||
    typeof execution.executionId !== "string" ||
    typeof result["missionId"] !== "string"
  )
    return value;
  const reference = missionContentReference(
    result["missionId"],
    "result",
    execution.executionId,
    execution.result,
  );
  if (reference === undefined) return value;
  return {
    ...result,
    schemaVersion: "pragma.mutation-result/v2",
    execution: {
      ...Object.fromEntries(Object.entries(execution).filter(([key]) => key !== "result")),
      resultContent: reference,
    },
  };
}

export function missionContentIdentity(value: unknown): {
  fingerprint: string;
  encoding: "utf8" | "utf8-json";
} {
  const { bytes, encoding } = encodeContent(value);
  return { fingerprint: hash(bytes), encoding };
}
function encodeContent(value: unknown): { bytes: Buffer; encoding: "utf8" | "utf8-json" } {
  if (typeof value === "string" && Buffer.from(value, "utf8").toString("utf8") === value)
    return { bytes: Buffer.from(value, "utf8"), encoding: "utf8" };
  const text = JSON.stringify(value);
  if (text === undefined)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Mission content must be JSON serializable.",
    });
  return { bytes: Buffer.from(text, "utf8"), encoding: "utf8-json" };
}
