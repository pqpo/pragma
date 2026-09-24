import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCapabilityStore, type CapabilityStore } from "../capabilities/capability-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import {
  createContextStoreStore,
  hashSnapshotContent,
} from "../context-stores/context-store-store.ts";
import { createAssetGitService } from "./asset-git-service.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalGitConfig = {
  global: process.env.GIT_CONFIG_GLOBAL,
  allow: process.env.GIT_ALLOW_PROTOCOL,
};

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  if (originalGitConfig.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig.global;
  if (originalGitConfig.allow === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
  else process.env.GIT_ALLOW_PROTOCOL = originalGitConfig.allow;
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function run(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args])).stdout;
}

async function fixture(onAssociationChanged?: () => void) {
  const root = await mkdtemp(join(tmpdir(), "pragma-asset-git-test-"));
  roots.push(root);
  const bare = join(root, "asset.git");
  const seed = join(root, "seed");
  await mkdir(seed);
  await run(root, ["init", "--bare", bare]);
  await run(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await run(seed, ["init", "-b", "main"]);
  await run(seed, ["remote", "add", "origin", bare]);
  await writeFile(join(seed, "guide.md"), "# Guide\nFirst line\nSecond line\n");
  await writeFile(join(seed, "image.txt"), "Not managed by the knowledge base.\n");
  await run(seed, ["add", "."]);
  await run(seed, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "seed",
  ]);
  await run(seed, ["push", "origin", "main"]);
  const global = join(root, "gitconfig");
  await writeFile(
    global,
    `[url "file://${root}/"]\n  insteadOf = https://example.test/\n[user]\n  name = Test\n  email = test@example.test\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  const stores = createContextStoreStore({ storesPath: join(root, "stores") });
  const service = createAssetGitService({
    stateRoot: join(root, "state"),
    stores,
    capabilities: {} as CapabilityStore,
    onAssociationChanged,
  });
  return {
    root,
    bare,
    seed,
    stores,
    service,
    source: { remote: "https://example.test/asset.git" },
  };
}

describe("asset Git knowledge sync", () => {
  it("notifies environment sync after import, unbind, and bind", async () => {
    let changes = 0;
    const { service, source } = await fixture(() => {
      changes += 1;
    });
    const target = await service.import({ kind: "knowledge", source });
    expect(changes).toBe(1);
    await service.unbind(target);
    expect(changes).toBe(2);
    await service.bind({ target, source });
    expect(changes).toBe(3);
  });

  it("publishes an existing knowledge base into an empty repository", async () => {
    const { root, stores, service } = await fixture();
    const bare = join(root, "empty.git");
    await run(root, ["init", "--bare", bare]);
    await run(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Local guide\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source: { remote: "https://example.test/empty.git" } });
    expect((await service.sync(target)).status).toBe("synced");
    expect((await run(bare, ["show", "main:guide.md"])).trim()).toBe("# Local guide");
    expect((await service.status(target)).source?.branch).toBe("main");
  });

  it("imports Markdown, preserves other repository files, and merges independent edits", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    expect(target.kind).toBe("knowledge");
    if (target.kind !== "knowledge") return;
    const initial = await stores.getSnapshot(target.id);
    expect(initial.files.map((file) => file.id)).toEqual(["guide.md"]);
    await stores.createFile(target.id, "local.md", "# Local\n");
    expect((await service.status(target)).status).toBe("pending");
    await writeFile(join(seed, "remote.md"), "# Remote\n");
    await run(seed, ["add", "remote.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "remote edit",
    ]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("synced");
    const snapshot = await stores.getSnapshot(target.id);
    expect(snapshot.files.map((file) => file.id).toSorted()).toEqual([
      "guide.md",
      "local.md",
      "remote.md",
    ]);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    expect(await readFile(join(seed, "local.md"), "utf8")).toBe("# Local\n");
    expect(await readFile(join(seed, "image.txt"), "utf8")).toBe(
      "Not managed by the knowledge base.\n",
    );
  });

  it("reports overlapping first-bind changes without replacing either side", async () => {
    const { seed, stores, service, source } = await fixture();
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Different\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const result = await service.sync(target);
    expect(result.status).toBe("conflict");
    expect(result.conflictPaths).toEqual(["guide.md"]);
    expect((await stores.getSnapshot(local.id)).files[0]?.content).toBe("# Different\n");
    expect(await readFile(join(seed, "guide.md"), "utf8")).toContain("# Guide");
  });

  it("automatically merges different lines of the same Markdown file", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    if (target.kind !== "knowledge") return;
    const current = await stores.getSnapshot(target.id);
    const files = current.files.map((file) => ({
      ...file,
      content: file.content.replace("# Guide", "# Local Guide"),
    }));
    await stores.appendSnapshot(
      {
        storeId: target.id,
        baseRevision: current.revision,
        baseSnapshotHash: current.snapshotHash,
        snapshotHash: hashSnapshotContent(files, current.directories),
        directories: current.directories,
        files,
        summary: "Edit title",
      },
      "user",
    );
    await writeFile(join(seed, "guide.md"), "# Guide\nFirst line\nSecond remote line\n");
    await run(seed, ["add", "guide.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Edit second line",
    ]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("synced");
    const merged = (await stores.getSnapshot(target.id)).files[0]?.content;
    expect(merged).toContain("# Local Guide");
    expect(merged).toContain("Second remote line");
  });

  it("propagates an unopposed remote Markdown deletion", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    if (target.kind !== "knowledge") return;
    await run(seed, ["rm", "guide.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Remove guide",
    ]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("synced");
    expect((await stores.getSnapshot(target.id)).files).toEqual([]);
  });

  it("replays a sync interrupted after the Git push", async () => {
    const { root, seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    if (target.kind !== "knowledge") return;
    await stores.createFile(target.id, "recovery.md", "# Recover\n");
    const interrupted = createAssetGitService({
      stateRoot: join(root, "state"),
      stores,
      capabilities: {} as CapabilityStore,
      afterPush: async () => {
        throw new Error("simulated process interruption");
      },
    });
    expect((await interrupted.sync(target)).status).toBe("error");
    expect((await service.sync(target)).status).toBe("synced");
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    expect(await readFile(join(seed, "recovery.md"), "utf8")).toBe("# Recover\n");
    await expect(
      readFile(join(root, "state", "knowledge", `${target.id}.json.journal`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a repository symlink before it can redirect a local file write", async () => {
    const { root, seed, stores, service, source } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(seed, "linked"));
    await run(seed, ["add", "linked"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "link",
    ]);
    await run(seed, ["push", "origin", "main"]);
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFolder(local.id, "linked");
    await stores.createFile(local.id, "linked/payload.md", "# Private\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    expect((await service.sync(target)).status).toBe("error");
    await expect(readFile(join(outside, "payload.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports file and directory collisions as conflicts", async () => {
    const { seed, stores, service, source } = await fixture();
    await writeFile(join(seed, "docs.md"), "# Remote\n");
    await run(seed, ["add", "docs.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "docs",
    ]);
    await run(seed, ["push", "origin", "main"]);
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFolder(local.id, "docs.md");
    await stores.createFile(local.id, "docs.md/nested.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    expect((await service.sync(target)).conflictPaths).toEqual(["docs.md", "docs.md/nested.md"]);
  });
});

describe("asset Git Skill sync", () => {
  it("imports a plain Skill repository and publishes a local revision", async () => {
    const { root, bare, seed, stores, source } = await fixture();
    await run(seed, ["rm", "guide.md", "image.txt"]);
    await writeFile(
      join(seed, "SKILL.md"),
      "---\nname: repo-review\ndescription: Review a repository.\n---\n\n# Review\n",
    );
    await mkdir(join(seed, "scripts"));
    await writeFile(join(seed, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(seed, "scripts", "check.sh"), 0o755);
    await run(seed, ["add", "."]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Skill",
    ]);
    await run(seed, ["push", "origin", "main"]);
    const mutations = {
      publish: async (input: { commit: () => Promise<unknown> }) => await input.commit(),
    } as unknown as Parameters<typeof createCapabilityStore>[0]["mutations"];
    const capabilities = createCapabilityStore({
      capabilitiesPath: join(root, "capabilities"),
      credentials: {} as Parameters<typeof createCapabilityStore>[0]["credentials"],
      verify: async (definition) => ({
        definition,
        health: { status: "ready", checkedAt: new Date().toISOString() },
      }),
      mutations,
      isReferenced: async () => false,
    });
    const service = createAssetGitService({
      stateRoot: join(root, "skill-state"),
      stores,
      capabilities,
    });
    const target = await service.import({ kind: "skill", source });
    expect(target.kind).toBe("skill");
    if (target.kind !== "skill") return;
    const initial = await capabilities.get(target.id);
    expect(initial.manifest.latestRevision).toBe(1);
    expect(
      (await capabilities.listSkillFiles({ id: target.id, revision: 1 })).some((file) =>
        file.path.includes(".git"),
      ),
    ).toBe(false);
    expect(
      (await stat(join(await capabilities.skillFilesPath(target.id, 1), "scripts", "check.sh")))
        .mode & 0o111,
    ).not.toBe(0);
    const stage = join(root, "updated-skill");
    await cp(await capabilities.skillFilesPath(target.id, 1), stage, { recursive: true });
    await writeFile(join(stage, "review.md"), "# Checklist\n");
    await writeFile(join(stage, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(stage, "scripts", "run.sh"), 0o755);
    await capabilities.publishSkillRevisionCandidate({
      id: target.id,
      baseRevision: 1,
      baseContentHash: initial.definition.kind === "skill" ? initial.definition.contentHash : "",
      sourcePath: stage,
      candidateContentHash: (await scanSkillWorkingTree(stage)).hash,
    });
    expect((await service.sync(target)).status).toBe("synced");
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    expect(await readFile(join(seed, "review.md"), "utf8")).toBe("# Checklist\n");
    expect(await run(seed, ["ls-files", "--stage", "scripts/run.sh"])).toContain("100755");

    const current = await capabilities.get(target.id);
    const nextStage = join(root, "next-skill");
    await cp(
      await capabilities.skillFilesPath(target.id, current.manifest.latestRevision),
      nextStage,
      {
        recursive: true,
      },
    );
    await writeFile(join(nextStage, "local-only.md"), "# Local\n");
    await capabilities.publishSkillRevisionCandidate({
      id: target.id,
      baseRevision: current.manifest.latestRevision,
      baseContentHash: current.definition.kind === "skill" ? current.definition.contentHash : "",
      sourcePath: nextStage,
      candidateContentHash: (await scanSkillWorkingTree(nextStage)).hash,
    });
    await run(seed, ["rm", "SKILL.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Remove Skill entry",
    ]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("error");
    await expect(run(bare, ["show", "main:local-only.md"])).rejects.toThrow();
  });
});
