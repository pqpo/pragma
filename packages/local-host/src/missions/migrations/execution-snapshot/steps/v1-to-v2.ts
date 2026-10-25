import { formatPragmaYaml, migratePragmaDslProjectToCurrent } from "@pragma/interpreter";
import { MissionExecutionSnapshotSchema } from "../../../execution-snapshot.ts";
import { HistoricalSnapshotSchema } from "../schemas/v1.ts";
export const executionSnapshotV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  migrate(value: unknown) {
    const legacy = HistoricalSnapshotSchema.parse(value);
    const migrateResources = (resources: readonly unknown[]) => {
      if (resources.length === 0) return [];
      const version = (resources[0] as { apiVersion: string }).apiVersion;
      return migratePragmaDslProjectToCurrent({
        projectId: legacy.project.id,
        files: new Map([
          ["pragma.yaml", formatPragmaYaml({ apiVersion: version, kind: "Bundle", resources })],
        ]),
      }).resources;
    };
    return MissionExecutionSnapshotSchema.parse({
      ...legacy,
      schemaVersion: "pragma.mission-execution-snapshot/v2",
      resources: migrateResources(legacy.resources),
      sources: Object.fromEntries(
        Object.entries(legacy.sources).map(([ref, entry]) => [
          ref,
          {
            ...entry,
            additionalResources: migrateResources(entry.additionalResources),
            ...(entry.expertResource === undefined
              ? {}
              : { expertResource: migrateResources([entry.expertResource])[0] }),
          },
        ]),
      ),
    });
  },
} as const;
