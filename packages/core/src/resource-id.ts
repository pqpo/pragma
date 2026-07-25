import { createHash, randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const PRAGMA_RESOURCE_ID_BYTES = 10;

export function generatePragmaResourceId(): string {
  return encodePragmaResourceId(randomBytes(PRAGMA_RESOURCE_ID_BYTES));
}

export function derivePragmaResourceId(seed: string): string {
  return encodePragmaResourceId(
    createHash("sha256").update(seed).digest().subarray(0, PRAGMA_RESOURCE_ID_BYTES),
  );
}

function encodePragmaResourceId(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD_BASE32[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += CROCKFORD_BASE32[(value << (5 - bits)) & 31];
  return encoded;
}
