import { derivePragmaResourceId } from "@pragma/core";

import type { PragmaResource } from "../../ast/pragma-dsl.schema.ts";
import { normalizePragmaResourceName } from "../../ast/resource-identity.ts";
import { PragmaV2SemanticResourceSchema } from "../schemas/v2.ts";
import { PragmaV3SemanticResourceSchema } from "../schemas/v3.ts";
import {
  PragmaDslMigrationError,
  type PragmaDslMigrationStep,
  type PragmaResourceIdentityMigration,
} from "../types.ts";

const semanticReferencePattern =
  /^(expert|team|flow|automation|capability|context-store|runtime-profile):([^@]+)@[^@]+$/u;

export const pragmaDslV2ToV3Step = {
  fromApiVersion: "pragma/v2",
  toApiVersion: "pragma/v3",
  migrate(project) {
    const legacyResources = project.resources.map((resource) => {
      const parsed = PragmaV2SemanticResourceSchema.safeParse(resource);
      if (!parsed.success) {
        throw new PragmaDslMigrationError(
          "invalid_legacy_project",
          "Pragma v2 project contains an invalid semantic resource.",
          { cause: parsed.error },
        );
      }
      return parsed.data;
    });

    const identities = new Map<string, string>();
    const usedIds = new Map<string, string>();
    const names = new Set<string>();
    const identityMigrations: PragmaResourceIdentityMigration[] = [];
    for (const resource of legacyResources) {
      const identity = identityKey(resource.kind, resource.metadata.id);
      if (identities.has(identity)) {
        throw new PragmaDslMigrationError(
          "identity_conflict",
          `Cannot migrate ${resource.kind} ${resource.metadata.id}: multiple legacy versions coexist in one project revision.`,
        );
      }
      const normalizedName = `${resource.kind}\0${normalizePragmaResourceName(resource.metadata.name)}`;
      if (names.has(normalizedName)) {
        throw new PragmaDslMigrationError(
          "name_conflict",
          `Cannot migrate ${resource.kind} ${resource.metadata.name}: its normalized name is duplicated.`,
        );
      }
      names.add(normalizedName);
      const targetId = derivePragmaResourceId(
        `${project.projectId}\0${resource.kind}\0${resource.metadata.id}`,
      );
      const prior = usedIds.get(targetId);
      if (prior !== undefined) {
        throw new PragmaDslMigrationError(
          "identity_conflict",
          `Cannot migrate project IDs because ${prior} and ${identity} map to the same target ID.`,
        );
      }
      identities.set(identity, targetId);
      usedIds.set(targetId, identity);
      identityMigrations.push({
        kind: resource.kind,
        sourceId: resource.metadata.id,
        targetId,
      });
    }

    const resources = legacyResources.map((resource) => {
      const copy = structuredClone(resource) as Record<string, unknown>;
      const metadata = copy["metadata"] as Record<string, unknown>;
      metadata["id"] = identities.get(identityKey(resource.kind, resource.metadata.id));
      delete metadata["version"];
      copy["apiVersion"] = "pragma/v3";
      rewriteLegacySemanticRefs(copy, identities);
      rewriteLegacyExpertIdMaps(copy, identities);
      removeLegacyFlowStepVersions(copy);
      const parsed = PragmaV3SemanticResourceSchema.safeParse(copy);
      if (!parsed.success) {
        throw new PragmaDslMigrationError(
          "invalid_migrated_project",
          `Migrated ${resource.kind} ${resource.metadata.id} is not valid Pragma v3.`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    });

    return {
      ...project,
      resources,
      identityMigrations: [...project.identityMigrations, ...identityMigrations],
    };
  },
} satisfies PragmaDslMigrationStep;

function rewriteLegacySemanticRefs(value: unknown, identities: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (const child of value) rewriteLegacySemanticRefs(child, identities);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== "string") {
      rewriteLegacySemanticRefs(child, identities);
      continue;
    }
    const match = semanticReferencePattern.exec(child);
    if (match === null) continue;
    const prefix = match[1]!;
    const sourceId = match[2]!;
    const targetId =
      prefix === "expert" && sourceId === "pragma"
        ? "0000000000pragma"
        : identities.get(identityKey(semanticKindFromPrefix(prefix), sourceId));
    if (targetId === undefined) {
      throw new PragmaDslMigrationError(
        "unresolved_reference",
        `Cannot migrate unresolved Pragma v2 reference: ${child}.`,
      );
    }
    (value as Record<string, unknown>)[key] = `${prefix}:${targetId}`;
  }
}

