import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  EffectiveMemoryPolicySchema,
  MemoryAssetPolicyOverrideSchema,
  MemoryGlobalPolicySchema,
  MemoryPolicyRevisionSchema,
  MemorySubjectRefSchema,
  type EffectiveMemoryPolicy,
  type MemoryAssetPolicyOverride,
  type MemoryGlobalPolicy,
  type MemoryPolicyRevision,
  type MemorySubjectRef,
} from "@pragma/shared";
import { z } from "zod";

const PolicyHistoryFileSchema = z.object({
  schemaVersion: z.literal("pragma.memory-policy-history/v1"),
  revisions: z.array(MemoryPolicyRevisionSchema).max(10_000),
});

export const DEFAULT_MEMORY_GLOBAL_POLICY: MemoryGlobalPolicy = {
  capture: "disabled",
  recall: "disabled",
  learning: "disabled",
};

export const DEFAULT_MEMORY_ASSET_POLICY: MemoryAssetPolicyOverride = {
  capture: "inherit",
  recall: "inherit",
  learning: "inherit",
};

export interface MemoryMissionRestriction {
  readonly capture?: false | undefined;
  readonly recall?: false | undefined;
  readonly learning?: "disabled" | undefined;
}

export interface MemoryPolicyStore {
  getGlobal(at?: Date): Promise<Extract<MemoryPolicyRevision, { readonly scope: "global" }>>;
  updateGlobal(input: {
    readonly expectedRevision: number;
    readonly policy: MemoryGlobalPolicy;
  }): Promise<Extract<MemoryPolicyRevision, { readonly scope: "global" }>>;
  getOverride(
    targetRef: MemorySubjectRef,
    at?: Date,
  ): Promise<Extract<MemoryPolicyRevision, { readonly scope: "asset" }>>;
  updateOverride(input: {
    readonly targetRef: MemorySubjectRef;
    readonly expectedRevision: number;
    readonly policy: MemoryAssetPolicyOverride;
  }): Promise<Extract<MemoryPolicyRevision, { readonly scope: "asset" }>>;
  resolveAt(input: {
    readonly rootRef?: MemorySubjectRef | undefined;
    readonly producerRefs?: readonly MemorySubjectRef[] | undefined;
    readonly occurredAt: string;
    readonly missionRestriction?: MemoryMissionRestriction | undefined;
  }): Promise<EffectiveMemoryPolicy>;
}

export function createFileMemoryPolicyStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryPolicyStore {
  const paths = new PragmaPaths(options);
  const now = options.now ?? (() => new Date());

  const readGlobal = async (): Promise<MemoryPolicyRevision[]> => {
    const revisions = await readHistory(paths.memoryGlobalPolicy());
    validateGlobalHistory(revisions);
    return revisions;
  };
  const readAsset = async (targetRef: MemorySubjectRef): Promise<MemoryPolicyRevision[]> =>
    await readHistory(paths.memoryAssetPolicy(targetRef.type, targetRef.id));

  return {
    async getGlobal(at = now()) {
      return globalAt(await readGlobal(), at);
    },

    async updateGlobal(input) {
      const policy = normalizeGlobalPolicy(MemoryGlobalPolicySchema.parse(input.policy));
      const path = paths.memoryGlobalPolicy();
      return await withFileLock(`${path}.lock`, async () => {
        const revisions = await readHistory(path);
        validateGlobalHistory(revisions);
        const updatedAt = now();
        const current = globalAt(revisions, updatedAt);
        assertExpectedRevision(input.expectedRevision, current.revision, "global");
        assertMonotonicTime(revisions, updatedAt, "global");
        const revision = MemoryPolicyRevisionSchema.parse({
          schemaVersion: "pragma.memory-policy/v1",
          scope: "global",
          revision: current.revision + 1,
          effectiveFrom: updatedAt.toISOString(),
          policy,
        }) as Extract<MemoryPolicyRevision, { readonly scope: "global" }>;
        await writeHistory(path, [...revisions, revision]);
        return revision;
      });
    },

    async getOverride(rawTargetRef, at = now()) {
      const targetRef = MemorySubjectRefSchema.parse(rawTargetRef);
      return assetAt(await readAsset(targetRef), targetRef, at);
    },

    async updateOverride(input) {
      const targetRef = MemorySubjectRefSchema.parse(input.targetRef);
      const policy = MemoryAssetPolicyOverrideSchema.parse(input.policy);
      const path = paths.memoryAssetPolicy(targetRef.type, targetRef.id);
      return await withFileLock(`${path}.lock`, async () => {
        const revisions = await readHistory(path);
        validateAssetHistory(revisions, targetRef);
        const updatedAt = now();
        const current = assetAt(revisions, targetRef, updatedAt);
        assertExpectedRevision(input.expectedRevision, current.revision, refKey(targetRef));
        assertMonotonicTime(revisions, updatedAt, refKey(targetRef));
        const revision = MemoryPolicyRevisionSchema.parse({
          schemaVersion: "pragma.memory-policy/v1",
          scope: "asset",
          targetRef,
          revision: current.revision + 1,
          effectiveFrom: updatedAt.toISOString(),
          policy,
        }) as Extract<MemoryPolicyRevision, { readonly scope: "asset" }>;
        await writeHistory(path, [...revisions, revision]);
        return revision;
      });
    },

    async resolveAt(input) {
      const at = new Date(input.occurredAt);
      if (Number.isNaN(at.getTime())) throw new TypeError("Memory policy occurredAt is invalid.");
      const global = globalAt(await readGlobal(), at);
      const refs = uniqueRefs([
        ...(input.rootRef === undefined ? [] : [MemorySubjectRefSchema.parse(input.rootRef)]),
        ...(input.producerRefs ?? []).map((ref) => MemorySubjectRefSchema.parse(ref)),
      ]);
      const overrides = await Promise.all(
        refs.map(async (targetRef) => assetAt(await readAsset(targetRef), targetRef, at)),
      );
      let capture = global.policy.capture === "enabled";
      let recall = global.policy.recall === "enabled";
      let learning = global.policy.learning;
      for (const override of overrides) {
        if (override.policy.capture === "disabled") capture = false;
        if (override.policy.recall === "disabled") recall = false;
        if (override.policy.learning === "disabled") learning = "disabled";
      }
      if (input.missionRestriction?.capture === false) capture = false;
      if (input.missionRestriction?.recall === false) recall = false;
      if (input.missionRestriction?.learning === "disabled") learning = "disabled";
      return EffectiveMemoryPolicySchema.parse({
        capture,
        recall,
        learning,
        appliedRevisions: [
          { scope: "global", revision: global.revision },
          ...overrides.map((override) => ({
            scope: "asset" as const,
            targetRef: override.targetRef,
            revision: override.revision,
          })),
          ...(input.missionRestriction === undefined
            ? []
            : [{ scope: "mission" as const, revision: 0 }]),
        ],
      });
    },
  };
}

