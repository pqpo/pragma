import type { PragmaResource, PragmaSemanticResourceRef } from "./pragma-dsl.schema.ts";

export type PragmaResourceNamespace =
  | "expert"
  | "team"
  | "flow"
  | "automation"
  | "capability"
  | "context-store"
  | "runtime-profile"
  | "evaluation";

const namespaceByKind = {
  Expert: "expert",
  ExpertTeam: "team",
  Flow: "flow",
  Automation: "automation",
  Capability: "capability",
  ContextStore: "context-store",
  RuntimeProfile: "runtime-profile",
  Evaluation: "evaluation",
} as const satisfies Readonly<Record<PragmaResource["kind"], PragmaResourceNamespace>>;

const directoryByKind = {
  Expert: "experts",
  ExpertTeam: "teams",
  Flow: "flows",
  Automation: "automations",
  Capability: "capabilities",
  ContextStore: "context-stores",
  RuntimeProfile: "runtime-profiles",
  Evaluation: "evaluations",
} as const satisfies Readonly<Record<PragmaResource["kind"], string>>;

export function pragmaResourceNamespace(resource: PragmaResource): PragmaResourceNamespace {
  return namespaceByKind[resource.kind];
}

export function pragmaResourceDirectory(resource: PragmaResource): string {
  return directoryByKind[resource.kind];
}

export function canonicalPragmaResourceRef(resource: PragmaResource): PragmaSemanticResourceRef {
  return `${pragmaResourceNamespace(resource)}:${resource.metadata.id}` as PragmaSemanticResourceRef;
}

export function pragmaResourceFileName(resource: PragmaResource): string {
  return `${resource.metadata.id}.pragma.yaml`;
}

export function normalizePragmaResourceName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function parsePragmaReference(ref: string): {
  readonly kind: string;
  readonly id: string;
} {
  const separator = ref.indexOf(":");
  if (separator < 1 || separator === ref.length - 1 || ref.includes("@")) {
    throw new Error(`Invalid exact Pragma reference: ${ref}`);
  }
  return {
    kind: ref.slice(0, separator),
    id: ref.slice(separator + 1),
  };
}
