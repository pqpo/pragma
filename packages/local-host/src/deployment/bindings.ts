import {
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
  type PragmaCapabilityResource,
  type PragmaContextStoreResource,
  type PragmaBindingRef,
} from "@pragma/interpreter/ast";
import {
  parseLocalHostCapabilityBindingRef,
  parseLegacyLocalHostCapabilityBindingRef,
  parseLocalHostContextBindingRef,
} from "../resources/binding-reader.ts";
export {
  parseLocalHostCapabilityBindingRef as parseDesktopCapabilityBindingRef,
  parseLegacyLocalHostCapabilityBindingRef as parseLegacyDesktopCapabilityBindingRef,
  parseLocalHostContextBindingRef as parseDesktopContextBindingRef,
};
// These prefixes and the metadata tag are existing persisted wire values, not identity allocation policy.
export const desktopCapabilityBindingRef = (id: string): PragmaBindingRef =>
  `binding:desktop-capability.${Buffer.from(id).toString("base64url")}` as PragmaBindingRef;
export const desktopContextBindingRef = (id: string): PragmaBindingRef =>
  `binding:desktop-context.${Buffer.from(id).toString("base64url")}` as PragmaBindingRef;
export function classifyHostCapabilityResource(
  resource: PragmaResource | undefined,
): { readonly id: string } | undefined {
  if (resource?.kind !== "Capability" || resource.spec.adapter !== "pragma.capability.host@v1")
    return undefined;
  const id = parseLocalHostCapabilityBindingRef(resource.spec.binding ?? "");
  return id === undefined ? undefined : { id };
}
export function classifyHostContextResource(
  resource: PragmaResource | undefined,
): string | undefined {
  return resource?.kind === "ContextStore" && resource.spec.adapter === "pragma.context.host@v1"
    ? parseLocalHostContextBindingRef(resource.spec.binding ?? "")
    : undefined;
}
export function bindExistingDesktopCapabilityResource(
  resource: PragmaCapabilityResource,
  binding: { readonly id: string },
  metadata?: { readonly name: string; readonly description: string },
): PragmaCapabilityResource {
  const result = PragmaForwardCompatibleResourceSchema.parse({
    ...resource,
    metadata: {
      ...resource.metadata,
      ...(metadata === undefined
        ? {}
        : {
            name: metadata.name,
            description: metadata.description.trim() || resource.metadata.description,
          }),
      tags: [...new Set([...resource.metadata.tags, "desktop-managed"])],
    },
    spec: {
      ...resource.spec,
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(binding.id),
      config: { ...(resource.spec.config ?? {}), key: binding.id },
    },
  });
  if (result.kind !== "Capability") throw new Error("Expected a Capability binding.");
  return result;
}
export function bindExistingDesktopContextResource(
  resource: PragmaContextStoreResource,
  storeId: string,
  metadata?: { readonly name: string; readonly description: string },
): PragmaContextStoreResource {
  const result = PragmaForwardCompatibleResourceSchema.parse({
    ...resource,
    metadata: {
      ...resource.metadata,
      ...(metadata === undefined
        ? {}
        : {
            name: metadata.name,
            description: metadata.description.trim() || resource.metadata.description,
          }),
      tags: [...new Set([...resource.metadata.tags, "desktop-managed"])],
    },
    spec: {
      ...resource.spec,
      adapter: "pragma.context.host@v1",
      binding: desktopContextBindingRef(storeId),
      config: { ...(resource.spec.config ?? {}), key: storeId },
    },
  });
  if (result.kind !== "ContextStore") throw new Error("Expected a ContextStore binding.");
  return result;
}
