import { derivePragmaResourceId } from "@pragma/core";
import {
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaCapabilityResource,
  type PragmaContextStoreResource,
  type PragmaResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";

import type { CreateExpertDefinition } from "../../../shared/contracts/index.ts";
import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
  parseDesktopModelProviderBindingRef,
} from "./desktop-binding-ref.ts";

export type DesktopBoundResourceOwner =
  "project-expert" | "system-expert-customization" | "default-agent-option" | "imported-resource";

export interface DesktopCapabilityBindingIdentity {
  readonly id: string;
  readonly revision: number;
}

export function desktopCapabilityResourceId(
  owner: Exclude<DesktopBoundResourceOwner, "imported-resource">,
  capabilityId: string,
): string {
  const prefix =
    owner === "project-expert"
      ? "desktop-managed"
      : owner === "system-expert-customization"
        ? "system-expert"
        : "default-agent";
  return derivePragmaResourceId(`${prefix}:capability:${capabilityId}`);
}

export function desktopContextResourceId(
  owner: Exclude<DesktopBoundResourceOwner, "imported-resource" | "default-agent-option">,
  storeId: string,
): string {
  const prefix = owner === "project-expert" ? "desktop-managed" : "system-expert";
  return derivePragmaResourceId(`${prefix}:context:${storeId}`);
}

export function desktopRuntimeResourceId(ownerId: string): string {
  return derivePragmaResourceId(`desktop-managed:runtime:${ownerId}`);
}

export function desktopRuntimeOptionResourceId(
  runtimeId: string,
  providerId: string,
  modelId: string,
): string {
  return derivePragmaResourceId(
    `default-agent:runtime:${JSON.stringify([runtimeId, providerId, modelId])}`,
  );
}

export function classifyDesktopCapabilityResource(
  resource: PragmaResource | undefined,
): DesktopCapabilityBindingIdentity | undefined {
  if (
    resource?.kind !== "Capability" ||
    resource.spec.adapter !== "pragma.capability.host@v1" ||
    !resource.metadata.tags.includes("desktop-managed")
  ) {
    return undefined;
  }
  return parseDesktopCapabilityBindingRef(resource.spec.binding ?? "");
}

export function classifyDesktopContextResource(
  resource: PragmaResource | undefined,
): string | undefined {
  if (
    resource?.kind !== "ContextStore" ||
    resource.spec.adapter !== "pragma.context.host@v1" ||
    !resource.metadata.tags.includes("desktop-managed")
  ) {
    return undefined;
  }
  return parseDesktopContextBindingRef(resource.spec.binding ?? "");
}

export function createDesktopCapabilityResource(input: {
  readonly owner: Exclude<DesktopBoundResourceOwner, "imported-resource">;
  readonly capabilityId: string;
  readonly revision: number;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}): PragmaCapabilityResource {
  const option = input.owner === "default-agent-option";
  const system = input.owner === "system-expert-customization";
  return PragmaCapabilityResourceSchema.parse({
    apiVersion: "pragma/v4",
    kind: "Capability",
    metadata: {
      id: desktopCapabilityResourceId(input.owner, input.capabilityId),
      name: input.name ?? `Capability ${input.capabilityId}`,
      description:
        input.description ??
        (system
          ? "Desktop-managed optional capability binding."
          : "Desktop-managed capability binding."),
      tags: [
        "desktop-managed",
        ...(option ? ["default-agent-option"] : []),
        ...(system ? ["system-expert-customization"] : []),
      ],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(input.capabilityId, input.revision),
      config: { key: input.capabilityId },
    },
  });
}

export function bindExistingDesktopCapabilityResource(
  resource: PragmaCapabilityResource,
  binding: DesktopCapabilityBindingIdentity,
  metadata?: { readonly name: string; readonly description: string },
): PragmaCapabilityResource {
  return PragmaCapabilityResourceSchema.parse({
    ...resource,
    metadata: {
      ...resource.metadata,
      ...(metadata ?? {}),
      tags: unique([...resource.metadata.tags, "desktop-managed"]),
    },
    spec: {
      ...resource.spec,
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(binding.id, binding.revision),
      config: { ...(resource.spec.config ?? {}), key: binding.id },
    },
  });
}