function globalAt(
  revisions: readonly MemoryPolicyRevision[],
  at: Date,
): Extract<MemoryPolicyRevision, { readonly scope: "global" }> {
  validateGlobalHistory(revisions);
  const globals = revisions.filter(
    (revision): revision is Extract<MemoryPolicyRevision, { readonly scope: "global" }> =>
      revision.scope === "global",
  );
  const selected = selectAt(globals, at);
  return selected === undefined
    ? {
        schemaVersion: "pragma.memory-policy/v1",
        scope: "global",
        revision: 0,
        effectiveFrom: new Date(0).toISOString(),
        policy: DEFAULT_MEMORY_GLOBAL_POLICY,
      }
    : {
        ...selected,
        policy: normalizeGlobalPolicy(selected.policy),
      };
}

function normalizeGlobalPolicy(policy: MemoryGlobalPolicy): MemoryGlobalPolicy {
  if (policy.capture === "enabled") return policy;
  return {
    ...policy,
    capture: "disabled",
    recall: "disabled",
    learning: "disabled",
  };
}

function assetAt(
  revisions: readonly MemoryPolicyRevision[],
  targetRef: MemorySubjectRef,
  at: Date,
): Extract<MemoryPolicyRevision, { readonly scope: "asset" }> {
  validateAssetHistory(revisions, targetRef);
  const assets = revisions as readonly Extract<MemoryPolicyRevision, { readonly scope: "asset" }>[];
  return (
    selectAt(assets, at) ?? {
      schemaVersion: "pragma.memory-policy/v1",
      scope: "asset",
      targetRef,
      revision: 0,
      effectiveFrom: new Date(0).toISOString(),
      policy: DEFAULT_MEMORY_ASSET_POLICY,
    }
  );
}

function selectAt<T extends MemoryPolicyRevision>(
  revisions: readonly T[],
  at: Date,
): T | undefined {
  return revisions
    .filter((revision) => Date.parse(revision.effectiveFrom) <= at.getTime())
    .toSorted(
      (left, right) =>
        Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom) ||
        right.revision - left.revision,
    )[0];
}

function validateGlobalHistory(revisions: readonly MemoryPolicyRevision[]): void {
  if (revisions.some((revision) => revision.scope !== "global")) {
    throw new Error("Memory global policy history is mixed.");
  }
  validateHistorySequence(revisions, "global");
}

function validateAssetHistory(
  revisions: readonly MemoryPolicyRevision[],
  targetRef: MemorySubjectRef,
): void {
  if (
    revisions.some(
      (revision) => revision.scope !== "asset" || refKey(revision.targetRef) !== refKey(targetRef),
    )
  ) {
    throw new Error(`Memory asset policy history does not match ${refKey(targetRef)}.`);
  }
  validateHistorySequence(revisions, refKey(targetRef));
}

function validateHistorySequence(revisions: readonly MemoryPolicyRevision[], target: string): void {
  for (const [index, revision] of revisions.entries()) {
    if (revision.revision !== index + 1) {
      throw new Error(`Memory policy revision history is not contiguous for ${target}.`);
    }
    const previous = revisions[index - 1];
    if (
      previous !== undefined &&
      Date.parse(revision.effectiveFrom) < Date.parse(previous.effectiveFrom)
    ) {
      throw new Error(`Memory policy effective time moved backwards for ${target}.`);
    }
  }
}

function assertMonotonicTime(
  revisions: readonly MemoryPolicyRevision[],
  updatedAt: Date,
  target: string,
): void {
  const latest = revisions.at(-1);
  if (latest !== undefined && updatedAt.getTime() < Date.parse(latest.effectiveFrom)) {
    throw new Error(`Memory policy clock moved behind the latest revision for ${target}.`);
  }
}

async function readHistory(path: string): Promise<MemoryPolicyRevision[]> {
  try {
    return PolicyHistoryFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).revisions;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function writeHistory(
  path: string,
  revisions: readonly MemoryPolicyRevision[],
): Promise<void> {
  const file = PolicyHistoryFileSchema.parse({
    schemaVersion: "pragma.memory-policy-history/v1",
    revisions,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function assertExpectedRevision(expected: number, actual: number, target: string): void {
  if (expected !== actual) {
    const error = new Error(`Memory policy revision conflict for ${target}.`);
    Object.assign(error, { code: "memory_policy_revision_conflict", expected, actual });
    throw error;
  }
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
