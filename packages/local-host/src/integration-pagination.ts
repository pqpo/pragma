import { createHash, timingSafeEqual } from "node:crypto";
import {
  createIntegrationError,
  ListPageRequestSchema,
  type ListPageRequest,
} from "@pragma/shared/integration";

const PREFIX = "p2.";
const PAYLOAD_BYTES = 70;

/** Stateless, cross-process pagination; changes expire rather than silently shift pages. */
export function paginateIntegrationItems<T>(
  items: readonly T[],
  request: ListPageRequest,
  scope: string,
  filters: unknown = {},
): {
  readonly schemaVersion: "pragma.list-page/v1";
  readonly items: T[];
  readonly nextCursor?: string;
} {
  const valid = ListPageRequestSchema.safeParse(request);
  if (!valid.success)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message:
        "List limit must be between 1 and 200, and cursor must be a bounded non-empty string.",
    });
  const scopeHash = digest([scope, filters]);
  const fingerprint = digest(items);
  let offset = 0;
  if (request.cursor !== undefined) {
    if (request.cursor.startsWith("pragma.cli.cursor.v2.")) {
      throw cursorError(
        "CURSOR_EXPIRED",
        "Legacy CLI cursors cannot prove list stability. Restart the query without --cursor.",
      );
    }
    if (!/^p2\.[A-Za-z0-9_-]{94}$/u.test(request.cursor)) throw cursorError("CURSOR_INVALID");
    const payload = Buffer.from(request.cursor.slice(PREFIX.length), "base64url");
    if (
      payload.length !== PAYLOAD_BYTES ||
      payload.toString("base64url") !== request.cursor.slice(PREFIX.length) ||
      !timingSafeEqual(payload.subarray(0, 32), scopeHash)
    )
      throw cursorError("CURSOR_INVALID");
    if (!timingSafeEqual(payload.subarray(32, 64), fingerprint))
      throw cursorError("CURSOR_EXPIRED");
    offset = payload.readUIntBE(64, 6);
    if (offset > items.length) throw cursorError("CURSOR_EXPIRED");
  }
  const page = items.slice(offset, offset + request.limit);
  const nextOffset = offset + page.length;
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  scopeHash.copy(payload, 0);
  fingerprint.copy(payload, 32);
  payload.writeUIntBE(nextOffset, 64, 6);
  return {
    schemaVersion: "pragma.list-page/v1",
    items: page,
    ...(nextOffset < items.length
      ? { nextCursor: `${PREFIX}${payload.toString("base64url")}` }
      : {}),
  };
}

function digest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function cursorError(code: "CURSOR_INVALID" | "CURSOR_EXPIRED", message?: string) {
  return createIntegrationError({
    code,
    category: "conflict",
    message:
      message ??
      (code === "CURSOR_EXPIRED"
        ? "The list changed. Restart the query without --cursor."
        : "The cursor is invalid for this query."),
  });
}
