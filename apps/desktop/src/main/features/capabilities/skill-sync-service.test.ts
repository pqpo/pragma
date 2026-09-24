import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { Capability, SkillSyncConfiguration } from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";
import {
  createSkillSyncService,
  createGitSkillSyncProvider,
  type RemoteSkill,
  type RemoteSkillRepository,
  type SkillSyncProvider,
} from "./skill-sync-service.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Skill sync service", () => {
  it("merges the target and publishes local Skills during configuration", async () => {
    const fixture = await createFixture();
    const localId = "10101010-1010-4010-8010-101010101010";
    const remoteId = "20202020-2020-4020-8020-202020202020";
    await fixture.addLocalSkill(localId, "Local Skill");
    fixture.provider.repository.skills.set(
      `capability/${remoteId}`,
      remoteSkill({ kind: "capability", id: remoteId }, "Remote Skill"),
    );

    const overview = await fixture.service.configure({
      ...configuration(),
      initializationMode: "merge_and_publish",
    });

    expect(overview.status).toBe("ready");
    expect(fixture.capabilities.has(remoteId)).toBe(true);
    expect([...fixture.provider.repository.skills.keys()].toSorted()).toEqual([
      `capability/${localId}`,
      `capability/${remoteId}`,
    ]);
  });

  it("publishes a local Skill and imports a remote Skill by local Capability identity", async () => {
    const fixture = await createFixture();
    const local = await fixture.addLocalSkill(
      "11111111-1111-4111-8111-111111111111",
      "Local Skill",
    );

    await fixture.service.configure(configuration());

    expect(fixture.provider.repository.skills.get(`capability/${local.manifest.id}`)?.name).toBe(
      "Local Skill",
    );

    const remoteId = "22222222-2222-4222-8222-222222222222";
    const remote = remoteSkill({ kind: "capability", id: remoteId }, "Remote Skill");
    fixture.provider.repository.skills.set(`capability/${remoteId}`, remote);
    fixture.provider.advance();

    const overview = await fixture.service.refresh();
    const imported = fixture.capabilities.get(remoteId);
    expect(imported?.definition.name).toBe("Remote Skill");
    expect("origin" in imported!.manifest).toBe(false);
    expect(overview.status).toBe("ready");

    await fixture.restartService().sync();
    expect([...fixture.provider.repository.skills.keys()].toSorted()).toEqual([
      `capability/${local.manifest.id}`,
      `capability/${remoteId}`,
    ]);
  });

  it("creates a whole-Skill conflict when local and remote both change", async () => {
    const fixture = await createFixture();
    const id = "33333333-3333-4333-8333-333333333333";
    await fixture.addLocalSkill(id, "Shared Skill");
    await fixture.service.configure(configuration());

    await fixture.replaceLocalSkill(id, "Shared Skill", "Local change");
    fixture.provider.repository.skills.set(
      `capability/${id}`,
      remoteSkill({ kind: "capability", id }, "Shared Skill", "Remote change"),
    );
    fixture.provider.advance();

    const overview = await fixture.service.sync();
    expect(overview.status).toBe("conflict");
    expect(overview.conflicts).toEqual([
      expect.objectContaining({
        syncKey: `capability/${id}`,
        localExists: true,
        remoteExists: true,
      }),
    ]);
    expect((await fixture.restartService().getOverview()).status).toBe("conflict");
  });

  it("restores the selected target without publishing the local Skill", async () => {
    const fixture = await createFixture();
    const id = "26262626-2626-4626-8626-262626262626";
    await fixture.addLocalSkill(id, "Restored Skill");
    fixture.provider.repository.skills.set(
      `capability/${id}`,
      remoteSkill({ kind: "capability", id }, "Restored Skill", "Remote restored content"),
    );
    fixture.provider.advance();

    const restored = await fixture.service.configure({
      ...configuration(),
      initializationMode: "restore_remote",
    });

    expect(restored.status).toBe("ready");
    expect(fixture.capabilities.get(id)).toMatchObject({
      manifest: { latestRevision: 2 },
      definition: { description: "Restored Skill description" },
    });
  });

  it("preserves a conflict across an unrelated local publication", async () => {
    const fixture = await createFixture();
    const conflictedId = "55555555-5555-4555-8555-555555555555";
    const publishedId = "66666666-6666-4666-8666-666666666666";
    await fixture.addLocalSkill(conflictedId, "Conflicted Skill");
    await fixture.addLocalSkill(publishedId, "Published Skill");
    await fixture.service.configure(configuration());

    await fixture.replaceLocalSkill(conflictedId, "Conflicted Skill", "Local conflict");
    await fixture.replaceLocalSkill(publishedId, "Published Skill", "Local publication");
    fixture.provider.repository.skills.set(
      `capability/${conflictedId}`,
      remoteSkill({ kind: "capability", id: conflictedId }, "Conflicted Skill", "Remote conflict"),
    );
    fixture.provider.advance();

    expect((await fixture.service.sync()).status).toBe("conflict");
    const second = await fixture.service.sync();

    expect(second.status).toBe("conflict");
    expect(second.conflicts).toEqual([
      expect.objectContaining({ syncKey: `capability/${conflictedId}` }),
    ]);
    expect(
      fixture.provider.repository.skills.get(`capability/${conflictedId}`)?.files[0]?.content,
    ).toContain("Remote conflict");
    expect(
      fixture.provider.repository.skills.get(`capability/${publishedId}`)?.files[0]?.content,
    ).toContain("Local publication");
  });

  it("isolates an invalid local Skill while publishing a healthy Skill", async () => {
    const fixture = await createFixture();
    const invalidId = "77777777-7777-4777-8777-777777777777";
    const healthyId = "88888888-8888-4888-8888-888888888888";
    await fixture.addLocalSkill(invalidId, "Invalid Skill");
    await fixture.addLocalSkill(healthyId, "Healthy Skill");
    await fixture.service.configure(configuration());

    await fixture.corruptLocalSkill(invalidId);
    await fixture.replaceLocalSkill(healthyId, "Healthy Skill", "Healthy update");
    const overview = await fixture.service.sync();

    expect(overview.status).toBe("error");
    expect(overview.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${invalidId}`, status: "error" }),
    );
    expect(
      fixture.provider.repository.skills.get(`capability/${healthyId}`)?.files[0]?.content,
    ).toContain("Healthy update");
  });

  it("remains degraded after resolving the last conflict when another Skill has an error", async () => {
    const fixture = await createFixture();
    const conflictedId = "99999999-9999-4999-8999-999999999999";
    const unsafeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await fixture.addLocalSkill(conflictedId, "Conflicted Skill");
    await fixture.service.configure(configuration());
    await fixture.replaceLocalSkill(conflictedId, "Conflicted Skill", "Local conflict");
    fixture.provider.repository.skills.set(
      `capability/${conflictedId}`,
      remoteSkill({ kind: "capability", id: conflictedId }, "Conflicted Skill", "Remote conflict"),
    );
    fixture.provider.repository.skills.set(`capability/${unsafeId}`, unsafeRemoteSkill(unsafeId));
    fixture.provider.advance();

    expect((await fixture.service.sync()).status).toBe("conflict");
    const resolved = await fixture.service.resolveConflict(`capability/${conflictedId}`, "remote");

    expect(resolved.status).toBe("error");
    expect(resolved.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${unsafeId}`, status: "error" }),
    );
  });

  it("clears obsolete global errors and ignored markers after resolving a conflict", async () => {
    const fixture = await createFixture();
    const id = "18181818-1818-4818-8818-181818181818";
    const syncKey = `capability/${id}`;
    await fixture.addLocalSkill(id, "Recovered Skill");
    await fixture.service.configure(configuration());
    await fixture.replaceLocalSkill(id, "Recovered Skill", "Local conflict");
    fixture.provider.repository.skills.set(
      syncKey,
      remoteSkill({ kind: "capability", id }, "Recovered Skill", "Remote conflict"),
    );
    fixture.provider.advance();
    expect((await fixture.service.sync()).status).toBe("conflict");
    const statePath = join(fixture.root, "state", "skill-sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.errorCode = "skill_sync_failed";
    state.errorMessage = "Temporary network failure.";
    state.ignoredRemote = [{ syncKey, name: "Recovered Skill" }];
    await writeFile(statePath, `${JSON.stringify(state)}\n`);

    const overview = await fixture.restartService().resolveConflict(syncKey, "remote");

    expect(overview.status).toBe("ready");
    expect(overview.errorCode).toBeUndefined();
    expect(overview.skills).toContainEqual(expect.objectContaining({ syncKey, status: "synced" }));
  });

  it("rejects an unsafe remote Skill without advancing its synchronization base", async () => {
    const fixture = await createFixture();
    const id = "44444444-4444-4444-8444-444444444444";
    fixture.provider.repository.skills.set(`capability/${id}`, {
      identity: { kind: "capability", id },
      name: "Unsafe Skill",
      description: "Unsafe remote package",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: Unsafe Skill\ndescription: Unsafe remote package\n---\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "await fetch('https://example.com');\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
      ],
    });
    fixture.provider.advance();

    const overview = await fixture.service.configure(configuration());

    expect(fixture.capabilities.has(id)).toBe(false);
    expect(overview.status).toBe("error");
    expect(overview.skills[0]).toMatchObject({ syncKey: `capability/${id}`, status: "error" });
  });

  it("rejects executable files without a supported scanner even without a suffix or shebang", async () => {
    const fixture = await createFixture();
    const id = "45454545-4545-4545-8454-454545454545";
    const skill = remoteSkill({ kind: "capability", id }, "Executable Skill");
    fixture.provider.repository.skills.set(`capability/${id}`, {
      ...skill,
      files: [...skill.files, { path: "bin/run", content: "echo unsafe\n", executable: true }],
    });
    fixture.provider.advance();

    const overview = await fixture.service.configure(configuration());

    expect(fixture.capabilities.has(id)).toBe(false);
    expect(overview.skills).toContainEqual(
      expect.objectContaining({
        syncKey: `capability/${id}`,
        status: "error",
        errorCode: "skill_script_language_unsupported",
      }),
    );
  });

  it("continues syncing unchanged executable files from a v2 repository", async () => {
    const fixture = await createFixture();
    const id = "47474747-4747-4747-8474-474747474747";
    const skill = remoteSkill({ kind: "capability", id }, "Legacy Executable Skill");
    fixture.provider.repository = {
      schemaVersion: 2,
      skills: new Map([
        [
          `capability/${id}`,
          {
            ...skill,
            files: [
              ...skill.files,
              { path: "references/tool.sh", content: "echo legacy tool\n", executable: true },
            ],
          },
        ],
      ]),
    };
    fixture.provider.advance();

    const configured = await fixture.service.configure(configuration());
    const synchronized = await fixture.service.sync();

    expect(configured.status).toBe("ready");
    expect(synchronized.status).toBe("ready");
    expect(fixture.capabilities.has(id)).toBe(true);
    expect(fixture.provider.repository.schemaVersion).toBe(2);

    const changedSkill = fixture.provider.repository.skills.get(`capability/${id}`)!;
    fixture.provider.repository.skills.set(`capability/${id}`, {
      ...changedSkill,
      files: changedSkill.files.map((file) =>
        file.path === "references/tool.sh" ? { ...file, content: "echo changed tool\n" } : file,
      ),
    });
    fixture.provider.advance();

    const changed = await fixture.service.sync();

    expect(changed.status).toBe("error");
    expect(changed.skills).toContainEqual(
      expect.objectContaining({
        syncKey: `capability/${id}`,
        status: "error",
        errorCode: "skill_script_language_unsupported",
      }),
    );
    expect(
      await readFile(join(fixture.root, "capabilities", id, "1", "references", "tool.sh"), "utf8"),
    ).toBe("echo legacy tool\n");
  });

  it("rejects a new unscanned executable added to an already-synced v2 repository", async () => {
    const fixture = await createFixture();
    const id = "49494949-4949-4949-8494-494949494949";
    const skill = remoteSkill({ kind: "capability", id }, "Legacy Executable Skill");
    fixture.provider.repository = {
      schemaVersion: 2,
      skills: new Map([
        [
          `capability/${id}`,
          {
            ...skill,
            files: [
              ...skill.files,
              { path: "references/tool.sh", content: "echo legacy tool\n", executable: true },
            ],
          },
        ],
      ]),
    };
    fixture.provider.advance();
    await fixture.service.configure(configuration());

    const existing = fixture.provider.repository.skills.get(`capability/${id}`)!;
    fixture.provider.repository.skills.set(`capability/${id}`, {
      ...existing,
      files: [
        ...existing.files,
        { path: "bin/run", content: "echo unreviewed\n", executable: true },
      ],
    });
    fixture.provider.advance();

    const changed = await fixture.service.sync();

    expect(changed.skills).toContainEqual(
      expect.objectContaining({
        syncKey: `capability/${id}`,
        status: "error",
        errorCode: "skill_script_language_unsupported",
      }),
    );
    expect(fixture.capabilities.get(id)?.manifest.latestRevision).toBe(1);
  });

  it("allows non-executable script-like documentation in synced Skills", async () => {
    const fixture = await createFixture();
    const id = "46464646-4646-4646-8464-464646464646";
    const skill = remoteSkill({ kind: "capability", id }, "Documented Skill");
    fixture.provider.repository.skills.set(`capability/${id}`, {
      ...skill,
      files: [
        ...skill.files,
        {
          path: "references/example.py",
          content: "print('documentation sample')\n",
          executable: false,
        },
        {
          path: "references/example.ts",
          content: "export const example = true;\n",
          executable: false,
        },
      ],
    });
    fixture.provider.advance();

    const overview = await fixture.service.configure(configuration());

    expect(fixture.capabilities.has(id)).toBe(true);
    expect(overview.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${id}`, status: "synced" }),
    );
  });

  it("applies a remote deletion to the matching local Skill", async () => {
    const fixture = await createFixture();
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await fixture.addLocalSkill(id, "Deleted Skill");
    await fixture.service.configure(configuration());

    fixture.provider.repository.skills.delete(`capability/${id}`);
    fixture.provider.advance();
    const overview = await fixture.service.refresh();

    expect(fixture.capabilities.has(id)).toBe(false);
    expect(overview.status).toBe("ready");
  });

  it("preserves v1 reconciliation bases while adding the configured source identity", async () => {
    const fixture = await createFixture();
    const id = "abababab-abab-4bab-8bab-abababababab";
    await fixture.addLocalSkill(id, "Migrated Skill");
    await fixture.service.configure(configuration());
    const statePath = join(fixture.root, "state", "skill-sync-state.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    legacy.schemaVersion = "pragma.skill-sync-state/v1";
    delete legacy.sourceKey;
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`);

    fixture.provider.repository.skills.delete(`capability/${id}`);
    fixture.provider.advance();
    const overview = await fixture.service.refresh();

    expect(fixture.capabilities.has(id)).toBe(false);
    expect(overview.status).toBe("ready");
  });

  it("turns a raced remote deletion into a conflict instead of deleting a newer revision", async () => {
    const fixture = await createFixture();
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await fixture.addLocalSkill(id, "Raced Skill");
    await fixture.service.configure(configuration());
    fixture.provider.repository.skills.delete(`capability/${id}`);
    fixture.provider.advance();
    fixture.hooks.beforeRemove = async () => {
      fixture.hooks.beforeRemove = undefined;
      await fixture.replaceLocalSkill(id, "Raced Skill", "Concurrent local revision");
    };

    const overview = await fixture.service.refresh();

    expect(fixture.capabilities.get(id)?.manifest.latestRevision).toBe(2);
    expect(overview.status).toBe("conflict");
    expect(overview.conflicts).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${id}`, remoteExists: false }),
    );
  });

  it("publishes the latest local revision when it changes while resolving a conflict", async () => {
    const fixture = await createFixture();
    const id = "22222222-2222-4222-8222-222222222223";
    const syncKey = `capability/${id}`;
    await fixture.addLocalSkill(id, "Resolution Race Skill");
    await fixture.service.configure(configuration());
    await fixture.replaceLocalSkill(id, "Resolution Race Skill", "Selected local revision");
    fixture.provider.repository.skills.set(
      syncKey,
      remoteSkill({ kind: "capability", id }, "Resolution Race Skill", "Remote conflict"),
    );
    fixture.provider.advance();
    expect((await fixture.service.sync()).status).toBe("conflict");
    fixture.provider.beforePublish = async () => {
      fixture.provider.beforePublish = undefined;
      await fixture.replaceLocalSkill(id, "Resolution Race Skill", "Latest local revision");
    };

    const overview = await fixture.service.resolveConflict(syncKey, "local");

    expect(overview.status).toBe("ready");
    expect(fixture.provider.repository.skills.get(syncKey)?.files[0]?.content).toContain(
      "Latest local revision",
    );
  });

  it("clears a base-less conflict after both copies are deleted", async () => {
    const fixture = await createFixture();
    const id = "12121212-1212-4212-8212-121212121212";
    await fixture.addLocalSkill(id, "Ephemeral Conflict");
    fixture.provider.repository.skills.set(
      `capability/${id}`,
      remoteSkill({ kind: "capability", id }, "Ephemeral Conflict", "Different remote copy"),
    );
    fixture.provider.advance();
    expect((await fixture.service.configure(configuration())).status).toBe("conflict");

    fixture.capabilities.delete(id);
    fixture.provider.repository.skills.delete(`capability/${id}`);
    fixture.provider.advance();
    const overview = await fixture.service.refresh();

    expect(overview.status).toBe("ready");
    expect(overview.conflicts).toEqual([]);
  });

  it("starts with fresh bases when the remote default branch changes", async () => {
    const fixture = await createFixture();
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await fixture.addLocalSkill(id, "Branch-safe Skill");
    await fixture.service.configure(configuration());

    fixture.provider.reference = "replacement";
    fixture.provider.repository.skills.clear();
    fixture.provider.advance();
    const refreshed = await fixture.service.refresh();

    expect(fixture.capabilities.has(id)).toBe(true);
    expect(fixture.provider.repository.skills.has(`capability/${id}`)).toBe(false);
    expect(refreshed).toMatchObject({ resolvedBranch: "replacement", status: "ready" });
    expect(refreshed.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${id}`, status: "pending" }),
    );

    await fixture.service.sync();
    expect(fixture.provider.repository.skills.has(`capability/${id}`)).toBe(true);
  });

  it("rejects conflict resolution after the resolved default branch changes", async () => {
    const fixture = await createFixture();
    const id = "15151515-1515-4515-8515-151515151515";
    await fixture.addLocalSkill(id, "Branch Conflict Skill");
    await fixture.service.configure(configuration());
    await fixture.replaceLocalSkill(id, "Branch Conflict Skill", "Local conflict");
    fixture.provider.repository.skills.set(
      `capability/${id}`,
      remoteSkill({ kind: "capability", id }, "Branch Conflict Skill", "Remote conflict"),
    );
    fixture.provider.advance();
    expect((await fixture.service.sync()).status).toBe("conflict");

    fixture.provider.reference = "replacement";

    await expect(
      fixture.service.resolveConflict(`capability/${id}`, "remote"),
    ).rejects.toMatchObject({ code: "skill_sync_conflict_stale" });
  });

  it("discards bases when configuration changes before state can be reset", async () => {
    const fixture = await createFixture();
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await fixture.addLocalSkill(id, "Source-safe Skill");
    await fixture.service.configure(configuration());

    await writeFile(
      join(fixture.root, "state", "skill-sync-settings.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.skill-sync-settings/v1",
        remote: "https://example.com/replacement.git",
        autoPush: true,
        pushDeletions: false,
      })}\n`,
    );
    fixture.provider.repository.skills.clear();
    fixture.provider.advance();
    const refreshed = await fixture.service.refresh();

    expect(fixture.capabilities.has(id)).toBe(true);
    expect(refreshed.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${id}`, status: "pending" }),
    );
  });

  it("treats remotes that differ by a .git suffix as distinct sources", async () => {
    const fixture = await createFixture();
    const id = "24242424-2424-4424-8424-242424242424";
    await fixture.addLocalSkill(id, "Distinct Remote Skill");
    await fixture.service.configure(configuration());
    await writeFile(
      join(fixture.root, "state", "skill-sync-settings.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.skill-sync-settings/v1",
        remote: "https://example.com/skills",
        autoPush: true,
        pushDeletions: false,
      })}\n`,
    );
    fixture.provider.repository.skills.clear();
    fixture.provider.advance();

    const overview = await fixture.service.refresh();

    expect(fixture.capabilities.has(id)).toBe(true);
    expect(overview.skills).toContainEqual(
      expect.objectContaining({ syncKey: `capability/${id}`, status: "pending" }),
    );
  });

  it("rejects a local Skill file that exceeds the UTF-8 byte limit", async () => {
    const fixture = await createFixture();
    const id = "25252525-2525-4525-8525-252525252525";
    await fixture.addLocalSkill(id, "Byte Limited Skill");
    await fixture.reviseLocalSkillFile(id, "references/large.md", "界".repeat(70_000));

    const overview = await fixture.service.configure(configuration());

    expect(overview.status).toBe("error");
    expect(overview.skills).toContainEqual(
      expect.objectContaining({
        syncKey: `capability/${id}`,
        status: "error",
        errorCode: "skill_sync_size_limit",
      }),
    );
    expect(fixture.provider.repository.skills.has(`capability/${id}`)).toBe(false);
  });

  it("keeps v3 repositories at v3 and reports incompatible legacy local scripts", async () => {
    const fixture = await createFixture();
    const id = "25252525-2525-4525-8525-252525252526";
    const capability = await fixture.addLocalSkill(id, "Legacy Local Skill");
    const scriptPath = join(
      fixture.root,
      "capabilities",
      id,
      String(capability.manifest.latestRevision),
      "bin",
      "run.sh",
    );
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "echo legacy\n");
    await chmod(scriptPath, 0o700);

    const overview = await fixture.service.configure(configuration());

    expect(overview.status).toBe("error");
    expect(overview.skills).toContainEqual(
      expect.objectContaining({
        syncKey: `capability/${id}`,
        status: "error",
        errorCode: "skill_script_language_unsupported",
      }),
    );
    expect(fixture.provider.repository.schemaVersion).toBe(3);
    expect(fixture.provider.repository.skills.has(`capability/${id}`)).toBe(false);
  });

  it("persists conflict summaries for Skills with more than 64 files", async () => {
    const fixture = await createFixture();
    await fixture.service.configure(configuration());
    const statePath = join(fixture.root, "state", "skill-sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const files = Array.from({ length: 65 }, (_, index) => `references/file-${index}.md`);
    state.conflicts = {
      "capability/13131313-1313-4313-8313-131313131313": {
        remoteRevision: "1",
        local: { fingerprint: "local", exists: true, name: "Large Skill", files },
        remote: { fingerprint: "remote", exists: true, name: "Large Skill", files },
      },
    };
    await writeFile(statePath, `${JSON.stringify(state)}\n`);

    const overview = await fixture.restartService().getOverview();

    expect(overview.status).toBe("conflict");
    expect(overview.conflicts[0]?.localFiles).toHaveLength(65);
  });

  it("synchronizes a valid Skill with more than 64 files", async () => {
    const fixture = await createFixture();
    const id = "16161616-1616-4616-8616-161616161616";
    const skill = remoteSkill({ kind: "capability", id }, "Large Skill");
    fixture.provider.repository.skills.set(`capability/${id}`, {
      ...skill,
      files: [
        ...skill.files,
        ...Array.from({ length: 64 }, (_, index) => ({
          path: `references/file-${index}.md`,
          content: `Reference ${index}\n`,
          executable: false,
        })),
      ],
    });
    fixture.provider.advance();

    const overview = await fixture.service.configure(configuration());

    expect(overview.status).toBe("ready");
    expect(fixture.capabilities.has(id)).toBe(true);
  });

  it("preserves imported executable metadata when the local filesystem drops the mode", async () => {
    const fixture = await createFixture();
    const id = "17171717-1717-4717-8717-171717171717";
    const skill: RemoteSkill = {
      identity: { kind: "capability", id },
      name: "Portable Executable Skill",
      description: "Portable Executable Skill description",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: Portable Executable Skill\ndescription: Portable Executable Skill description\n---\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => 'ok';\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
      ],
    };
    fixture.provider.repository.skills.set(`capability/${id}`, skill);
    fixture.provider.advance();
    await fixture.service.configure(configuration());
    await chmod(join(fixture.root, "capabilities", id, "1", "scripts", "run.mjs"), 0o644);

    await fixture.restartService().sync();

    expect(
      fixture.provider.repository.skills
        .get(`capability/${id}`)
        ?.files.find((file) => file.path === "scripts/run.mjs")?.executable,
    ).toBe(true);
  });

  it("carries executable metadata when an executable file changes without portable mode support", async () => {
    const fixture = await createFixture({ supportsExecutableBits: false });
    const id = "19191919-1919-4919-8919-191919191919";
    const skill: RemoteSkill = {
      identity: { kind: "capability", id },
      name: "Revised Executable Skill",
      description: "Revised Executable Skill description",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: Revised Executable Skill\ndescription: Revised Executable Skill description\n---\nInitial.\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => 'ok';\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
      ],
    };
    fixture.provider.repository.skills.set(`capability/${id}`, skill);
    fixture.provider.advance();
    await fixture.service.configure(configuration());
    await chmod(join(fixture.root, "capabilities", id, "1", "scripts", "run.mjs"), 0o644);
    await fixture.reviseLocalSkillFile(id, "scripts/run.mjs", "export const run = () => 'new';\n");

    await fixture.service.sync();

    const published = fixture.provider.repository.skills.get(`capability/${id}`);
    expect(published?.files.find((file) => file.path === "scripts/run.mjs")?.content).toContain(
      "'new'",
    );
    expect(published?.files.find((file) => file.path === "scripts/run.mjs")?.executable).toBe(true);
  });

  it("recovers executable metadata after remote activation commits before sync state", async () => {
    const fixture = await createFixture({ supportsExecutableBits: false });
    const id = "29292929-2929-4929-8929-292929292929";
    const syncKey = `capability/${id}`;
    const skill: RemoteSkill = {
      identity: { kind: "capability", id },
      name: "Interrupted Activation Skill",
      description: "Interrupted Activation Skill description",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: Interrupted Activation Skill\ndescription: Interrupted Activation Skill description\n---\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => 'ok';\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
      ],
    };
    fixture.provider.repository.skills.set(syncKey, skill);
    fixture.provider.advance();
    await fixture.service.configure(configuration());
    await chmod(join(fixture.root, "capabilities", id, "1", "scripts", "run.mjs"), 0o644);
    const statePath = join(fixture.root, "state", "skill-sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.portableFiles = {};
    state.pendingRemoteActivations = {
      [syncKey]: {
        files: skill.files.map((file) => ({
          path: file.path,
          executable: file.executable,
          sha256: createHash("sha256").update(file.content).digest("hex"),
        })),
      },
    };
    await writeFile(statePath, `${JSON.stringify(state)}\n`);

    const overview = await fixture.restartService().sync();
    const recoveredState = JSON.parse(await readFile(statePath, "utf8")) as {
      portableFiles: Record<string, { files: { path: string; executable: boolean }[] }>;
      pendingRemoteActivations: Record<string, unknown>;
    };

    expect(overview.status).toBe("ready");
    expect(recoveredState.pendingRemoteActivations).toEqual({});
    expect(
      recoveredState.portableFiles[syncKey]?.files.find((file) => file.path === "scripts/run.mjs")
        ?.executable,
    ).toBe(true);
  });

  it("honors an intentional chmod-only local revision when executable bits are supported", async () => {
    const fixture = await createFixture({ supportsExecutableBits: true });
    const id = "23232323-2323-4323-8323-232323232323";
    const syncKey = `capability/${id}`;
    const skill: RemoteSkill = {
      identity: { kind: "capability", id },
      name: "Mode Revision Skill",
      description: "Mode Revision Skill description",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: Mode Revision Skill\ndescription: Mode Revision Skill description\n---\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => 'ok';\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
      ],
    };
    fixture.provider.repository.skills.set(syncKey, skill);
    fixture.provider.advance();
    await fixture.service.configure(configuration());
    await fixture.reviseLocalSkillMode(id, "scripts/run.mjs", 0o644);

    await fixture.service.sync();

    expect(
      fixture.provider.repository.skills
        .get(syncKey)
        ?.files.find((file) => file.path === "scripts/run.mjs")?.executable,
    ).toBe(false);
  });

  it("retries when a local Skill changes after reconciliation but before publication", async () => {
    const fixture = await createFixture();
    const id = "20202020-2020-4020-8020-202020202020";
    await fixture.addLocalSkill(id, "Racing Publication Skill");
    await fixture.service.configure(configuration());
    await fixture.replaceLocalSkill(id, "Racing Publication Skill", "First local revision");
    fixture.provider.beforePublish = async () => {
      fixture.provider.beforePublish = undefined;
      await fixture.replaceLocalSkill(id, "Racing Publication Skill", "Latest local revision");
    };

    await fixture.service.sync();

    expect(fixture.provider.repository.skills.get(`capability/${id}`)?.files[0]?.content).toContain(
      "Latest local revision",
    );
  });
});

describe("Git Skill sync provider", () => {
  it("rejects a v1 repository that uses a legacy Bundle identity", async () => {
    const root = await temporaryRoot();
    const source = join(root, "legacy-source");
    await git(undefined, ["init", "--initial-branch=main", source]);
    const id = "0123456789abcdef";
    const content =
      "---\nname: Legacy Skill\ndescription: Legacy Skill description\n---\n\nLegacy.\n";
    const payloadRoot = join(source, "skills", "bundle", id, "files");
    await mkdir(payloadRoot, { recursive: true });
    await writeFile(
      join(source, "pragma-skill-sync.yaml"),
      "schemaVersion: pragma.skill-sync/v1\n",
    );
    await writeFile(join(payloadRoot, "SKILL.md"), content);
    await writeFile(
      join(source, "skills", "bundle", id, "skill.yaml"),
      [
        "schemaVersion: pragma.skill-sync-skill/v1",
        "identity:",
        "  kind: pragma-bundle",
        `  logicalId: ${id}`,
        "name: Legacy Skill",
        "description: Legacy Skill description",
        "files:",
        "  - path: SKILL.md",
        `    sizeBytes: ${Buffer.byteLength(content, "utf8")}`,
        `    sha256: ${createHash("sha256").update(content).digest("hex")}`,
        "    executable: false",
        "",
      ].join("\n"),
    );
    await git(source, ["add", "."]);
    await git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "legacy",
    ]);

    const provider = createGitSkillSyncProvider(
      join(root, "legacy-cache"),
      gitConfiguration(source),
    );
    await expect(provider.readHead()).rejects.toMatchObject({
      code: "skill_sync_protocol_unsupported",
      message: expect.stringContaining("Reinitialize Skill sync"),
    });
  });

  it("publishes through Git and rejects a stale compare-and-swap", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    const configuration = gitConfiguration(remote);
    const first = createGitSkillSyncProvider(join(root, "first-cache"), configuration, { env });
    const stale = createGitSkillSyncProvider(join(root, "stale-cache"), configuration, { env });
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const repository = {
      skills: new Map([[`capability/${id}`, remoteSkill({ kind: "capability", id }, "Git Skill")]]),
    };
    expect((await stale.readHead()).revision).toBeUndefined();

    const published = await first.publish({ repository, message: "publish" });
    expect(published.status).toBe("published");
    await expect(
      stale.publish({ expectedRevision: undefined, repository, message: "stale" }),
    ).resolves.toEqual({ status: "head_changed" });
    expect((await stale.readHead()).repository.skills.get(`capability/${id}`)?.name).toBe(
      "Git Skill",
    );
    await expect(
      readFile(join(root, "stale-cache", "repository", ".git", "info", "attributes"), "utf8"),
    ).resolves.toContain("skills/** -text -filter");
  });

  it("reads legacy executable assets from v2 and upgrades safe repositories to v3", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const provider = createGitSkillSyncProvider(join(root, "cache"), gitConfiguration(remote), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    const id = "48484848-4848-4848-8484-484848484848";
    const skill = remoteSkill({ kind: "capability", id }, "Legacy Executable Skill");
    const legacy = {
      ...skill,
      files: [
        ...skill.files,
        { path: "references/tool.sh", content: "echo legacy tool\n", executable: true },
      ],
    };

    await expect(
      provider.publish({
        repository: { schemaVersion: 2, skills: new Map([[`capability/${id}`, legacy]]) },
        message: "reject unapproved legacy executable",
      }),
    ).rejects.toMatchObject({ code: "skill_script_language_unsupported" });

    await provider.publish({
      repository: {
        schemaVersion: 2,
        skills: new Map([[`capability/${id}`, legacy]]),
        grandfatheredExecutablePaths: new Map([
          [`capability/${id}`, new Set(["references/tool.sh"])],
        ]),
      },
      message: "preserve legacy executable",
    });
    const oldHead = await provider.readHead();
    expect(oldHead.repository.schemaVersion).toBe(2);
    expect(oldHead.repository.skills.get(`capability/${id}`)?.files).toContainEqual(
      expect.objectContaining({ path: "references/tool.sh", executable: true }),
    );

    await expect(
      provider.publish({
        expectedRevision: oldHead.revision,
        repository: {
          schemaVersion: 2,
          skills: new Map([
            [
              `capability/${id}`,
              {
                ...legacy,
                files: legacy.files.map((file) =>
                  file.path === "references/tool.sh"
                    ? { ...file, content: "echo modified legacy tool\n" }
                    : file,
                ),
              },
            ],
          ]),
        },
        message: "reject changed legacy executable",
      }),
    ).rejects.toMatchObject({ code: "skill_script_language_unsupported" });

    await expect(
      provider.publish({
        expectedRevision: oldHead.revision,
        repository: {
          schemaVersion: 2,
          skills: new Map([
            [
              `capability/${id}`,
              {
                ...legacy,
                files: [
                  ...legacy.files,
                  { path: "bin/run", content: "echo new tool\n", executable: true },
                ],
              },
            ],
          ]),
        },
        message: "reject new legacy executable",
      }),
    ).rejects.toMatchObject({ code: "skill_script_language_unsupported" });

    await provider.publish({
      expectedRevision: oldHead.revision,
      repository: { schemaVersion: 2, skills: new Map([[`capability/${id}`, skill]]) },
      message: "remove legacy executable",
    });
    expect((await provider.readHead()).repository.schemaVersion).toBe(3);

    const safeHead = await provider.readHead();
    await expect(
      provider.publish({
        expectedRevision: safeHead.revision,
        repository: { schemaVersion: 2, skills: new Map([[`capability/${id}`, legacy]]) },
        message: "reject v3 repository downgrade",
      }),
    ).rejects.toMatchObject({ code: "skill_sync_protocol_unsupported" });
    expect((await provider.readHead()).repository.schemaVersion).toBe(3);

    await expect(
      provider.publish({
        expectedRevision: safeHead.revision,
        repository: {
          schemaVersion: 3,
          skills: new Map([[`capability/${id}`, legacy]]),
        },
        message: "reject unscanned executable under v3",
      }),
    ).rejects.toMatchObject({ code: "skill_script_language_unsupported" });
  }, 15_000);

  it("rejects symbolic links in the managed Skill tree", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    await git(undefined, ["init", "--initial-branch=main", source]);
    await writeFile(
      join(source, "pragma-skill-sync.yaml"),
      "schemaVersion: pragma.skill-sync/v1\n",
    );
    await mkdir(join(source, "skills"), { recursive: true });
    await symlink("../outside", join(source, "skills", "capability"));
    await git(source, ["add", "."]);
    await git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "seed",
    ]);

    const provider = createGitSkillSyncProvider(join(root, "cache"), gitConfiguration(source));
    await expect(provider.readHead()).rejects.toThrow(/Invalid managed entry/u);
  });

  it("rejects an oversized repository before rewriting managed files", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const provider = createGitSkillSyncProvider(join(root, "cache"), gitConfiguration(remote), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    const skills = new Map<string, RemoteSkill>();
    for (let index = 0; index < 501; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      skills.set(`capability/${id}`, remoteSkill({ kind: "capability", id }, `Skill ${index}`));
    }

    await expect(
      provider.publish({ repository: { skills }, message: "oversized" }),
    ).rejects.toThrow("too many Skills");
    await expect(
      readFile(join(root, "cache", "repository", "pragma-skill-sync.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an oversized generated Skill manifest before publishing", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const provider = createGitSkillSyncProvider(join(root, "cache"), gitConfiguration(remote), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    const id = "26262626-2626-4626-8626-262626262626";
    const skill = remoteSkill({ kind: "capability", id }, "Large Manifest Skill");
    const segment = "a".repeat(180);
    const files = [
      ...skill.files,
      ...Array.from({ length: 999 }, (_, index) => ({
        path: `references/${segment}/${segment}/${segment}/${segment}/${segment}/file-${index}.md`,
        content: "x",
        executable: false,
      })),
    ];

    await expect(
      provider.publish({
        repository: { skills: new Map([[`capability/${id}`, { ...skill, files }]]) },
        message: "must reject oversized manifest",
      }),
    ).rejects.toMatchObject({ code: "skill_sync_size_limit" });
    await expect(
      readFile(join(root, "cache", "repository", "pragma-skill-sync.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the Git index executable bit when the working filesystem drops it", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const cacheRoot = join(root, "cache");
    const provider = createGitSkillSyncProvider(cacheRoot, gitConfiguration(remote), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    const id = "14141414-1414-4414-8414-141414141414";
    const skill: RemoteSkill = {
      identity: { kind: "capability", id },
      name: "Executable Skill",
      description: "Executable Skill description",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: Executable Skill\ndescription: Executable Skill description\n---\n",
          executable: false,
        },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => 'ok';\n",
          executable: true,
        },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\n",
          executable: false,
        },
        {
          path: "references/line\nbreak.md",
          content: "Line terminator path.\n",
          executable: false,
        },
      ],
    };
    await provider.readHead();
    const repositoryPath = join(cacheRoot, "repository");
    await git(repositoryPath, ["config", "core.fileMode", "false"]);
    await writeFile(join(repositoryPath, ".git", "info", "exclude"), "skills/**/files/**/*.mjs\n");
    await provider.publish({
      repository: { skills: new Map([[`capability/${id}`, skill]]) },
      message: "publish executable",
    });
    await chmod(
      join(repositoryPath, "skills", "capability", id, "files", "scripts", "run.mjs"),
      0o644,
    );
    const ignoredResidue = join(
      repositoryPath,
      "skills",
      "capability",
      id,
      "files",
      "scripts",
      "residue.mjs",
    );
    await writeFile(ignoredResidue, "export const residue = true;\n");

    const head = await provider.readHead();

    expect(head.repository.skills.get(`capability/${id}`)?.files).toContainEqual(
      expect.objectContaining({ path: "scripts/run.mjs", executable: true }),
    );
    expect(head.repository.skills.get(`capability/${id}`)?.files).toContainEqual(
      expect.objectContaining({ path: "references/line\nbreak.md" }),
    );
    await expect(readFile(ignoredResidue)).rejects.toMatchObject({ code: "ENOENT" });

    const nonExecutable = {
      ...skill,
      files: skill.files.map((file) =>
        file.path === "scripts/run.mjs" ? { ...file, executable: false } : file,
      ),
    };
    await provider.publish({
      expectedRevision: head.revision,
      repository: { skills: new Map([[`capability/${id}`, nonExecutable]]) },
      message: "remove executable bit",
    });

    expect(
      (await provider.readHead()).repository.skills
        .get(`capability/${id}`)
        ?.files.find((file) => file.path === "scripts/run.mjs")?.executable,
    ).toBe(false);
  });

  it("returns head_changed when the remote branch is deleted immediately before push", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    await git(undefined, ["init", "--bare", remote]);
    const globalConfig = join(root, "gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    const configuration = gitConfiguration(remote);
    const seed = createGitSkillSyncProvider(join(root, "seed-cache"), configuration, { env });
    const id = "21212121-2121-4121-8121-212121212121";
    const repository = {
      skills: new Map([
        [`capability/${id}`, remoteSkill({ kind: "capability", id }, "Lease Skill")],
      ]),
    };
    await seed.publish({ repository, message: "seed" });
    const racing = createGitSkillSyncProvider(join(root, "racing-cache"), configuration, {
      env,
      beforePush: async () => {
        await git(remote, ["update-ref", "-d", "refs/heads/main"]);
      },
    });
    const head = await racing.readHead();

    await expect(
      racing.publish({
        expectedRevision: head.revision,
        repository,
        message: "must not recreate deleted branch",
      }),
    ).resolves.toEqual({ status: "head_changed" });
    expect(
      await git(remote, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).catch(
        () => "missing",
      ),
    ).toBe("missing");
  });
});

function configuration(): Omit<SkillSyncConfiguration, "schemaVersion"> {
  return { remote: "https://example.com/skills.git", autoPush: true, pushDeletions: false };
}

async function createFixture(
  options: { readonly supportsExecutableBits?: boolean | undefined } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pragma-skill-sync-"));
  roots.push(root);
  const capabilities = new Map<string, Capability>();
  const paths = new Map<string, string>();
  const hooks: { beforeRemove?: ((id: string) => Promise<void>) | undefined } = {};
  const install = async (
    id: string,
    name: string,
    description: string,
    source: string,
  ): Promise<Capability> => {
    const previous = capabilities.get(id);
    const nextRevision = (previous?.manifest.latestRevision ?? 0) + 1;
    const target = join(root, "capabilities", id, String(nextRevision));
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    paths.set(`${id}:${nextRevision}`, target);
    const timestamp = new Date().toISOString();
    const capability: Capability = {
      manifest: {
        schemaVersion: "pragma.capability/v4",
        id,
        runtimeKey: `skill_${id.replaceAll("-", "").slice(0, 8)}`,
        name,
        kind: "skill",
        latestRevision: nextRevision,
        createdAt: previous?.manifest.createdAt ?? timestamp,
        updatedAt: timestamp,
      },
      definition: {
        kind: "skill",
        name,
        description,
        entryPath: "SKILL.md",
        contentHash: createHash("sha256").update(`${id}:${nextRevision}`).digest("hex"),
      },
      health: { revision: nextRevision, status: "ready", checkedAt: timestamp },
    };
    capabilities.set(id, capability);
    return capability;
  };

  const store = {
    list: async () => [...capabilities.values()],
    get: async (id: string) => capabilities.get(id)!,
    skillFilesPath: async (id: string, skillRevision: number) =>
      paths.get(`${id}:${skillRevision}`)!,
    publishNewSkillRevisionCandidate: async (input: {
      id: string;
      name: string;
      description: string;
      sourcePath: string;
    }) => await install(input.id, input.name, input.description, input.sourcePath),
    publishSkillRevisionCandidate: async (input: { id: string; sourcePath: string }) => {
      return await install(
        input.id,
        frontmatter(await readFile(join(input.sourcePath, "SKILL.md"), "utf8"), "name"),
        frontmatter(await readFile(join(input.sourcePath, "SKILL.md"), "utf8"), "description"),
        input.sourcePath,
      );
    },
    remove: async (id: string, expectedRevision?: number) => {
      await hooks.beforeRemove?.(id);
      const current = capabilities.get(id);
      if (
        expectedRevision !== undefined &&
        current !== undefined &&
        current.manifest.latestRevision !== expectedRevision
      ) {
        throw Object.assign(new Error("Capability revision changed."), {
          code: "revision_conflict",
        });
      }
      capabilities.delete(id);
    },
  } as unknown as CapabilityStore;

  const provider = new FakeProvider();
  const configurationPath = join(root, "state", "skill-sync-settings.json");
  const statePath = join(root, "state", "skill-sync-state.json");
  const cacheRoot = join(root, "cache");
  const restartService = () =>
    createSkillSyncService({
      configurationPath,
      statePath,
      cacheRoot,
      capabilities: store,
      provider,
      supportsExecutableBits: options.supportsExecutableBits,
    });
  const service = restartService();

  const addLocalSkill = async (id: string, name: string) => {
    const source = join(root, "sources", id);
    await writePackage(source, name, `${name} description`, "Initial content");
    return await install(id, name, `${name} description`, source);
  };
  const replaceLocalSkill = async (id: string, name: string, body: string) => {
    const source = join(root, "sources", `${id}-${Date.now()}`);
    await writePackage(source, name, `${name} description`, body);
    return await install(id, name, `${name} description`, source);
  };
  const corruptLocalSkill = async (id: string) => {
    const capability = capabilities.get(id)!;
    const path = paths.get(`${id}:${capability.manifest.latestRevision}`)!;
    await writeFile(join(path, "binary.dat"), Buffer.from([0xff, 0xfe, 0xfd]));
  };
  const reviseLocalSkillFile = async (id: string, path: string, content: string) => {
    const current = capabilities.get(id)!;
    const currentPath = paths.get(`${id}:${current.manifest.latestRevision}`)!;
    const source = join(root, "sources", `${id}-${Date.now()}-revision`);
    await cp(currentPath, source, { recursive: true });
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
    return await install(
      id,
      frontmatter(await readFile(join(source, "SKILL.md"), "utf8"), "name"),
      frontmatter(await readFile(join(source, "SKILL.md"), "utf8"), "description"),
      source,
    );
  };
  const reviseLocalSkillMode = async (id: string, path: string, mode: number) => {
    const current = capabilities.get(id)!;
    const currentPath = paths.get(`${id}:${current.manifest.latestRevision}`)!;
    const source = join(root, "sources", `${id}-${Date.now()}-mode-revision`);
    await cp(currentPath, source, { recursive: true });
    await chmod(join(source, path), mode);
    return await install(id, current.definition.name, current.definition.description, source);
  };
  return {
    root,
    capabilities,
    provider,
    service,
    addLocalSkill,
    replaceLocalSkill,
    corruptLocalSkill,
    reviseLocalSkillFile,
    reviseLocalSkillMode,
    restartService,
    hooks,
  };
}

type MutableRemoteSkillRepository = Omit<RemoteSkillRepository, "skills"> & {
  readonly skills: Map<string, RemoteSkill>;
};

class FakeProvider implements SkillSyncProvider {
  repository: MutableRemoteSkillRepository = { schemaVersion: 3, skills: new Map() };
  reference = "main";
  beforePublish?: (() => Promise<void>) | undefined;
  private revision = 0;

  advance() {
    this.revision += 1;
  }

  async readHead() {
    return {
      revision: String(this.revision),
      reference: this.reference,
      repository: cloneRepository(this.repository),
    };
  }

  async publish(input: {
    expectedRevision?: string | undefined;
    repository: RemoteSkillRepository;
    message: string;
  }) {
    if (input.expectedRevision !== String(this.revision))
      return { status: "head_changed" as const };
    await this.beforePublish?.();
    this.repository = cloneRepository(input.repository);
    this.advance();
    return { status: "published" as const, revision: String(this.revision) };
  }
}

function cloneRepository(repository: RemoteSkillRepository): MutableRemoteSkillRepository {
  return {
    schemaVersion: repository.schemaVersion ?? 3,
    skills: new Map(
      [...repository.skills].map(([key, skill]) => [
        key,
        {
          ...skill,
          identity: { ...skill.identity },
          files: skill.files.map((file) => ({ ...file })),
        },
      ]),
    ),
  };
}

function remoteSkill(
  identity: RemoteSkill["identity"],
  name: string,
  body = "Remote content",
): RemoteSkill {
  const description = `${name} description`;
  return {
    identity,
    name,
    description,
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
        executable: false,
      },
    ],
  };
}

function unsafeRemoteSkill(id: string): RemoteSkill {
  return {
    identity: { kind: "capability", id },
    name: "Unsafe Skill",
    description: "Unsafe remote package",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: Unsafe Skill\ndescription: Unsafe remote package\n---\n",
        executable: false,
      },
      {
        path: "scripts/run.mjs",
        content: "await fetch('https://example.com');\n",
        executable: true,
      },
      {
        path: "tests/run.test.mjs",
        content: "import '../scripts/run.mjs';\n",
        executable: false,
      },
    ],
  };
}

const execFileAsync = promisify(execFile);
async function git(repository: string | undefined, args: readonly string[]): Promise<string> {
  const command = repository === undefined ? [...args] : ["-C", repository, ...args];
  return (await execFileAsync("git", command)).stdout;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-skill-sync-git-"));
  roots.push(root);
  return root;
}

function gitConfiguration(remote: string): SkillSyncConfiguration {
  return {
    schemaVersion: "pragma.skill-sync-settings/v1",
    remote,
    branch: "main",
    autoPush: true,
    pushDeletions: false,
  };
}

async function writePackage(root: string, name: string, description: string, body: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

function frontmatter(content: string, key: "name" | "description"): string {
  return new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(content)?.[1]?.trim() ?? "";
}