export function resolveDesktopCapabilityResource(input: {
  readonly capabilityId: string;
  readonly revision: number;
  readonly resources: readonly PragmaResource[];
  readonly currentRef?: string | undefined;
}): PragmaCapabilityResource {
  const matches = input.resources.filter((resource): resource is PragmaCapabilityResource => {
    const binding = classifyDesktopCapabilityResource(resource);
    return binding?.id === input.capabilityId && binding.revision === input.revision;
  });
  const current = matches.find(
    (resource) => canonicalPragmaResourceRef(resource) === input.currentRef,
  );
  if (current !== undefined) return current;

  // The option catalog is the canonical shared resource presented by Desktop pickers. Prefer it
  // explicitly; never let source-file or array ordering decide resource identity.
  const optionId = desktopCapabilityResourceId("default-agent-option", input.capabilityId);
  const canonicalOption = matches.find((resource) => resource.metadata.id === optionId);
  if (canonicalOption !== undefined) return canonicalOption;
  const options = matches.filter((resource) =>
    resource.metadata.tags.includes("default-agent-option"),
  );
  if (options.length === 1) return options[0]!;
  if (options.length > 1) throw ambiguousBinding("Capability", input.capabilityId, matches);
  const canonicalId = desktopCapabilityResourceId("project-expert", input.capabilityId);
  const canonical = matches.find((resource) => resource.metadata.id === canonicalId);
  if (canonical !== undefined) return canonical;
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw ambiguousBinding("Capability", input.capabilityId, matches);
  return createDesktopCapabilityResource({ owner: "project-expert", ...input });
}

export function createDesktopContextResource(input: {
  readonly owner: Exclude<DesktopBoundResourceOwner, "imported-resource" | "default-agent-option">;
  readonly storeId: string;
}): PragmaContextStoreResource {
  const system = input.owner === "system-expert-customization";
  return PragmaContextStoreResourceSchema.parse({
    apiVersion: "pragma/v4",
    kind: "ContextStore",
    metadata: {
      id: desktopContextResourceId(input.owner, input.storeId),
      name: `Context ${input.storeId}`,
      description: system
        ? "Desktop-managed optional context store binding."
        : "Desktop-managed context store binding.",
      tags: ["desktop-managed", ...(system ? ["system-expert-customization"] : [])],
    },
    spec: {
      adapter: "pragma.context.host@v1",
      binding: desktopContextBindingRef(input.storeId),
      config: { key: input.storeId },
    },
  });
}

export function bindExistingDesktopContextResource(
  resource: PragmaContextStoreResource,
  storeId: string,
  metadata?: { readonly name: string; readonly description: string },
): PragmaContextStoreResource {
  return PragmaContextStoreResourceSchema.parse({
    ...resource,
    metadata: {
      ...resource.metadata,
      ...(metadata ?? {}),
      tags: unique([...resource.metadata.tags, "desktop-managed"]),
    },
    spec: {
      ...resource.spec,
      adapter: "pragma.context.host@v1",
      binding: desktopContextBindingRef(storeId),
      config: { ...(resource.spec.config ?? {}), key: storeId },
    },
  });
}

export function resolveDesktopContextResource(input: {
  readonly storeId: string;
  readonly resources: readonly PragmaResource[];
  readonly currentRef?: string | undefined;
}): PragmaContextStoreResource {
  const matches = input.resources.filter(
    (resource): resource is PragmaContextStoreResource =>
      classifyDesktopContextResource(resource) === input.storeId,
  );
  const current = matches.find(
    (resource) => canonicalPragmaResourceRef(resource) === input.currentRef,
  );
  if (current !== undefined) return current;
  const canonicalId = desktopContextResourceId("project-expert", input.storeId);
  const canonical = matches.find((resource) => resource.metadata.id === canonicalId);
  if (canonical !== undefined) return canonical;
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw ambiguousBinding("ContextStore", input.storeId, matches);
  return createDesktopContextResource({ owner: "project-expert", storeId: input.storeId });
}

