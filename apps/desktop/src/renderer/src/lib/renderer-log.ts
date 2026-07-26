const MAX_ERROR_MESSAGE_LENGTH = 8_192;
const MAX_STACK_LENGTH = 32_768;
const TRUNCATED_SUFFIX = "…[TRUNCATED]";

export function serializeRendererError(
  error: unknown,
  supplementalStack?: string | undefined,
): { readonly errorMessage: string; readonly stack?: string | undefined } {
  const errorMessage =
    error instanceof Error
      ? safelyReadString(error, "message", "An error occurred.")
      : safelyConvertToString(error);
  const primaryStack =
    error instanceof Error ? safelyReadString(error, "stack", undefined) : undefined;
  const stack = [primaryStack, supplementalStack].filter(isNonEmptyString).join("\n");

  return {
    errorMessage: truncate(errorMessage, MAX_ERROR_MESSAGE_LENGTH),
    ...(stack === "" ? {} : { stack: truncate(stack, MAX_STACK_LENGTH) }),
  };
}

function safelyReadString<T extends string | undefined>(
  value: object,
  key: PropertyKey,
  fallback: T,
): string | T {
  try {
    const result = Reflect.get(value, key);
    return typeof result === "string" ? result : fallback;
  } catch {
    return fallback;
  }
}

function safelyConvertToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}
