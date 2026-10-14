import type { JsonValue } from "@pragma/shared/integration";

export interface HostPage {
  readonly items: readonly unknown[];
  readonly nextCursor?: string | undefined;
  readonly hostPaged: boolean;
}

export function asJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Value is not JSON serializable.");
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new Error("The Local Host returned a value that is not JSON serializable.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hostPage(value: unknown, itemKeys: readonly string[] = ["items"]): HostPage {
  if (Array.isArray(value)) return { items: value, hostPaged: false };
  if (!isRecord(value)) throw new Error("The Local Host returned an invalid list result.");
  for (const key of itemKeys) {
    const items = value[key];
    if (!Array.isArray(items)) continue;
    const nextCursor = value["nextCursor"];
    if (nextCursor !== undefined && value["schemaVersion"] !== "pragma.list-page/v1")
      throw new Error("A paged Host result must declare pragma.list-page/v1.");
    return {
      items,
      hostPaged: value["schemaVersion"] === "pragma.list-page/v1",
      ...(typeof nextCursor === "string" ? { nextCursor } : {}),
    };
  }
  throw new Error("The Local Host returned a list result without items.");
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

export function arrayField(value: unknown, key: string): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
