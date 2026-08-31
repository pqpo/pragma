import { createHash } from "node:crypto";

import type { JsonValue } from "@pragma/local-host/wire";

export interface HostPage {
  readonly items: readonly unknown[];
  readonly nextCursor?: string | undefined;
  readonly hostPaged: boolean;
}

const CURSOR_PREFIX = "pragma.cli.cursor.v2.";

export interface CursorScope {
  readonly command: string;
  readonly filters?: Readonly<Record<string, string | number | boolean | undefined>>;
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
    return {
      items,
      hostPaged: true,
      ...(typeof nextCursor === "string" ? { nextCursor } : {}),
    };
  }
  throw new Error("The Local Host returned a list result without items.");
}

export function pageItems<T>(
  items: readonly T[],
  limit: number,
  cursor: string | undefined,
  scope: CursorScope,
): { readonly items: readonly T[]; readonly nextCursor?: string | undefined } {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, scope);
  if (offset > items.length) throw new Error("Cursor is beyond the end of the result set.");
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset, scope) } : {}),
  };
}

export function decodeCursor(cursor: string, scope: CursorScope): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("Invalid cursor.");
  try {
    const raw = Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed["offset"] !== "number" ||
      parsed["command"] !== scope.command ||
      parsed["queryHash"] !== cursorQueryHash(scope)
    ) {
      throw new Error();
    }
    const offset = parsed["offset"];
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error();
    return offset;
  } catch {
    throw new Error("Invalid cursor.");
  }
}

function encodeCursor(offset: number, scope: CursorScope): string {
  return `${CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({
      offset,
      command: scope.command,
      queryHash: cursorQueryHash(scope),
    }),
    "utf8",
  ).toString("base64url")}`;
}

function cursorQueryHash(scope: CursorScope): string {
  const filters = Object.entries(scope.filters ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ command: scope.command, filters }), "utf8")
    .digest("hex");
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
