import { KnowledgeSourceSnapshotSchema, type KnowledgeSourceSnapshot } from "@pragma/shared";

export interface KnowledgeSourceReader {
  listEligibleSources(input: {
    readonly rootRef: KnowledgeSourceSnapshot["rootRef"];
    readonly executionId?: string | undefined;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly KnowledgeSourceSnapshot[]>;
}

export function parseKnowledgeSourceSnapshot(input: unknown): KnowledgeSourceSnapshot {
  return KnowledgeSourceSnapshotSchema.parse(input);
}
