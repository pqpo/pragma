import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function normalizeInputSchema(schema: unknown): ToolDefinition["parameters"] {
  if (isRecord(schema) && schema.type === "object") {
    return schema as ToolDefinition["parameters"];
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as ToolDefinition["parameters"];
}

export function formatMcpToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const textParts = result.content
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined))
      .filter((entry): entry is string => entry !== undefined);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.length === 0 ? "tool" : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
