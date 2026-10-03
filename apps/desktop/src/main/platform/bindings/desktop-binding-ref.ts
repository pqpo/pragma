import type { PragmaBindingRef } from "@pragma/interpreter/ast";
export {
  parseLocalHostCapabilityBindingRef as parseDesktopCapabilityBindingRef,
  parseLegacyLocalHostCapabilityBindingRef as parseLegacyDesktopCapabilityBindingRef,
  parseLocalHostContextBindingRef as parseDesktopContextBindingRef,
} from "@pragma/local-host/resources";

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

export function desktopCapabilityBindingRef(id: string): PragmaBindingRef {
  return `binding:desktop-capability.${encode(id)}` as PragmaBindingRef;
}

export function desktopContextBindingRef(id: string): PragmaBindingRef {
  return `binding:desktop-context.${encode(id)}` as PragmaBindingRef;
}

export function desktopModelProviderBindingRef(id: string): PragmaBindingRef {
  return `binding:desktop-model-provider.${encode(id)}` as PragmaBindingRef;
}

export function parseDesktopModelProviderBindingRef(ref: string): string | undefined {
  const encoded = /^binding:desktop-model-provider\.([A-Za-z0-9_-]+)$/.exec(ref)?.[1];
  return encoded === undefined ? undefined : decode(encoded);
}
