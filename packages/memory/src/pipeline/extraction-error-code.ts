import { ZodError } from "zod";

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,199}$/;

export function extractionErrorCode(
  error: unknown,
  family: "episodic_extraction" | "semantic_extraction",
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
