import { ZodError } from "zod";
import {
  MemoryExtractionFailureDiagnosticSchema,
  MemoryExtractionOutputDiagnosticSchema,
  type MemoryExtractionFailureDiagnostic,
  type MemoryExtractionFailurePhase,
} from "@pragma/shared";

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,199}$/;

export function extractionErrorCode(
  error: unknown,
  family:
    "episodic_extraction" | "semantic_extraction" | "knowledge_extraction" | "skill_extraction",
): string {
  if (error instanceof ZodError) return `${family}_validation_failed`;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      const normalized = code.trim().toLowerCase();
      if (STABLE_ERROR_CODE.test(normalized)) return normalized;
    }
  }
  if (error instanceof Error) {
    const prefix = error.message.split(":", 1)[0]?.trim().toLowerCase();
    if (prefix !== undefined && STABLE_ERROR_CODE.test(prefix)) return prefix;
  }
  return `${family}_failed`;
}

export function extractionFailureDiagnostic(
  error: unknown,
  family:
    "episodic_extraction" | "semantic_extraction" | "knowledge_extraction" | "skill_extraction",
  input: {
    readonly phase: MemoryExtractionFailurePhase;
    readonly startedAt?: Date | undefined;
    readonly now: Date;
  },
): { readonly diagnostic: MemoryExtractionFailureDiagnostic; readonly stack?: string | undefined } {
  const metadata = errorMetadata(error);
  const code = extractionErrorCode(error, family);
  const phase = code.endsWith("_output_invalid")
    ? "output_parse"
    : code.endsWith("_validation_failed")
      ? "validation"
      : input.phase;
  const message = sanitizeDiagnosticText(errorMessage(error, code), 4_096);
  const endpoint = sanitizeEndpoint(metadata.endpoint);
  const httpStatus = readHttpStatus(metadata);
  const requestId = readString(metadata.requestId);
  const runtimeId = readString(metadata.runtimeId);
  const providerId = readString(metadata.providerId);
  const modelId = readString(metadata.modelId);
  const output = MemoryExtractionOutputDiagnosticSchema.safeParse(metadata.outputDiagnostic);
  const startedAt = metadata.startedAt instanceof Date ? metadata.startedAt : input.startedAt;
  const durationMs = readFiniteNumber(metadata.durationMs);
  const diagnostic = MemoryExtractionFailureDiagnosticSchema.parse({
    schemaVersion: "pragma.memory-extraction-failure/v1",
    code,
    message: message === "" ? code : message,
    phase,
    failedAt: input.now.toISOString(),
    ...(startedAt === undefined ? {} : { startedAt: startedAt.toISOString() }),
    ...(durationMs === undefined
      ? startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, input.now.getTime() - startedAt.getTime()) }
      : { durationMs }),
    ...(typeof metadata.retryable !== "boolean" ? {} : { retryable: metadata.retryable }),
    ...(runtimeId === undefined
      ? {}
      : {
          runtime: {
            runtimeId,
            ...(providerId === undefined ? {} : { providerId }),
            ...(modelId === undefined ? {} : { modelId }),
            ...(endpoint === undefined ? {} : { endpoint }),
          },
        }),
    ...(httpStatus === undefined && requestId === undefined
      ? {}
      : {
          transport: {
            ...(httpStatus === undefined ? {} : { httpStatus }),
            ...(requestId === undefined
              ? {}
              : { requestId: sanitizeDiagnosticText(requestId, 500) }),
          },
        }),
    ...(output.success ? { output: output.data } : {}),
  });
  const stack = readString(metadata.stack);
  return {
    diagnostic,
    ...(stack === undefined ? {} : { stack: sanitizeDiagnosticText(stack, 8_192) }),
  };
}

function errorMetadata(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const cause =
    typeof record.cause === "object" && record.cause !== null
      ? (record.cause as Record<string, unknown>)
      : {};
  const definedOuterEntries = Object.entries(record).filter(([, value]) => value !== undefined);
  return {
    ...cause,
    ...Object.fromEntries(definedOuterEntries),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };
}

function errorMessage(error: unknown, code: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    const cause = (error as Error & { readonly cause?: unknown }).cause;
    if ((message === "" || message === code) && cause instanceof Error) return cause.message;
    return message === "" ? code : message;
  }
  return typeof error === "string" && error.trim() !== "" ? error : code;
}

function readHttpStatus(record: Record<string, unknown>): number | undefined {
  for (const key of ["httpStatus", "statusCode", "status"] as const) {
    const value = readFiniteNumber(record[key]);
    if (value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599)
      return value;
  }
  return undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function sanitizeEndpoint(value: unknown): string | undefined {
  const endpoint = readString(value);
  if (endpoint === undefined) return undefined;
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return undefined;
  }
}

function sanitizeDiagnosticText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)=([^\s&]+)/giu, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^\s&#]+/giu, "$1[REDACTED]");
  const sanitized = [...redacted]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint > 31 && codePoint !== 127)
      );
    })
    .join("")
    .trim();
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}
