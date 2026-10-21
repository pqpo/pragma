import { isDeepStrictEqual } from "node:util";
import {
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  type PragmaCapabilityResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { PRAGMA_TEXT_LIMITS, truncatePragmaUnicode } from "@pragma/shared";
import { classifyHostCapabilityResource } from "../bindings.ts";

/** Normalize a derived resource graph; never mutate an immutable Project Revision. */
export async function normalizeHostBoundResources(
  source: readonly PragmaResource[],
  options: {
    readonly canonicalCapabilityId?: ((id: string) => string | undefined) | undefined;
    readonly capabilityResources?: readonly PragmaResource[] | undefined;
    readonly capabilityName?: ((id: string) => Promise<string | undefined>) | undefined;
  } = {},
): Promise<{
  readonly resources: PragmaResource[];
  readonly aliases: ReadonlyMap<string, string>;
}> {
  const resources = structuredClone([...source]);
  const groups = new Map<string, PragmaCapabilityResource[]>();
  for (const resource of resources) {
    const binding = classifyHostCapabilityResource(resource);
    if (resource.kind !== "Capability" || binding === undefined) continue;
    const group = groups.get(binding.id) ?? [];
    group.push(resource);
    groups.set(binding.id, group);
  }
  const aliases = new Map<string, string>();
  const capabilityNames = new Map<string, string>();
  for (const [id, group] of groups) {
    const catalog = options.capabilityResources?.find(
      (resource) => classifyHostCapabilityResource(resource)?.id === id,
    );
    const preferredId = options.canonicalCapabilityId?.(id) ?? catalog?.metadata.id;
    const sorted = group.toSorted(
      (left, right) =>
        Number(right.metadata.id === preferredId) - Number(left.metadata.id === preferredId) ||
        Number(right.metadata.tags.includes("default-agent-option")) -
          Number(left.metadata.tags.includes("default-agent-option")) ||
        left.metadata.id.localeCompare(right.metadata.id),
    );
    // Catalogs select identity and display metadata; the stored definition owns compatible
    // extension fields. A catalog template must never replace or reject those fields.
    // Identity preference selects an existing alias; reading or rebinding never allocates IDs.
    const canonical = sorted[0]!;
    for (const resource of sorted) {
      // Unknown fields are part of the configuration too: do not silently discard future semantics.
      const definition = { ...resource, metadata: undefined };
      const canonicalDefinition = { ...canonical, metadata: undefined };
      const extraMetadata = Object.fromEntries(
        Object.entries(resource.metadata).filter(
          ([key]) => !["id", "name", "description", "tags"].includes(key),
        ),
      );
      const canonicalExtraMetadata = Object.fromEntries(
        Object.entries(canonical.metadata).filter(
          ([key]) => !["id", "name", "description", "tags"].includes(key),
        ),
      );
      if (
        !isDeepStrictEqual(definition, canonicalDefinition) ||
        !isDeepStrictEqual(extraMetadata, canonicalExtraMetadata)
      ) {
        throw new Error(
          `Host Capability ${id} has conflicting configurations; resolve the resource aliases before saving or exporting.`,
        );
      }
      aliases.set(canonicalPragmaResourceRef(resource), canonicalPragmaResourceRef(canonical));
    }
    canonical.metadata.tags = [
      ...new Set([
        ...canonical.metadata.tags,
        ...(catalog?.metadata.tags ?? []),
        ...group.flatMap((resource) => resource.metadata.tags),
      ]),
    ];
    const name = (await options.capabilityName?.(id)) ?? catalog?.metadata.name;
    if (name !== undefined) capabilityNames.set(canonicalPragmaResourceRef(canonical), name);
  }
  const retained = resources.filter((resource) => {
    const ref = canonicalPragmaResourceRef(resource);
    return (aliases.get(ref) ?? ref) === ref;
  });
  applyGeneratedNames(retained, "Capability", capabilityNames, "");
  for (const resource of retained) {
    if (resource.kind !== "Expert") continue;
    for (const reference of resource.spec.capabilities) {
      reference.ref = (aliases.get(reference.ref) ?? reference.ref) as typeof reference.ref;
    }
    // Preserve every selection when one Expert used multiple aliases of the same capability.
    const selections = new Map<string, (typeof resource.spec.capabilities)[number]>();
    for (const reference of resource.spec.capabilities) {
      const previous = selections.get(reference.ref);
      if (previous === undefined) {
        selections.set(reference.ref, reference);
        continue;
      }
      if (isDeepStrictEqual(previous, reference)) continue;
      if (previous.kind === "tools" && reference.kind === "tools") {
        const left = { ...previous, tools: undefined };
        const right = { ...reference, tools: undefined };
        if (isDeepStrictEqual(left, right)) {
          previous.tools =
            previous.tools === undefined || reference.tools === undefined
              ? undefined
              : [...new Set([...previous.tools, ...reference.tools])];
          continue;
        }
      }
      throw new Error(
        `Capability ${reference.ref} has conflicting selections in Expert ${resource.metadata.name}.`,
      );
    }
    resource.spec.capabilities = [...selections.values()];
  }
  const generatedNames = new Map<string, string>();
  for (const resource of retained) {
    if (resource.kind !== "RuntimeProfile") continue;
    const ref = canonicalPragmaResourceRef(resource);
    const users = retained
      .filter((candidate) => candidate.kind === "Expert" && candidate.spec.runtime?.ref === ref)
      .toSorted((left, right) => left.metadata.id.localeCompare(right.metadata.id));
    if (users.length === 0) continue;
    const labels = users.map((user) =>
      users.some(
        (other) =>
          other.metadata.id !== user.metadata.id && other.metadata.name === user.metadata.name,
      )
        ? `${user.metadata.name} (${user.metadata.id})`
        : user.metadata.name,
    );
    generatedNames.set(ref, labels.join(" / "));
  }
  applyGeneratedNames(retained, "RuntimeProfile", generatedNames, " Runtime");
  return { resources: retained, aliases };
}

function boundedResourceName(
  label: string,
  suffix: string,
  kind: "Capability" | "RuntimeProfile",
): string {
  const limit =
    kind === "Capability"
      ? PRAGMA_TEXT_LIMITS.capability.name
      : PRAGMA_TEXT_LIMITS.defaultMetadata.name;
  const budget = limit - suffix.length;
  let name = truncatePragmaUnicode(label, budget);
  // RuntimeProfile's existing generic Metadata Schema still enforces UTF-16 length;
  // Capability uses Unicode code points. Keep both current protocol limits intact.
  if (kind === "RuntimeProfile") {
    while (name.length > budget) name = truncatePragmaUnicode(name, [...name].length - 1);
  }
  if (name !== label) name = `${truncatePragmaUnicode(name, [...name].length - 1)}…`;
  return `${name}${suffix}`;
}

function applyGeneratedNames(
  resources: PragmaResource[],
  kind: "Capability" | "RuntimeProfile",
  labels: ReadonlyMap<string, string>,
  suffix: string,
): void {
  const matching = resources
    .filter((resource) => resource.kind === kind)
    .toSorted((left, right) => left.metadata.id.localeCompare(right.metadata.id));
  const occupied = new Set(
    matching
      .filter((resource) => !labels.has(canonicalPragmaResourceRef(resource)))
      .map((resource) => normalizePragmaResourceName(resource.metadata.name)),
  );
  for (const resource of matching) {
    const label = labels.get(canonicalPragmaResourceRef(resource));
    if (label === undefined) continue;
    let name = boundedResourceName(label, suffix, kind);
    let ordinal = 0;
    while (occupied.has(normalizePragmaResourceName(name))) {
      ordinal++;
      name = boundedResourceName(
        label,
        `${suffix} (${resource.metadata.id}${ordinal === 1 ? "" : `-${ordinal}`})`,
        kind,
      );
    }
    resource.metadata.name = name;
    occupied.add(normalizePragmaResourceName(name));
  }
}
