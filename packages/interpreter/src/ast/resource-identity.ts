import type { PragmaResource, PragmaSemanticResourceRef } from "./pragma-dsl.schema.ts";

export type PragmaResourceNamespace =
  | "expert"
  | "team"
  | "flow"
  | "capability"
  | "context-store"
  | "runtime-profile";

const namespaceByKind = {
  Expert: "expert",
  ExpertTeam: "team",
  Flow: "flow",
  Capability: "capability",
  ContextStore: "context-store",
  RuntimeProfile: "runtime-profile",
} as const satisfies Readonly<Record<PragmaResource["kind"], PragmaResourceNamespace>>;

const directoryByKind = {
  Expert: "experts",
  ExpertTeam: "teams",
  Flow: "flows",
  Capability: "capabilities",
  ContextStore: "context-stores",
  RuntimeProfile: "runtime-profiles",
} as const satisfies Readonly<Record<PragmaResource["kind"], string>>;

export function pragmaResourceNamespace(resource: PragmaResource): PragmaResourceNamespace {
  return namespaceByKind[resource.kind];
}

export function pragmaResourceDirectory(resource: PragmaResource): string {
  return directoryByKind[resource.kind];
}

export function canonicalPragmaResourceRef(resource: PragmaResource): PragmaSemanticResourceRef {
  return `${pragmaResourceNamespace(resource)}:${resource.metadata.id}@${resource.metadata.version}` as PragmaSemanticResourceRef;
}

export function pragmaResourceFileName(resource: PragmaResource): string {
  return `${resource.metadata.id}@${resource.metadata.version}.pragma.yaml`;
}

export function parsePragmaReference(ref: string): {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
} {
  const separator = ref.indexOf(":");
  const versionSeparator = ref.lastIndexOf("@");
  if (separator < 1 || versionSeparator <= separator + 1 || versionSeparator === ref.length - 1) {
    throw new Error(`Invalid exact Pragma reference: ${ref}`);
  }
  return {
    kind: ref.slice(0, separator),
    id: ref.slice(separator + 1, versionSeparator),
    version: ref.slice(versionSeparator + 1),
  };
}
