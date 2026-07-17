import type { PragmaBindingRef } from "@pragma/interpreter/ast";

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.length > 0 && encode(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function desktopCapabilityBindingRef(id: string, revision: number): PragmaBindingRef {
  return `binding:desktop-capability.${encode(id)}.${revision}` as PragmaBindingRef;
}

export function parseDesktopCapabilityBindingRef(
  ref: string,
): { readonly id: string; readonly revision: number } | undefined {
  const match = /^binding:desktop-capability\.([A-Za-z0-9_-]+)\.(\d+)$/.exec(ref);
  if (match === null) return undefined;
  const id = decode(match[1]!);
  const revision = Number(match[2]);
  return id === undefined || !Number.isSafeInteger(revision) ? undefined : { id, revision };
}

export function desktopContextBindingRef(id: string): PragmaBindingRef {
  return `binding:desktop-context.${encode(id)}` as PragmaBindingRef;
}

export function parseDesktopContextBindingRef(ref: string): string | undefined {
  const encoded = /^binding:desktop-context\.([A-Za-z0-9_-]+)$/.exec(ref)?.[1];
  return encoded === undefined ? undefined : decode(encoded);
}

export function desktopModelProviderBindingRef(id: string): PragmaBindingRef {
  return `binding:desktop-model-provider.${encode(id)}` as PragmaBindingRef;
}

export function parseDesktopModelProviderBindingRef(ref: string): string | undefined {
  const encoded = /^binding:desktop-model-provider\.([A-Za-z0-9_-]+)$/.exec(ref)?.[1];
  return encoded === undefined ? undefined : decode(encoded);
}
