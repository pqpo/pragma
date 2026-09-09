import { createHash } from "node:crypto";

interface CursorPayload {
  readonly version: 1;
  readonly scope: string;
  readonly fingerprint: string;
  readonly filterHash: string;
  readonly offset: number;
}

export function paginateManagementItems<T>(input: {
  readonly items: readonly T[];
  readonly scope: string;
  readonly fingerprintValue: unknown;
  readonly filters: unknown;
  readonly cursor?: string | undefined;
  readonly limit: number;
}): { readonly items: T[]; readonly nextCursor?: string | undefined } {
  const fingerprint = digest(input.fingerprintValue);
  const filterHash = digest(input.filters);
  const offset =
    input.cursor === undefined
      ? 0
      : decodeCursor(input.cursor, input.scope, fingerprint, filterHash).offset;
  if (offset > input.items.length) throw managementCursorError("cursor_expired");
  const items = [...input.items.slice(offset, offset + input.limit)];
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < input.items.length
      ? {
          nextCursor: encodeCursor({
            version: 1,
            scope: input.scope,
            fingerprint,
            filterHash,
            offset: nextOffset,
          }),
        }
      : {}),
  };
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  scope: string,
  fingerprint: string,
  filterHash: string,
): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw managementCursorError("cursor_invalid");
  }
  if (!isCursorPayload(parsed) || parsed.scope !== scope || parsed.filterHash !== filterHash) {
    throw managementCursorError("cursor_invalid");
  }
  if (parsed.fingerprint !== fingerprint) throw managementCursorError("cursor_expired");
  return parsed;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { scope?: unknown }).scope === "string" &&
    typeof (value as { fingerprint?: unknown }).fingerprint === "string" &&
    typeof (value as { filterHash?: unknown }).filterHash === "string" &&
    Number.isInteger((value as { offset?: unknown }).offset) &&
    Number((value as { offset: number }).offset) >= 0
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function managementCursorError(code: "cursor_invalid" | "cursor_expired"): Error {
  const error = new Error(code);
  error.name = "PragmaManagementCursorError";
  return error;
}
