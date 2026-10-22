import {
  ContextStoreRevisionRequestSchema,
  SkillRevisionRequestV4Schema,
} from "@pragma/built-in-agents";
import { PragmaPaths, runTransientStorageMaintenance, type RuntimeResolver } from "@pragma/core";
import { createMissionStore, type LocalHostMissionApplication } from "@pragma/local-host";
import { createPragmaProjectStore } from "@pragma/local-host/deployment";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopSkillAgents } from "../capabilities/skill-agents.ts";
import { createDesktopStoreRevisionAgent } from "../context-stores/store-revision-agent.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { prepareRevisionPromptInput } from "./revision-prompt-input.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "pragma-revision-input-"));
  roots.push(root);
  return root;
}

describe("revision Mission prompt transport", () => {
  it("preserves ordinary inline requests without allocating attachments", async () => {
    const pragmaHome = await temporaryRoot();
    const goal = "x".repeat(100_000);
    expect(await prepareRevisionPromptInput({ pragmaHome, goal })).toEqual({ goal });
    expect(await readdir(pragmaHome)).toEqual([]);
  });

  it.each(["knowledge", "skill"] as const)(
    "persists a maximum-size %s request through the real Mission repository",
    async (kind) => {
      const root = await temporaryRoot();
      const draftWorkspace = join(root, "draft-payload");
      await mkdir(draftWorkspace);
      const missions = createMissionStore({ missionsPath: join(root, "missions") });
      const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
      const stopped = new Error("runtime_not_invoked_in_transport_test");
      const startRun = vi.fn(async () => {
        throw stopped;
      });
      let createdMissionId: string | undefined;
      const common = {
        missions,
        project,
        pragmaHome: root,
        onMissionCreated: async ({ missionId }: { missionId: string }) => {
          createdMissionId = missionId;
        },
        application: { startRun } as unknown as LocalHostMissionApplication,
        runtimes: {} as RuntimeResolver,
      };
      const prompt = `${"证".repeat(409_990)}END_MARKER`;
      const jobId = randomUUID();
      const draftId = randomUUID();
      if (kind === "knowledge") {
        const agent = createDesktopStoreRevisionAgent(common);
        const storeId = randomUUID();
        await expect(
          agent.generator.generate({
            jobId,
            draftId,
            request: ContextStoreRevisionRequestSchema.parse({
              schemaVersion: "pragma.context-store-revision-request/v2",
              operation: "revise",
              storeId,
              prompt,
              source: "memory-learning",
              sourceDigest: "a".repeat(64),
            }),
            snapshot: {
              schemaVersion: "pragma.context-store-snapshot/v1",
              storeId,
              revision: 1,
              snapshotHash: "b".repeat(64),
              createdAt: new Date().toISOString(),
              directories: [],
              files: [],
            },
          }),
        ).rejects.toBe(stopped);
      } else {
        const agent = createDesktopSkillAgents({
          ...common,
          systemExperts: {} as DesktopSystemExpertRegistry,
          resolveDraftWorkspace: async () => draftWorkspace,
        });
        await expect(
          agent.revisionGenerator.generate({
            jobId,
            draftId,
            request: SkillRevisionRequestV4Schema.parse({
              schemaVersion: "pragma.skill-revision-request/v4",
              operation: "revise",
              capabilityId: "1h2j3k4m5n6p7q8r",
              prompt,
              source: "memory-learning",
              sourceDigest: "a".repeat(64),
              sourceRefs: [],
            }),
            current: {
              name: "Example",
              description: "Example",
              files: [{ path: "SKILL.md", content: "Example" }],
            },
            revision: 1,
            contentHash: "b".repeat(64),
          }),
        ).rejects.toBe(stopped);
      }
      expect(createdMissionId).toBeDefined();
      const paths = new PragmaPaths({ pragmaHome: root });
      const stagingRoot = join(paths.temporaryRoot(), "revision-inputs");
      expect(await readdir(stagingRoot)).toHaveLength(1);
      await runTransientStorageMaintenance({ paths, now: Date.now() + 25 * 60 * 60 * 1000 });
      await expect(readdir(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const reopened = createMissionStore({ missionsPath: join(root, "missions") });
      const mission = await reopened.get(createdMissionId!);
      expect(mission.goal.length).toBeLessThan(100_000);
      expect(mission.goal).toContain("in full");
      const [attachment] = await reopened.getAttachments(mission.id);
      expect(attachment?.kind).toBe("file");
      expect(attachment!.path).toBe(
        join(reopened.storagePath!(mission.id), "attachments", "files", attachment!.id),
      );
      expect(await reopened.getPromptAttachments(mission.id, mission.initialMessageId)).toEqual([
        attachment,
      ]);
      const body = await readFile(attachment!.path, "utf8");
      expect(body).toContain(prompt);
      expect(body).toContain(draftId);
      expect(attachment!.size).toBe(Buffer.byteLength(body));
      expect(await readdir(draftWorkspace)).toEqual([]);
      expect(startRun).toHaveBeenCalledWith(mission.id);
      // Retry consumes the canonical attachment, after the staging file was collected.
      startRun.mockImplementationOnce(async () => {
        const [input] = await reopened.getPromptAttachments(mission.id, mission.initialMessageId);
        expect(await readFile(input!.path, "utf8")).toContain(prompt);
        throw stopped;
      });
      await expect(startRun()).rejects.toBe(stopped);
      await reopened.remove(mission.id);
      await expect(readFile(attachment!.path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
