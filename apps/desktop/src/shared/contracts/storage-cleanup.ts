import { z } from "zod";
import { MissionIdSchema } from "@pragma/shared";

const BytesSchema = z.number().int().nonnegative();

export const DesktopStorageCleanupOverviewSchema = z.object({
  storage: z.object({
    totalBytes: BytesSchema,
    dataBytes: BytesSchema,
    stateBytes: BytesSchema,
    archiveBytes: BytesSchema,
    cacheBytes: BytesSchema,
    temporaryBytes: BytesSchema,
    trashBytes: BytesSchema,
    softLimitBytes: BytesSchema,
    hardLimitBytes: BytesSchema,
  }),
  workspaceBytes: BytesSchema,
  clearableCacheBytes: BytesSchema,
  clearableCacheEntries: BytesSchema,
  clearableTrashBytes: BytesSchema,
  clearableTrashEntries: BytesSchema,
});

export const DesktopStorageCleanupResultSchema = z.object({
  beforeBytes: BytesSchema,
  afterBytes: BytesSchema,
  deletedEntries: BytesSchema,
  reclaimedBytes: BytesSchema,
});

export const DeleteCompletedTaskMissionSchema = z.object({
  id: MissionIdSchema,
});

export type DesktopStorageCleanupOverview = z.infer<typeof DesktopStorageCleanupOverviewSchema>;
export type DesktopStorageCleanupResult = z.infer<typeof DesktopStorageCleanupResultSchema>;