function rewriteLegacyExpertIdMaps(
  resource: Record<string, unknown>,
  identities: ReadonlyMap<string, string>,
): void {
  const spec = asRecord(resource["spec"]);
  if (spec === undefined) return;
  if (resource["kind"] === "Expert") {
    const tools = spec["tools"];
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      const policy = asRecord(asRecord(tool)?.["policy"]);
      if (policy !== undefined) rewriteExpertIdRecord(policy, "runtimes", identities);
    }
    return;
  }
  if (resource["kind"] === "ExpertTeam") {
    const delegation = asRecord(spec["delegation"]);
    if (delegation === undefined) return;
    const allow = asRecord(delegation["allow"]);
    if (allow !== undefined) {
      const rewritten: Record<string, unknown> = {};
      for (const [sourceId, members] of Object.entries(allow)) {
        if (!Array.isArray(members)) continue;
        rewritten[resolveExpertId(sourceId, identities)] = members.map((member) =>
          typeof member === "string" ? resolveExpertId(member, identities) : member,
        );
      }
      delegation["allow"] = rewritten;
    }
    rewriteExpertIdRecord(delegation, "runtimes", identities);
    return;
  }
  if (resource["kind"] !== "Flow") return;
  const graph = asRecord(spec["graph"]);
  const steps = asRecord(graph?.["steps"]);
  if (steps === undefined) return;
  for (const step of Object.values(steps)) {
    const record = asRecord(step);
    if (record !== undefined) rewriteExpertIdRecord(record, "runtimes", identities);
  }
}

function rewriteExpertIdRecord(
  owner: Record<string, unknown>,
  key: string,
  identities: ReadonlyMap<string, string>,
): void {
  const current = asRecord(owner[key]);
  if (current === undefined) return;
  owner[key] = Object.fromEntries(
    Object.entries(current).map(([sourceId, value]) => [
      resolveExpertId(sourceId, identities),
      value,
    ]),
  );
}

function resolveExpertId(sourceId: string, identities: ReadonlyMap<string, string>): string {
  const targetId =
    sourceId === "pragma" ? "0000000000pragma" : identities.get(identityKey("Expert", sourceId));
  if (targetId === undefined) {
    throw new PragmaDslMigrationError(
      "unresolved_reference",
      `Cannot migrate unresolved Pragma v2 Expert ID: ${sourceId}.`,
    );
  }
  return targetId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeLegacyFlowStepVersions(resource: Record<string, unknown>): void {
  if (resource["kind"] !== "Flow") return;
  const spec = resource["spec"];
  if (typeof spec !== "object" || spec === null) return;
  const graph = (spec as Record<string, unknown>)["graph"];
  if (typeof graph !== "object" || graph === null) return;
  const steps = (graph as Record<string, unknown>)["steps"];
  if (typeof steps !== "object" || steps === null) return;
  for (const step of Object.values(steps)) {
    if (typeof step === "object" && step !== null)
      delete (step as Record<string, unknown>)["version"];
  }
}

function identityKey(kind: PragmaResource["kind"], id: string): string {
  return `${kind}\0${id}`;
}

function semanticKindFromPrefix(prefix: string): PragmaResource["kind"] {
  if (prefix === "expert") return "Expert";
  if (prefix === "team") return "ExpertTeam";
  if (prefix === "flow") return "Flow";
  if (prefix === "automation") return "Automation";
  if (prefix === "capability") return "Capability";
  if (prefix === "context-store") return "ContextStore";
  return "RuntimeProfile";
}
