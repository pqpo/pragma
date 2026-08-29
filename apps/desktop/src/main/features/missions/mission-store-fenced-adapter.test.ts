import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMissionControllerStore, createMissionOwnerScope } from "@pragma/local-host";
import { PRAGMA_DSL_WRITE_API_VERSION, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it } from "vitest";

import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import { createMissionStore } from "./mission-store.ts";
import { createFencedMissionStore } from "./mission-store-fenced-adapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(
        async (root) =>
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});

describe("Desktop fenced MissionStore adapter", () => {
  it("uses the shared Local Host owner scope for semantic writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-fenced-store-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Check the shared owner boundary",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const controller = createMissionControllerStore({ missionsPath });
    const ownerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const fencedStore = createFencedMissionStore(rawStore, {
      controller,
      ownerScope,
      setSemanticWriteReplay: () => undefined,
    });

    await ownerScope.acquire(mission.id);
    await fencedStore.updateOptions(mission.id, { toolPermissionMode: "full-access" });
    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "full-access",
    });
    await expect(controller.readSnapshot({ missionId: mission.id })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "mission.options.updated" })],
    });
    await ownerScope.release(mission.id);

    const competingOwner = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    await competingOwner.acquire(mission.id);
    await expect(
      fencedStore.updateOptions(mission.id, { toolPermissionMode: "request-approval" }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await competingOwner.release(mission.id);
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      avatarId: "pragma.avatar.expert.default",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
