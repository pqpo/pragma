/** Readers for existing persisted Host bindings. Identity creation remains at the Host surface. */
function decode(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.length > 0 && Buffer.from(decoded, "utf8").toString("base64url") === value
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseLocalHostCapabilityBindingRef(ref: string): string | undefined {
  const encoded = /^binding:desktop-capability\.([A-Za-z0-9_-]+)$/.exec(ref)?.[1];
  return encoded === undefined ? undefined : decode(encoded);
}

export function parseLegacyLocalHostCapabilityBindingRef(
  ref: string,
): { readonly id: string; readonly revision: number } | undefined {
  const match = /^binding:desktop-capability\.([A-Za-z0-9_-]+)\.(\d+)$/.exec(ref);
  if (match === null) return undefined;
  const id = decode(match[1]!);
  const revision = Number(match[2]);
  return id === undefined || !Number.isSafeInteger(revision) || revision < 1
    ? undefined
    : { id, revision };
}

export function parseLocalHostContextBindingRef(ref: string): string | undefined {
  const encoded = /^binding:desktop-context\.([A-Za-z0-9_-]+)$/.exec(ref)?.[1];
  return encoded === undefined ? undefined : decode(encoded);
}
