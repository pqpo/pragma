import { isRecord, shellArgument } from "../commands/utils.ts";

/** A bounded authoring template, not a claim that placeholders pass arbitrary constraints. */
export function renderInputSchemaText(schema: unknown, kind: string, ref: string): string[] {
  if (schema === undefined) return [];
  const full = `FULL INPUT SCHEMA: pragma ${kind} describe ${shellArgument(ref)} --json`;
  if (!isRecord(schema)) return ["INPUT: consult the full Schema.", full];
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((key): key is string => typeof key === "string")
    : [];
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const lines = required.slice(0, 20).map((key) => {
    const field = properties[key];
    return `REQUIRED: ${key}; type=${isRecord(field) ? JSON.stringify(field["type"] ?? "see Schema") : "see Schema"}`;
  });
  if (required.length > 20)
    lines.push(`INPUT FIELDS TRUNCATED: ${required.length - 20} more; consult full Schema.`);
  const serialized = JSON.stringify(template(schema, 0));
  lines.push(
    serialized.length <= 4096
      ? `INPUT TEMPLATE (replace placeholders and validate against Schema): ${serialized}`
      : "INPUT TEMPLATE OMITTED: exceeds text budget; consult full Schema.",
    full,
  );
  return lines;
}

function template(schema: unknown, depth: number): unknown {
  if (
    !isRecord(schema) ||
    depth > 3 ||
    schema["$ref"] !== undefined ||
    schema["oneOf"] !== undefined ||
    schema["anyOf"] !== undefined
  )
    return "<see Schema>";
  if (schema["const"] !== undefined) return schema["const"];
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0];
  switch (schema["type"]) {
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
      const required = Array.isArray(schema["required"])
        ? schema["required"].filter((key): key is string => typeof key === "string")
        : [];
      return Object.fromEntries(
        required.slice(0, 20).map((key) => [key, template(properties[key], depth + 1)]),
      );
    }
    case "array":
      return [template(schema["items"], depth + 1)];
    case "boolean":
      return false;
    case "integer":
    case "number":
      return typeof schema["minimum"] === "number" ? schema["minimum"] : 0;
    case "null":
      return null;
    case "string":
      return "<string>";
    default:
      return "<see Schema>";
  }
}
