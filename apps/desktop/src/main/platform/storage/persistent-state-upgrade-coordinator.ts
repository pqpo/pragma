import type { PragmaLogger } from "@pragma/core";

import type { MissionStore } from "../../features/missions/mission-store.ts";
import type { PragmaProjectStore } from "../../features/projects/pragma-project-store.ts";

export interface PersistentStateUpgradeDiagnostic {
  readonly ownerKind: "project" | "mission";
  readonly ownerId: string;
  readonly code: "upgrade_failed";
  readonly message: string;
}

export async function runPersistentStateUpgradeCoordinator(input: {
  readonly project: PragmaProjectStore;
  readonly missions: MissionStore;
  readonly logger: PragmaLogger;
}): Promise<readonly PersistentStateUpgradeDiagnostic[]> {
  const diagnostics: PersistentStateUpgradeDiagnostic[] = [];
  try {
    await input.project.get();
    await input.project.readIdentityMigrations();
  } catch (error) {
    diagnostics.push({
      ownerKind: "project",
      ownerId: input.project.projectId,
      code: "upgrade_failed",
      message: errorMessage(error),
    });
    input.logger.warn("desktop.project_upgrade_failed", "Project state upgrade failed.", {
      projectId: input.project.projectId,
      error,
    });
  }

  const missionIds = await input.missions
    .list()
    .then((missions) => missions.map((mission) => mission.id))
    .catch((error: unknown) => {
      diagnostics.push({
        ownerKind: "mission",
        ownerId: "*",
        code: "upgrade_failed",
        message: errorMessage(error),
      });
      input.logger.warn("desktop.mission_list_upgrade_failed", "Mission state listing failed.", {
        error,
      });
      return undefined;
    });
  if (missionIds === undefined) {
    return diagnostics;
  }

  for (const missionId of missionIds) {
    try {
      await input.missions.get(missionId);
    } catch (error) {
      diagnostics.push({
        ownerKind: "mission",
        ownerId: missionId,
        code: "upgrade_failed",
        message: errorMessage(error),
      });
      input.logger.warn("desktop.mission_upgrade_failed", "Mission state upgrade failed.", {
        missionId,
        error,
      });
    }
  }
  if (diagnostics.length === 0) {
    input.logger.info(
      "desktop.persistent_state_upgrade_checked",
      "Persistent state upgrade checks completed.",
    );
  }
  return diagnostics;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