export function createDesktopRuntimeResource(input: {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly model: CreateExpertDefinition["model"];
}): PragmaRuntimeProfileResource {
  return createRuntimeResourceWithId(desktopRuntimeResourceId(input.ownerId), input);
}

function createRuntimeResourceWithId(
  id: string,
  input: {
    readonly ownerId: string;
    readonly ownerName: string;
    readonly model: CreateExpertDefinition["model"];
  },
): PragmaRuntimeProfileResource {
  return PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: "pragma/v4",
    kind: "RuntimeProfile",
    metadata: {
      id,
      name: `${input.ownerName} Runtime`,
      description: `Runtime profile for ${input.ownerName}.`,
      tags: ["desktop-managed"],
    },
    spec: { adapter: "pragma.runtime.profile@v1", config: runtimeConfig(input.model) },
  });
}

export function createDesktopRuntimeOptionResource(input: {
  readonly runtimeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly description: string;
}): PragmaRuntimeProfileResource {
  return PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: "pragma/v4",
    kind: "RuntimeProfile",
    metadata: {
      id: desktopRuntimeOptionResourceId(input.runtimeId, input.providerId, input.modelId),
      name: input.name,
      description: input.description,
      tags: ["desktop-managed", "default-agent-option"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        model: input.modelId,
      },
    },
  });
}

export function resolveDesktopRuntimeResource(input: {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly model: CreateExpertDefinition["model"];
  readonly resources: readonly PragmaResource[];
  readonly currentRef?: string | undefined;
}): PragmaRuntimeProfileResource {
  const current = input.resources.find(
    (resource): resource is PragmaRuntimeProfileResource =>
      resource.kind === "RuntimeProfile" &&
      canonicalPragmaResourceRef(resource) === input.currentRef,
  );
  if (current !== undefined && runtimeMatches(current, input.model)) return current;
  const canonicalId = desktopRuntimeResourceId(input.ownerId);
  if (current?.metadata.id === canonicalId) {
    const currentRef = canonicalPragmaResourceRef(current);
    const shared = input.resources.some(
      (resource) =>
        resource.kind === "Expert" &&
        resource.metadata.id !== input.ownerId &&
        resource.spec.runtime?.ref === currentRef,
    );
    if (shared) {
      return createRuntimeResourceWithId(
        derivePragmaResourceId(
          `desktop-managed:runtime:${input.ownerId}:${JSON.stringify(runtimeConfig(input.model))}`,
        ),
        input,
      );
    }
    return PragmaRuntimeProfileResourceSchema.parse({
      ...current,
      metadata: {
        ...current.metadata,
        name: `${input.ownerName} Runtime`,
        description: `Runtime profile for ${input.ownerName}.`,
      },
      spec: { ...current.spec, config: runtimeConfig(input.model) },
    });
  }
  return createDesktopRuntimeResource(input);
}

function runtimeMatches(
  resource: PragmaRuntimeProfileResource,
  model: CreateExpertDefinition["model"],
): boolean {
  const config = (resource.spec.config ?? {}) as Record<string, unknown>;
  return (
    config?.runtimeId === model.runtimeId &&
    (config.providerId ?? parseDesktopModelProviderBindingRef(resource.spec.binding ?? "")) ===
      model.providerId &&
    config.model === model.modelId &&
    config.thinkingLevel === model.thinkingLevel
  );
}

function runtimeConfig(model: CreateExpertDefinition["model"]): Record<string, unknown> {
  return {
    runtimeId: model.runtimeId,
    providerId: model.providerId,
    model: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ambiguousBinding(
  kind: "Capability" | "ContextStore",
  hostId: string,
  matches: readonly PragmaResource[],
): Error {
  return new Error(
    `Desktop ${kind} binding ${hostId} is ambiguous across ${matches
      .map(canonicalPragmaResourceRef)
      .toSorted()
      .join(", ")}. Resolve the duplicate identities before saving.`,
  );
}
