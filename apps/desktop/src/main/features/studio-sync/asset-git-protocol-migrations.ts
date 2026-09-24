import {
  KnowledgeSyncRepositoryManifestSchema,
  KnowledgeSyncRepositoryManifestV1Schema,
  KnowledgeSyncStoreManifestSchema,
  KnowledgeSyncStoreManifestV1Schema,
  SkillSyncRepositoryManifestSchema,
  SkillSyncRepositoryManifestV1Schema,
  SkillSyncRepositoryManifestV2Schema,
  SkillSyncSkillManifestSchema,
  SkillSyncSkillManifestV1Schema,
  SkillSyncSkillManifestV2Schema,
} from "../../../shared/contracts/index.ts";

/** Adjacent migrations for the Git environment-backup wire format. Git history is the source backup. */
export function upgradeKnowledgeRepositoryManifest(input: unknown) {
  if (KnowledgeSyncRepositoryManifestSchema.safeParse(input).success)
    return KnowledgeSyncRepositoryManifestSchema.parse(input);
  KnowledgeSyncRepositoryManifestV1Schema.parse(input);
  return KnowledgeSyncRepositoryManifestSchema.parse({ schemaVersion: "pragma.knowledge-sync/v2" });
}

export function upgradeKnowledgeStoreManifest(input: unknown) {
  if (KnowledgeSyncStoreManifestSchema.safeParse(input).success)
    return KnowledgeSyncStoreManifestSchema.parse(input);
  const previous = KnowledgeSyncStoreManifestV1Schema.parse(input);
  return KnowledgeSyncStoreManifestSchema.parse({
    ...previous,
    schemaVersion: "pragma.knowledge-sync-store/v2",
  });
}

export function upgradeSkillRepositoryManifest(input: unknown) {
  if (SkillSyncRepositoryManifestSchema.safeParse(input).success)
    return SkillSyncRepositoryManifestSchema.parse(input);
  const v2 = SkillSyncRepositoryManifestV2Schema.safeParse(input).success
    ? SkillSyncRepositoryManifestV2Schema.parse(input)
    : SkillSyncRepositoryManifestV2Schema.parse({
        ...SkillSyncRepositoryManifestV1Schema.parse(input),
        schemaVersion: "pragma.skill-sync/v2",
      });
  return SkillSyncRepositoryManifestSchema.parse({ ...v2, schemaVersion: "pragma.skill-sync/v3" });
}

export function upgradeSkillManifest(input: unknown) {
  if (SkillSyncSkillManifestSchema.safeParse(input).success)
    return SkillSyncSkillManifestSchema.parse(input);
  const v2 = SkillSyncSkillManifestV2Schema.safeParse(input).success
    ? SkillSyncSkillManifestV2Schema.parse(input)
    : (() => {
        const v1 = SkillSyncSkillManifestV1Schema.parse(input);
        if (v1.identity.kind !== "capability")
          throw new Error("Legacy Bundle Skill identities are unsupported.");
        return SkillSyncSkillManifestV2Schema.parse({
          ...v1,
          schemaVersion: "pragma.skill-sync-skill/v2",
        });
      })();
  return SkillSyncSkillManifestSchema.parse({ ...v2, schemaVersion: "pragma.skill-sync-skill/v3" });
}
