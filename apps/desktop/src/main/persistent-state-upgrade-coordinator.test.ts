import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoggerProvider } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createMissionStore } from "./mission-store.ts";
import { runPersistentStateUpgradeCoordinator } from "./persistent-state-upgrade-coordinator.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("persistent state upgrade coordinator", () => {
  it("checks project and Mission state through Host store boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-upgrade-coordinator-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const logger = createLoggerProvider({
      handler: { write: () => undefined },
      minimumLevel: "silent",
    }).createLogger({ component: "test" });

    await expect(
      runPersistentStateUpgradeCoordinator({ project, missions, logger }),
    ).resolves.toEqual([]);
  });
});
