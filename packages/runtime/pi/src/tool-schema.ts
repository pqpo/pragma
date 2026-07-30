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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
