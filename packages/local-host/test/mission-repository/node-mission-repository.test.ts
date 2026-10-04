import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";

import { createNodeMissionRepository } from "../../src/missions/node-mission-repository.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import type { LocalHostRunRequest, ResolvedRunExecutor } from "../../src/run.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("persists the real reserved request and preserves historical controller-only Missions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-node-mission-repository-"));
  roots.push(root);
  const store = createMissionStore({ missionsPath: join(root, "missions") });
  const controller = createMissionControllerStore({
    missionsPath: join(root, "missions"),
    missionPath: store.storagePath,
  });
  const owners = createMissionOwnerScope({ controller });
  const repository = createNodeMissionRepository({ store, controller });
  const request: LocalHostRunRequest = {
    requestId: randomUUID(),
    command: "expert.run",
    executor: { kind: "expert", id: "7k2m9q4v8np6r3dt" },
    workspace: {
      schemaVersion: "pragma.integration-workspace/v1",
      requestedPath: root,
      canonicalPath: root,
      displayName: "workspace",
      identityHash: `sha256:${"a".repeat(64)}`,
      access: { exists: true, readable: true, writable: true },
      source: "explicit",
    },
    project: { projectId: "project", revision: 2 },
    prompt: "Actual first prompt",
    detach: false,
  };
  const executor: ResolvedRunExecutor = {
    descriptor: {
      schemaVersion: "pragma.integration-executor/v1",
      ref: request.executor,
      name: "Expert",
      description: "",
      source: "project",
      project: { projectId: "project", revision: 2, fingerprint: "a".repeat(64) },
      availability: { status: "ready", blockingCodes: [] },
      workspace: { required: true, allowNonGitDirectory: true },
      capabilities: { interactive: true, resumable: true, steerable: true, supportsQueue: true },
    },
  };
  const missionId = randomUUID();
  await owners.acquire(missionId);
  const created = await repository.ensureFreshMission({ missionId, request, executor });
  expect(created).toMatchObject({
    initialMessageId: request.requestId,
    goal: request.prompt,
    project: { id: "project", revision: 2 },
  });
  expect((await store.readTimelinePage(missionId, { limit: 10 })).turns).toMatchObject([
    { message: { id: request.requestId, content: request.prompt } },
  ]);
  expect(await repository.ensureFreshMission({ missionId, request, executor })).toEqual(created);
  const staging = join(store.storagePath!(missionId), ".mission-create.transaction");
  await mkdir(staging);
  await rename(join(store.storagePath!(missionId), "mission.yaml"), join(staging, "mission.yaml"));
  await rename(
    join(store.storagePath!(missionId), "attachments.json"),
    join(staging, "attachments.json"),
  );
  // messages.jsonl is already published: replay finishes only the missing files.
  expect(await createMissionStore({ missionsPath: join(root, "missions") }).get(missionId)).toEqual(
    created,
  );
  expect((await store.readTimelinePage(missionId, { limit: 10 })).turns).toHaveLength(1);
  await owners.release(missionId);

  const legacyId = randomUUID();
  const legacyGuard = await owners.acquire(legacyId);
  await controller.write({
    missionId: legacyId,
    guard: legacyGuard,
    operation: async ({ appendEvent }) => {
      await appendEvent("mission.created", { requestId: request.requestId });
    },
  });
  expect(
    await repository.ensureFreshMission({ missionId: legacyId, request, executor }),
  ).toBeUndefined();
  await expect(store.get(legacyId)).rejects.toMatchObject({ code: "mission_not_found" });
  await owners.release(legacyId);

  const builtInId = randomUUID();
  await owners.acquire(builtInId);
  const builtin = {
    descriptor: { ...executor.descriptor, source: "built_in" as const, project: undefined },
  };
  expect(
    await repository.ensureFreshMission({ missionId: builtInId, request, executor: builtin }),
  ).toBeUndefined();
  await expect(store.get(builtInId)).rejects.toMatchObject({ code: "mission_not_found" });
  await owners.release(builtInId);
});

it("retains a conflicting staged create without replacing the published Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-node-mission-create-conflict-"));
  roots.push(root);
  const store = createMissionStore({ missionsPath: join(root, "missions") });
  const mission = await store.create({
    workspace: { path: root, basename: "workspace" },
    goal: "Published owner",
    project: { id: "project", revision: 1 },
    executor: { kind: "expert", ref: "expert:7k2m9q4v8np6r3dt", name: "Expert" },
  });
  const missionPath = store.storagePath!(mission.id);
  const staged = join(missionPath, ".mission-create.transaction");
  await mkdir(staged);
  await writeFile(
    join(staged, "mission.yaml"),
    formatPragmaYaml({ ...mission, initialMessageId: randomUUID() }),
  );
  await expect(store.get(mission.id)).rejects.toMatchObject({ code: "message_conflict" });
  expect(parsePragmaYaml(await readFile(join(missionPath, "mission.yaml"), "utf8"))).toEqual(
    mission,
  );
  expect(await readFile(join(staged, "mission.yaml"), "utf8")).toContain("Published owner");
});
