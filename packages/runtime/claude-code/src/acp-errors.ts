import { z } from "zod";

export class ClaudeAcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ClaudeAcpError";
  }
}

const failureSchema = z.object({
  category: z.enum(["connection", "access", "limit", "request", "service", "unknown"]),
  severity: z.enum(["warning", "error"]),
  title: z.string(),
  details: z.string().optional(),
  actions: z.array(z.string()),
});
const metadataSchema = z.object({
  jetbrains: z.object({ air: z.object({ sessionFailure: failureSchema }) }),
});

/** Pinned worker's negotiated AIR sessionFailure metadata, never model prose. */
export function claudePromptError(meta: unknown): ClaudeAcpError | undefined {
  const parsed = metadataSchema.safeParse(meta);
  if (!parsed.success) return undefined;
  const failure = parsed.data.jetbrains.air.sessionFailure;
  if (failure.severity !== "error") return undefined;
  const message = [failure.title, failure.details].filter(Boolean).join("\n");
  if (failure.category === "access")
    return new ClaudeAcpError(
      message,
      failure.actions.includes("login") ? "runtime.auth_invalid" : "runtime.access_denied",
      false,
    );
  if (failure.category === "limit") {
    if (failure.actions.includes("retry"))
      return new ClaudeAcpError(message, "runtime.rate_limited", true, 429);
    return new ClaudeAcpError(
      message,
      failure.actions.includes("new_session")
        ? "runtime.context_exhausted"
        : "runtime.quota_exhausted",
      false,
    );
  }
  return new ClaudeAcpError(
    message,
    failure.category === "request" ? "runtime.bad_request" : "runtime.process_failed",
    failure.actions.includes("retry") || failure.category === "connection",
  );
}

/** Structured errors win; bounded stderr is a fallback for a crashed worker. */
export function normalizeClaudeAcpError(error: unknown, stderr = ""): Error {
  if (error instanceof ClaudeAcpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const combined = [message, stderr.trim()].filter(Boolean).join("\n");
  const value = combined.toLowerCase();
  const authRequired =
    typeof error === "object" && error !== null && "code" in error && error.code === -32000;
  if (
    authRequired ||
    /invalid (?:api key|x-api-key)|incorrect api key|authentication|unauthorized/u.test(value)
  )
    return new ClaudeAcpError(combined, "runtime.auth_invalid", false, 401, error);
  if (/429|rate[ _-]?limit|too many requests/u.test(value))
    return new ClaudeAcpError(combined, "runtime.rate_limited", true, 429, error);
  return new ClaudeAcpError(combined, "runtime.process_failed", true, undefined, error);
}
