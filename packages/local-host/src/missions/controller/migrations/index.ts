/**
 * Local Host owns this v1 persistence family. There is intentionally no migration
 * step yet: v1 is the first released representation. Future versions must add
 * adjacent steps here; business code only consumes the current schema.
 */
export const MISSION_AGGREGATE_STORAGE_MIGRATIONS = [] as const;
