export interface MemoryStoragePolicy {
  readonly schemaVersion: "pragma.memory-storage-policy/v1";
  readonly canonicalFeedRetentionMs: number;
  readonly canonicalFeedTargetBytes: number;
  readonly evidenceMaxRecordsPerExecution: number;
  readonly evidenceMaxBytesPerExecution: number;
  readonly extractionPromptMaxBytes: number;
  readonly jobRecordRetentionMs: number;
  readonly failedPayloadRetentionMs: number;
  readonly expiredDiagnosticRetentionMs: number;
  readonly deadLetterRetentionMs: number;
  readonly deadLetterMaxEntries: number;
  readonly deadLetterMaxBytes: number;
  readonly maintenanceIntervalMs: number;
  readonly curatorOrphanGraceMs: number;
  readonly curatorRegistryMaxEntries: number;
  readonly atomicTempRetentionMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIB = 1_024 * 1_024;

export const DEFAULT_MEMORY_STORAGE_POLICY: MemoryStoragePolicy = Object.freeze({
  schemaVersion: "pragma.memory-storage-policy/v1",
  canonicalFeedRetentionMs: 30 * DAY_MS,
  canonicalFeedTargetBytes: 512 * MIB,
  evidenceMaxRecordsPerExecution: 2_000,
  evidenceMaxBytesPerExecution: 16 * MIB,
  extractionPromptMaxBytes: 78_000,
  jobRecordRetentionMs: 30 * DAY_MS,
  failedPayloadRetentionMs: 30 * DAY_MS,
  expiredDiagnosticRetentionMs: 30 * DAY_MS,
  deadLetterRetentionMs: 30 * DAY_MS,
  deadLetterMaxEntries: 10_000,
  deadLetterMaxBytes: 64 * MIB,
  maintenanceIntervalMs: 60 * 60 * 1_000,
  curatorOrphanGraceMs: DAY_MS,
  curatorRegistryMaxEntries: 1_000,
  atomicTempRetentionMs: DAY_MS,
});
