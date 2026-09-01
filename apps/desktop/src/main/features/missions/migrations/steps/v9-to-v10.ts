import { MissionSchema } from "../../../../../shared/contracts/missions.ts";
import { MissionV9Schema } from "../schemas/v9.ts";

export const missionV9ToV10Step = {
  from: "pragma.mission/v9",
  to: "pragma.mission/v10",
  migrate(input: unknown) {
    const legacy = MissionV9Schema.parse(input);
    const { contextStoreIds, ...rest } = legacy;
    return MissionSchema.parse({
      ...rest,
      schemaVersion: "pragma.mission/v10",
      contextMounts: contextStoreIds.map((storeId) => ({
        kind: "context-store" as const,
        storeId,
      })),
    });
  },
} as const;
