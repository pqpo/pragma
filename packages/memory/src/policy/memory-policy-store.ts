import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  EffectiveMemoryPolicySchema,
  MemoryAssetPolicyOverrideSchema,
  MemoryGlobalPolicySchema,
  MemoryPolicyRevisionV1Schema,
  MemoryPolicyRevisionSchema,
  MemorySubjectRefSchema,
  type EffectiveMemoryPolicy,
  type MemoryAssetPolicyOverride,
  type MemoryGlobalPolicy,
  type MemoryPolicyRevisionV1,
  type MemoryPolicyRevision,
  type MemorySubjectRef,
} from "@pragma/shared";
import { z } from "zod";

const PolicyHistoryFileV1Schema = z.object({
  schemaVersion: z.literal("pragma.memory-policy-history/v1"),
  revisions: z.array(MemoryPolicyRevisionV1Schema).max(10_000),
});

const PolicyHistoryFileV2Schema = z.object({
  schemaVersion: z.literal("pragma.memory-policy-history/v2"),
  revisions: z.array(MemoryPolicyRevisionSchema).max(10_000),
});

const PolicyMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.memory-policy-migration-journal/v1"),
  sourceSchemaVersion: z.literal("pragma.memory-policy-history/v1"),
  targetSchemaVersion: z.literal("pragma.memory-policy-history/v2"),
  sourcePath: z.string().min(1),
  backupPath: z.string().min(1),
});

type PolicyHistoryFileV1 = z.infer<typeof PolicyHistoryFileV1Schema>;
type PolicyHistoryFileV2 = z.infer<typeof PolicyHistoryFileV2Schema>;
type PolicyHistoryFile = PolicyHistoryFileV1 | PolicyHistoryFileV2;
type GlobalPolicyRevision = Extract<MemoryPolicyRevision, { readonly scope: "global" }>;
type AssetPolicyRevision = Extract<MemoryPolicyRevision, { readonly scope: "asset" }>;
type LegacyGlobalPolicyRevision = Extract<MemoryPolicyRevisionV1, { readonly scope: "global" }>;

