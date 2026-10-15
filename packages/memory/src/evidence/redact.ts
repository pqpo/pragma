export function redactMemoryValue(value: unknown): unknown {
  if (typeof value === "string") {
    return (
      value
        // Include unterminated blocks: previews may end before the closing delimiter.
        .replace(
          /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
          "[REDACTED_PRIVATE_KEY]",
        )
        .replace(
          /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
          "[REDACTED_CREDENTIAL]",
        )
        .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_CREDENTIAL]")
        .replace(
          /((?:\b(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key))["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer\s+)?[^\s,;}]+)/gi,
          "$1[REDACTED_CREDENTIAL]",
        )
        .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_CREDENTIAL]")
    );
  }
  if (Array.isArray(value)) return value.map(redactMemoryValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)$/iu.test(
        key,
      )
        ? "[REDACTED_CREDENTIAL]"
        : redactMemoryValue(item),
    ]),
  );
}
