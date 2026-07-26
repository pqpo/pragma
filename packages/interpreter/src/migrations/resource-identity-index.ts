import { derivePragmaResourceId } from "@pragma/core";

import type { PragmaResource } from "../ast/pragma-dsl.schema.ts";
import type { PragmaResourceIdentityMigration } from "./types.ts";

export type PragmaProjectResourceKind = PragmaResource["kind"];
export type PragmaProjectResourceNamespace =
  | "expert"
  | "team"
  | "flow"
  | "automation"
  | "capability"
  | "context-store"
  | "runtime-profile";

const namespaceByKind = {
  Expert: "expert",
  ExpertTeam: "team",
  Flow: "flow",
  Automation: "automation",
  Capability: "capability",
  ContextStore: "context-store",
  RuntimeProfile: "runtime-profile",
} as const satisfies Readonly<Record<PragmaProjectResourceKind, PragmaProjectResourceNamespace>>;

export interface PragmaResourceIdentityMigrationIndex {
  readonly projectId: string;
  resolveRef(ref: string): string;
  resolveId(kind: PragmaProjectResourceKind, id: string): string;
  hasMigration(kind: PragmaProjectResourceKind, sourceId: string, targetId: string): boolean;
}

export function createPragmaResourceIdentityMigrationIndex(input: {
  readonly projectId: string;
  readonly migrations?: readonly PragmaResourceIdentityMigration[] | undefined;
}): PragmaResourceIdentityMigrationIndex {
  const explicitRefTargets = new Map<string, string>();
  const explicitIdTargets = new Map<string, string>();
  for (const migration of input.migrations ?? []) {
    const namespace = namespaceByKind[migration.kind];
    explicitIdTargets.set(identityKey(migration.kind, migration.sourceId), migration.targetId);
    explicitRefTargets.set(
      `${namespace}:${migration.sourceId}`,
      `${namespace}:${migration.targetId}`,
    );
  }
  return {
    projectId: input.projectId,
    resolveRef(ref) {
      return (
        explicitRefTargets.get(stripRefVersion(ref)) ??
        migrateLegacyPragmaResourceRef(ref, input.projectId)
      );
    },
    resolveId(kind, id) {
      return explicitIdTargets.get(identityKey(kind, id)) ?? id;
    },
    hasMigration(kind, sourceId, targetId) {
      if (sourceId === targetId) return true;
      return explicitIdTargets.get(identityKey(kind, sourceId)) === targetId;
    },
  };
}

export function migrateLegacyPragmaResourceRef(ref: string, projectId: string): string {
  const match =
    /^(expert|team|flow|automation|capability|context-store|runtime-profile):([^@]+)@[^@]+$/.exec(
      ref,
    );
  if (match === null) return ref;
  const namespace = match[1] as PragmaProjectResourceNamespace;
  const sourceId = match[2]!;
  if (namespace === "expert" && sourceId === "pragma") return "expert:0000000000pragma";
  return `${namespace}:${derivePragmaResourceId(
    `${projectId}\0${kindByNamespace(namespace)}\0${sourceId}`,
  )}`;
}

function stripRefVersion(ref: string): string {
  const match = /^([^:]+:[^@]+)@[^@]+$/.exec(ref);
  return match?.[1] ?? ref;
}

function kindByNamespace(namespace: PragmaProjectResourceNamespace): PragmaProjectResourceKind {
  switch (namespace) {
    case "expert":
      return "Expert";
    case "team":
      return "ExpertTeam";
    case "flow":
      return "Flow";
    case "automation":
      return "Automation";
    case "capability":
      return "Capability";
    case "context-store":
      return "ContextStore";
    case "runtime-profile":
      return "RuntimeProfile";
  }
}

function identityKey(kind: PragmaProjectResourceKind, id: string): string {
  return `${kind}:${id}`;
}