export const DEFAULT_MEMORY_GLOBAL_POLICY: MemoryGlobalPolicy = {
  enabled: "disabled",
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

  const readGlobal = async (): Promise<GlobalPolicyRevision[]> => {
    const path = paths.memoryGlobalPolicy();
    return await withFileLock(`${path}.lock`, async () => await readCurrentGlobalHistory(path));
  };
  const readAsset = async (targetRef: MemorySubjectRef): Promise<AssetPolicyRevision[]> => {
    const file = await readHistoryFile(paths.memoryAssetPolicy(targetRef.type, targetRef.id));
    if (file === undefined) return [];
    const revisions = file.revisions as unknown as readonly AssetPolicyRevision[];
    validateAssetHistory(revisions, targetRef);
    return revisions as AssetPolicyRevision[];
  };

  return {
    async getGlobal(at = now()) {
      return globalAt(await readGlobal(), at);
    },

    async updateGlobal(input) {
      const policy = MemoryGlobalPolicySchema.parse(input.policy);
      const path = paths.memoryGlobalPolicy();
      return await withFileLock(`${path}.lock`, async () => {
        const revisions = await readCurrentGlobalHistory(path);
        const updatedAt = now();
        const current = globalAt(revisions, updatedAt);
        assertExpectedRevision(input.expectedRevision, current.revision, "global");
        assertMonotonicTime(revisions, updatedAt, "global");
        const revision = MemoryPolicyRevisionSchema.parse({
          schemaVersion: "pragma.memory-policy/v2",
          scope: "global",
          revision: current.revision + 1,
          effectiveFrom: updatedAt.toISOString(),
          policy,
        }) as GlobalPolicyRevision;
        await writeHistory(path, [...revisions, revision], "global");
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
        const revisions = await readAsset(targetRef);
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
        }) as AssetPolicyRevision;
        await writeHistory(path, [...revisions, revision], "asset");
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
      const memoryEnabled = global.policy.enabled === "enabled";
      let capture = memoryEnabled && global.policy.capture === "enabled";
      let recall = memoryEnabled && global.policy.recall === "enabled";
      let learning = memoryEnabled ? global.policy.learning : "disabled";
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

function globalAt(revisions: readonly GlobalPolicyRevision[], at: Date): GlobalPolicyRevision {
  validateGlobalHistory(revisions);
  const selected = selectAt(revisions, at);
  return selected === undefined
    ? {
        schemaVersion: "pragma.memory-policy/v2",
        scope: "global",
        revision: 0,
        effectiveFrom: new Date(0).toISOString(),
        policy: DEFAULT_MEMORY_GLOBAL_POLICY,
      }
    : selected;
}

function assetAt(
  revisions: readonly AssetPolicyRevision[],
  targetRef: MemorySubjectRef,
  at: Date,
): AssetPolicyRevision {
  validateAssetHistory(revisions, targetRef);
  return (
    selectAt(revisions, at) ?? {
      schemaVersion: "pragma.memory-policy/v1",
      scope: "asset",
      targetRef,
      revision: 0,
      effectiveFrom: new Date(0).toISOString(),
      policy: DEFAULT_MEMORY_ASSET_POLICY,
    }
  );
}

function selectAt<T extends { readonly revision: number; readonly effectiveFrom: string }>(
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

function validateGlobalHistory(revisions: readonly GlobalPolicyRevision[]): void {
  if (revisions.some((revision) => revision.scope !== "global")) {
    throw new Error("Memory global policy history is mixed.");
  }
  validateHistorySequence(revisions, "global");
}

function validateAssetHistory(
  revisions: readonly AssetPolicyRevision[],
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

function validateLegacyGlobalHistory(revisions: readonly MemoryPolicyRevisionV1[]): void {
  if (revisions.some((revision) => revision.scope !== "global")) {
    throw new Error("Memory global policy history is mixed.");
  }
  validateHistorySequence(revisions, "global");
}

function validateHistorySequence(
  revisions: readonly { readonly revision: number; readonly effectiveFrom: string }[],
  target: string,
): void {
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

async function readCurrentGlobalHistory(path: string): Promise<GlobalPolicyRevision[]> {
  await recoverPolicyMigration(path);
  const file = await readHistoryFile(path);
  if (file === undefined) return [];
  if (file.schemaVersion === "pragma.memory-policy-history/v2") {
    const revisions = file.revisions as unknown as readonly GlobalPolicyRevision[];
    validateGlobalHistory(revisions);
    return [...revisions];
  }
  validateLegacyGlobalHistory(file.revisions);
  return await migrateGlobalHistory(path, file.revisions as readonly LegacyGlobalPolicyRevision[]);
}

async function readHistoryFile(path: string): Promise<PolicyHistoryFile | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const current = PolicyHistoryFileV2Schema.safeParse(value);
    if (current.success) return current.data;
    return PolicyHistoryFileV1Schema.parse(value);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeHistory(
  path: string,
  revisions: readonly MemoryPolicyRevision[],
  scope: "global" | "asset",
): Promise<void> {
  const file =
    scope === "global"
      ? PolicyHistoryFileV2Schema.parse({
          schemaVersion: "pragma.memory-policy-history/v2",
          revisions,
        })
      : PolicyHistoryFileV1Schema.parse({
          schemaVersion: "pragma.memory-policy-history/v1",
          revisions,
        });
  await writeJsonAtomically(path, file);
}

async function migrateGlobalHistory(
  path: string,
  revisions: readonly LegacyGlobalPolicyRevision[],
): Promise<GlobalPolicyRevision[]> {
  const backupPath = `${path}.v1-backup`;
  const journalPath = `${path}.migration-journal`;
  const journal = PolicyMigrationJournalSchema.parse({
    schemaVersion: "pragma.memory-policy-migration-journal/v1",
    sourceSchemaVersion: "pragma.memory-policy-history/v1",
    targetSchemaVersion: "pragma.memory-policy-history/v2",
    sourcePath: path,
    backupPath,
  });
  await writeJsonAtomically(journalPath, journal);
  await ensureBackup(path, backupPath);
  const migrated = revisions.map(
    (revision) =>
      MemoryPolicyRevisionSchema.parse({
        ...revision,
        schemaVersion: "pragma.memory-policy/v2",
        policy: {
          ...revision.policy,
          enabled: revision.policy.capture,
        },
      }) as GlobalPolicyRevision,
  );
  await writeHistory(path, migrated, "global");
  await unlink(journalPath).catch(() => undefined);
  return migrated;
}

async function recoverPolicyMigration(path: string): Promise<void> {
  const journalPath = `${path}.migration-journal`;
  let journal: z.infer<typeof PolicyMigrationJournalSchema>;
  try {
    journal = PolicyMigrationJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (journal.sourcePath !== path || journal.backupPath !== `${path}.v1-backup`) {
    throw new Error("Memory policy migration journal does not match its policy path.");
  }
  const file = await readHistoryFile(path);
  if (file?.schemaVersion === "pragma.memory-policy-history/v2") {
    await unlink(journalPath).catch(() => undefined);
    return;
  }
  if (file?.schemaVersion !== "pragma.memory-policy-history/v1") {
    throw new Error("Memory policy migration journal has no recoverable source history.");
  }
}

async function ensureBackup(sourcePath: string, backupPath: string): Promise<void> {
  try {
    await stat(backupPath);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${backupPath}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporary);
    await rename(temporary, backupPath);
    await chmod(backupPath, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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
