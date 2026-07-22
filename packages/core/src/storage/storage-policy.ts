export interface StoragePolicy {
  readonly schemaVersion: "pragma.storage-policy/v1";
  readonly globalSoftLimitBytes: number;
  readonly globalHardLimitBytes: number;
  readonly cacheLimitBytes: number;
  readonly cacheTtlMs: number;
  readonly projectViewTtlMs: number;
  readonly executionArchiveLimitBytes: number;
  readonly executionArchiveTtlMs: number;
  readonly temporaryTtlMs: number;
  readonly trashTtlMs: number;
  readonly contentGcGraceMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const GIB = 1_024 * 1_024 * 1_024;
const MIB = 1_024 * 1_024;

export const DEFAULT_STORAGE_POLICY: StoragePolicy = Object.freeze({
  schemaVersion: "pragma.storage-policy/v1",
  globalSoftLimitBytes: 4 * GIB,
  globalHardLimitBytes: 6 * GIB,
  cacheLimitBytes: GIB,
  cacheTtlMs: 30 * DAY_MS,
  projectViewTtlMs: 7 * DAY_MS,
  executionArchiveLimitBytes: 512 * MIB,
  executionArchiveTtlMs: 90 * DAY_MS,
  temporaryTtlMs: DAY_MS,
  trashTtlMs: 7 * DAY_MS,
  contentGcGraceMs: DAY_MS,
});
