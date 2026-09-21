import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("publishes a local Skill and imports a remote Bundle Skill by logical identity", async () => {
    const fixture = await createFixture();
    const local = await fixture.addLocalSkill(
      "11111111-1111-4111-8111-111111111111",
      "Local Skill",
    );

    await fixture.service.configure(configuration());

    expect(fixture.provider.repository.skills.get(`capability/${local.manifest.id}`)?.name).toBe(
      "Local Skill",
    );

    const bundleLogicalId = "22222222-2222-4222-8222-222222222222";
    const bundle = remoteSkill(
      { kind: "pragma-bundle", logicalId: bundleLogicalId },
      "Bundle Skill",
    );
    fixture.provider.repository.skills.set("bundle/22222222-2222-4222-8222-222222222222", bundle);
    fixture.provider.advance();

    const overview = await fixture.service.refresh();
    const imported = [...fixture.capabilities.values()].find(
      (capability) => capability.manifest.origin?.logicalId === bundleLogicalId,
    );
    expect(imported?.definition.name).toBe("Bundle Skill");
    expect(overview.status).toBe("ready");
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
});

describe("Git Skill sync provider", () => {
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
      ],
    };
    await provider.publish({
      repository: { skills: new Map([[`capability/${id}`, skill]]) },
      message: "publish executable",
    });
    const repositoryPath = join(cacheRoot, "repository");
    await git(repositoryPath, ["config", "core.fileMode", "false"]);
    await chmod(
      join(repositoryPath, "skills", "capability", id, "files", "scripts", "run.mjs"),
      0o644,
    );

    const head = await provider.readHead();

    expect(head.repository.skills.get(`capability/${id}`)?.files).toContainEqual(
      expect.objectContaining({ path: "scripts/run.mjs", executable: true }),
    );
  });
});

function configuration(): Omit<SkillSyncConfiguration, "schemaVersion"> {
  return { remote: "https://example.com/skills.git", autoPush: true, pushDeletions: false };
}

async function createFixture() {
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
    origin?: { kind: "pragma-bundle"; logicalId: string },
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
        schemaVersion: "pragma.capability/v2",
        id,
        runtimeKey: `skill_${id.replaceAll("-", "").slice(0, 8)}`,
        name,
        kind: "skill",
        latestRevision: nextRevision,
        ...(origin === undefined ? {} : { origin }),
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
      origin?: { kind: "pragma-bundle"; logicalId: string };
    }) => await install(input.id, input.name, input.description, input.sourcePath, input.origin),
    publishSkillRevisionCandidate: async (input: { id: string; sourcePath: string }) => {
      const current = capabilities.get(input.id)!;
      return await install(
        input.id,
        frontmatter(await readFile(join(input.sourcePath, "SKILL.md"), "utf8"), "name"),
        frontmatter(await readFile(join(input.sourcePath, "SKILL.md"), "utf8"), "description"),
        input.sourcePath,
        current.manifest.origin,
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
  return {
    root,
    capabilities,
    provider,
    service,
    addLocalSkill,
    replaceLocalSkill,
    corruptLocalSkill,
    restartService,
    hooks,
  };
}

class FakeProvider implements SkillSyncProvider {
  repository: { skills: Map<string, RemoteSkill> } = { skills: new Map() };
  reference = "main";
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
    this.repository = cloneRepository(input.repository);
    this.advance();
    return { status: "published" as const, revision: String(this.revision) };
  }
}

function cloneRepository(repository: RemoteSkillRepository): { skills: Map<string, RemoteSkill> } {
  return {
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
