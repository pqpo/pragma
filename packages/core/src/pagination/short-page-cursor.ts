import { createHash, timingSafeEqual } from "node:crypto";
import { AGENT_PAGE_CURSOR_MAX_LENGTH } from "@pragma/shared/integration";

const PREFIX = "p1.";
const ANCHOR_PREFIX = "a1.";
const DIGEST_BYTES = 12;
const OFFSET_BYTES = 6;
const PAYLOAD_BYTES = DIGEST_BYTES * 2 + OFFSET_BYTES;
const MAX_OFFSET = 2 ** (OFFSET_BYTES * 8) - 1;

export const SHORT_PAGE_CURSOR_MAX_LENGTH = AGENT_PAGE_CURSOR_MAX_LENGTH;

export type ShortPageCursorErrorCode = "cursor_invalid" | "cursor_expired";

export class ShortPageCursorError extends Error {
  constructor(readonly code: ShortPageCursorErrorCode) {
    super(code);
    this.name = "ShortPageCursorError";
  }
}

export interface ShortPageCursorBinding {
  readonly scope: string;
  readonly filters: unknown;
  readonly fingerprint: unknown;
}

export function isShortPageCursor(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Keep keyset pagination tied to its last item without exposing a variable-length ID. */
export function encodeShortPageAnchor(id: string): string {
  return `${ANCHOR_PREFIX}${createHash("sha256").update(id, "utf8").digest().subarray(0, 16).toString("base64url")}`;
}

export function findPageAnchorIndex<T>(
  items: readonly T[],
  cursor: string | undefined,
  idOf: (item: T) => string,
): number {
  if (cursor === undefined) return -1;
  const legacyIndex = items.findIndex((item) => idOf(item) === cursor);
  if (legacyIndex >= 0) return legacyIndex;
  if (!/^a1\.[A-Za-z0-9_-]{22}$/u.test(cursor)) return -1;
  return items.findIndex((item) => encodeShortPageAnchor(idOf(item)) === cursor);
}

export function encodeShortPageCursor(binding: ShortPageCursorBinding, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new RangeError("Page cursor offset is out of range.");
  }
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  scopeDigest(binding).copy(payload, 0);
  fingerprintDigest(binding).copy(payload, DIGEST_BYTES);
  payload.writeUIntBE(offset, DIGEST_BYTES * 2, OFFSET_BYTES);
  const cursor = `${PREFIX}${payload.toString("base64url")}`;
  if (cursor.length > SHORT_PAGE_CURSOR_MAX_LENGTH) {
    throw new RangeError("Page cursor exceeds its length limit.");
  }
  return cursor;
}

export function decodeShortPageCursor(value: string, binding: ShortPageCursorBinding): number {
  if (value.length > SHORT_PAGE_CURSOR_MAX_LENGTH || !/^p1\.[A-Za-z0-9_-]{40}$/u.test(value)) {
    throw new ShortPageCursorError("cursor_invalid");
  }
  const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (
    payload.length !== PAYLOAD_BYTES ||
    payload.toString("base64url") !== value.slice(PREFIX.length) ||
    !timingSafeEqual(payload.subarray(0, DIGEST_BYTES), scopeDigest(binding))
  ) {
    throw new ShortPageCursorError("cursor_invalid");
  }
  if (
    !timingSafeEqual(payload.subarray(DIGEST_BYTES, DIGEST_BYTES * 2), fingerprintDigest(binding))
  ) {
    throw new ShortPageCursorError("cursor_expired");
  }
  return payload.readUIntBE(DIGEST_BYTES * 2, OFFSET_BYTES);
}

function scopeDigest(binding: ShortPageCursorBinding): Buffer {
  return digest([binding.scope, binding.filters]);
}

function fingerprintDigest(binding: ShortPageCursorBinding): Buffer {
  return digest(binding.fingerprint);
}

function digest(value: unknown): Buffer {
  return createHash("sha256")
    .update(JSON.stringify([value]), "utf8")
    .digest()
    .subarray(0, DIGEST_BYTES);
}
