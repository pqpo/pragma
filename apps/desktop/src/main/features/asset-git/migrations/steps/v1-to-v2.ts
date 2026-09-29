import { AssetGitRecordV1Schema, AssetGitJournalV1Schema } from "../schemas/v1.ts";

export const assetGitV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  record(value: unknown) {
    return {
      ...AssetGitRecordV1Schema.parse(value),
      schemaVersion: "pragma.asset-git/v2" as const,
      knowledgeMetadataVersion: 0 as const,
    };
  },
  journal(value: unknown) {
    return {
      ...AssetGitJournalV1Schema.parse(value),
      schemaVersion: "pragma.asset-git-journal/v2" as const,
      knowledgeMetadataVersion: 0 as const,
    };
  },
} as const;
