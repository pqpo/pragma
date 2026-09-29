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

async function fixture(
  onAssociationChanged?: () => void,
  onStatusChanged?: Parameters<typeof createAssetGitService>[0]["onStatusChanged"],
) {
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
    onStatusChanged,
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

  it("publishes background-visible terminal status changes", async () => {
    const statuses: string[] = [];
    const { service, source } = await fixture(undefined, (status) => {
      statuses.push(status.status);
    });
    const target = await service.import({ kind: "knowledge", source });
    await service.unbind(target);
    await service.bind({ target, source });
    await service.sync(target);

    // A content-only import still needs to publish its metadata sidecars.
    expect(statuses).toEqual(["pending", "unbound", "pending", "syncing", "synced"]);
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

  it("publishes remote files in new nested directories", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    await stores.createFolder(target.id, "empty");
    await mkdir(join(seed, "docs"));
    await writeFile(join(seed, "docs", "new.md"), "# New\n");
    await run(seed, ["add", "docs/new.md"]);
    await run(seed, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Nested",
    ]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("synced");
    const snapshot = await stores.getSnapshot(target.id);
    expect(snapshot.directories).toContain("docs");
    expect(snapshot.directories).toContain("empty");
    expect(snapshot.files.some((file) => file.id === "docs/new.md")).toBe(true);
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

  it.each(["local", "remote", "manual", "delete"] as const)(
    "resolves a first-bind conflict with %s and continues syncing",
    async (choice) => {
      const { bare, stores, service, source } = await fixture();
      const local = await stores.create({ mode: "blank", name: "Local", description: "" });
      await stores.createFile(local.id, "guide.md", "# Local version\n");
      await stores.createFile(local.id, "local.md", "# Independent\n");
      const target = { kind: "knowledge" as const, id: local.id };
      await service.bind({ target, source });
      expect((await service.sync(target)).status).toBe("conflict");
      const preview = await service.conflicts(target);
      expect(preview.files).toEqual([
        expect.objectContaining({
          path: "guide.md",
          kind: "text",
          local: "# Local version\n",
          base: null,
        }),
      ]);
      expect(preview.files[0]?.mergeRemote).toContain("# Guide");
      const result = await service.resolve({
        target,
        snapshot: preview.snapshot,
        resolutions: [
          choice === "manual"
            ? { path: "guide.md", choice, content: "# Combined\n" }
            : { path: "guide.md", choice },
        ],
      });
      expect(result.status).toBe("synced");
      const files = (await stores.getSnapshot(local.id)).files;
      if (choice === "delete") {
        expect(files.some((file) => file.id === "guide.md")).toBe(false);
        await expect(run(bare, ["show", "main:guide.md"])).rejects.toThrow();
      } else {
        const expected =
          choice === "manual"
            ? "# Combined\n"
            : choice === "local"
              ? "# Local version\n"
              : "# Guide\nFirst line\nSecond line\n";
        expect(files.find((file) => file.id === "guide.md")?.content).toBe(expected);
        expect(await run(bare, ["show", "main:guide.md"])).toBe(expected);
      }
      expect(await run(bare, ["show", "main:local.md"])).toBe("# Independent\n");
      expect(await run(bare, ["show", "main:image.txt"])).toContain("Not managed");
      expect((await service.sync(target)).status).toBe("synced");
    },
  );

  it("resolves a knowledge base larger than the Skill package limit", async () => {
    const { seed, stores, service, source } = await fixture();
    // Each file is supported; the Skill-only aggregate limit must not apply.
    for (let index = 0; index < 27; index += 1) {
      await writeFile(join(seed, `large-${index}.md`), "x".repeat(1_000_000));
    }
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Large knowledge base"]);
    await run(seed, ["push", "origin", "main"]);
    const target = await service.import({ kind: "knowledge", source });
    const current = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(
      target.id,
      "guide.md",
      "# Local\n",
      current.metadata,
      current.revision!,
    );
    await writeFile(join(seed, "guide.md"), "# Remote\n");
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Conflicting guide"]);
    await run(seed, ["push", "origin", "main"]);
    const preview = await service.conflicts(target);
    expect(preview.files.map((file) => file.path)).toEqual(["guide.md"]);
    expect(
      await service.resolve({
        target,
        snapshot: preview.snapshot,
        resolutions: [{ path: "guide.md", choice: "manual", content: "# Combined\n" }],
      }),
    ).toMatchObject({ status: "synced" });
    expect((await stores.getSnapshot(target.id)).files).toHaveLength(28);
    expect((await service.sync(target)).status).toBe("synced");
  }, 30_000);

  it("rejects oversized Knowledge manual content before checkout, journal or publication", async () => {
    const { root, bare, stores, service, source } = await fixture();
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const preview = await service.conflicts(target);
    const revision = (await stores.getSnapshot(local.id)).revision;
    const remoteHead = await run(bare, ["rev-parse", "main"]);
    const publish = vi.spyOn(stores, "appendSnapshot");
    await expect(
      service.resolve({
        target,
        snapshot: preview.snapshot,
        resolutions: [{ path: "guide.md", choice: "manual", content: "x".repeat(2_000_000) }],
      }),
    ).rejects.toThrow("size limit");
    expect(publish).not.toHaveBeenCalled();
    expect((await stores.getSnapshot(local.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(remoteHead);
    await expect(
      readFile(join(root, "state", "knowledge", `${target.id}.json.journal`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [{ path: "guide.md", choice: "manual", content: "# Resolved\n" }],
        })
      ).status,
    ).toBe("synced");
  });

  it("validates the fully merged Knowledge tree before automatic publication", async () => {
    const { bare, seed, stores, service, source } = await fixture();
    const lines = ["Header", "Separator", "x".repeat(994_000), "Separator", "Footer"];
    const text = (values: string[]) => values.join("\n");
    await writeFile(join(seed, "guide.md"), text(lines));
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Large base file"]);
    await run(seed, ["push", "origin", "main"]);
    const target = await service.import({ kind: "knowledge", source });
    const current = await stores.getContent(target.id, "guide.md");
    const local = [...lines];
    local[0] = "l".repeat(4_000);
    await stores.updateFile(
      target.id,
      "guide.md",
      text(local),
      current.metadata,
      current.revision!,
    );
    const remote = [...lines];
    remote[4] = "r".repeat(4_000);
    await writeFile(join(seed, "guide.md"), text(remote));
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Independent remote edit"]);
    await run(seed, ["push", "origin", "main"]);
    const revision = (await stores.getSnapshot(target.id)).revision;
    const remoteHead = await run(bare, ["rev-parse", "main"]);
    const publish = vi.spyOn(stores, "appendSnapshot");
    expect(await service.sync(target)).toMatchObject({
      status: "error",
      error: expect.stringContaining("size limit"),
    });
    expect(publish).not.toHaveBeenCalled();
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(remoteHead);
  });

  it("prepares separate conflict choices while preserving independent edits in a long file", async () => {
    const { bare, seed, stores, service, source } = await fixture();
    const base = Array.from({ length: 1200 }, (_, index) => `Unchanged line ${index}`);
    const content = (lines: string[]) => `${lines.join("\n")}\n`;
    await writeFile(join(seed, "guide.md"), content(base));
    await run(seed, ["add", "guide.md"]);
    await run(seed, ["commit", "-m", "long base"]);
    await run(seed, ["push", "origin", "main"]);
    const target = await service.import({ kind: "knowledge", source });
    const local = [...base];
    local[10] = "Local conflict one";
    local[500] = "Local conflict two";
    local[800] = "Independent local edit";
    const file = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(target.id, "guide.md", content(local), file.metadata, file.revision!);
    const remote = [...base];
    remote[10] = "Remote conflict one";
    remote[500] = "Remote conflict two";
    remote[1100] = "Independent remote edit";
    await writeFile(join(seed, "guide.md"), content(remote));
    await run(seed, ["add", "guide.md"]);
    await run(seed, ["commit", "-m", "two conflicts and independent remote edit"]);
    await run(seed, ["push", "origin", "main"]);
    expect((await service.sync(target)).status).toBe("conflict");
    const preview = await service.conflicts(target);
    const candidateLocal = [...local];
    candidateLocal[1100] = remote[1100]!;
    const candidateRemote = [...remote];
    candidateRemote[800] = local[800]!;
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]?.mergeLocal).toBe(content(candidateLocal));
    expect(preview.files[0]?.mergeRemote).toBe(content(candidateRemote));
    const result = [...candidateLocal];
    result[500] = remote[500]!;
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [{ path: "guide.md", choice: "manual", content: content(result) }],
        })
      ).status,
    ).toBe("synced");
    expect(await run(bare, ["show", "main:guide.md"])).toBe(content(result));
    expect((await stores.getSnapshot(target.id)).files[0]?.content).toBe(content(result));
  });

  it("replays a manual merge published locally before an interrupted push", async () => {
    const { bare, stores, service, source } = await fixture();
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const preview = await service.conflicts(target);
    const hook = join(bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const result = await service.resolve({
      target,
      snapshot: preview.snapshot,
      resolutions: [{ path: "guide.md", choice: "manual", content: "# Manual resolution\n" }],
    });
    expect(result.status).toBe("error");
    const published = await stores.getSnapshot(target.id);
    expect(published.files[0]?.content).toBe("# Manual resolution\n");
    expect(await run(bare, ["show", "main:guide.md"])).toContain("# Guide");
    await rm(hook);
    expect((await service.sync(target)).status).toBe("synced");
    expect(await run(bare, ["show", "main:guide.md"])).toBe("# Manual resolution\n");
    expect((await stores.getSnapshot(target.id)).revision).toBe(published.revision);
  });

  it("rejects stale local and remote decisions without overwriting either side", async () => {
    const { bare, seed, stores, service, source } = await fixture();
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const preview = await service.conflicts(target);
    await stores.createFile(local.id, "new.md", "# New local\n");
    const resolve = (snapshot: string) =>
      service.resolve({ target, snapshot, resolutions: [{ path: "guide.md", choice: "remote" }] });
    await expect(resolve(preview.snapshot)).rejects.toMatchObject({
      code: "asset_git_stale_conflict",
    });
    const next = await service.conflicts(target);
    await writeFile(join(seed, "guide.md"), "# New remote\n");
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Change remote"]);
    await run(seed, ["push", "origin", "main"]);
    await expect(resolve(next.snapshot)).rejects.toMatchObject({
      code: "asset_git_stale_conflict",
    });
    expect(
      (await stores.getSnapshot(local.id)).files.find((file) => file.id === "guide.md")?.content,
    ).toBe("# Local\n");
    expect(await run(bare, ["show", "main:guide.md"])).toBe("# New remote\n");
  });

  it("keeps conflicts retryable after invalid decisions or unresolved markers", async () => {
    const { stores, service, source } = await fixture();
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "guide.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const preview = await service.conflicts(target);
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [{ path: "other.md", choice: "local" }],
        })
      ).status,
    ).toBe("error");
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [
            {
              path: "guide.md",
              choice: "manual",
              content: "<<<<<<< ours\ncontent\n=======\nother\n>>>>>>> theirs\n",
            },
          ],
        })
      ).status,
    ).toBe("error");
    expect((await stores.getSnapshot(local.id)).revision).toBe(2);
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [{ path: "guide.md", choice: "local" }],
        })
      ).status,
    ).toBe("synced");
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
    const preview = await service.conflicts(target);
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [
            { path: "docs.md", choice: "remote" },
            { path: "docs.md/nested.md", choice: "delete" },
          ],
        })
      ).status,
    ).toBe("synced");
    expect((await stores.getSnapshot(target.id)).files.some((file) => file.id === "docs.md")).toBe(
      true,
    );
  });

  it("replaces an empty nested remote directory with the chosen local file", async () => {
    const { bare, seed, stores, service, source } = await fixture();
    await mkdir(join(seed, "docs.md", "nested"), { recursive: true });
    await writeFile(join(seed, "docs.md", "nested", "guide.md"), "# Remote\n");
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Nested remote files"]);
    await run(seed, ["push", "origin", "main"]);
    const local = await stores.create({ mode: "blank", name: "Local", description: "" });
    await stores.createFile(local.id, "docs.md", "# Local\n");
    const target = { kind: "knowledge" as const, id: local.id };
    await service.bind({ target, source });
    const preview = await service.conflicts(target);
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [
            { path: "docs.md", choice: "local" },
            { path: "docs.md/nested/guide.md", choice: "delete" },
          ],
        })
      ).status,
    ).toBe("synced");
    expect(await run(bare, ["show", "main:docs.md"])).toBe("# Local\n");
    expect(await run(bare, ["show", "main:image.txt"])).toBe(
      "Not managed by the knowledge base.\n",
    );
  });
});

describe("asset Git Skill sync", () => {
  it("validates manual Skill merges and resolves binary and executable choices", async () => {
    const { root, bare, seed, stores, source } = await fixture();
    await run(seed, ["rm", "guide.md", "image.txt"]);
    const skill = "---\nname: repo-review\ndescription: Review a repository.\n---\n\n# Review\n";
    await writeFile(join(seed, "SKILL.md"), skill);
    await writeFile(join(seed, "image.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(seed, "run.sh"), "#!/bin/sh\nexit 0\n");
    await run(seed, ["add", "."]);
    await run(seed, ["commit", "-m", "Remote Skill"]);
    await run(seed, ["push", "origin", "main"]);
    const mutations = {
      publish: async (input: { commit: () => Promise<unknown> }) => await input.commit(),
    } as unknown as Parameters<typeof createCapabilityStore>[0]["mutations"];
    const capabilities = createCapabilityStore({
      capabilitiesPath: join(root, "capabilities"),
      credentials: {} as Parameters<typeof createCapabilityStore>[0]["credentials"],
      mutations,
      verify: async (definition) => ({
        definition,
        health: { status: "ready", checkedAt: new Date().toISOString() },
      }),
      isReferenced: async () => false,
    });
    const stage = join(root, "local-skill");
    await mkdir(stage);
    await writeFile(join(stage, "SKILL.md"), skill.replace("# Review", "# Local review"));
    await writeFile(join(stage, "image.bin"), Buffer.from([0, 3, 4]));
    await writeFile(join(stage, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(stage, "run.sh"), 0o755);
    const local = await capabilities.importSkill({ sourcePath: stage });
    const target = { kind: "skill" as const, id: local.manifest.id };
    const service = createAssetGitService({ stateRoot: join(root, "state"), stores, capabilities });
    await service.bind({ target, source });
    expect((await service.sync(target)).status).toBe("conflict");
    const preview = await service.conflicts(target);
    expect(preview.files.map((file) => file.path)).toEqual(["SKILL.md", "image.bin", "run.sh"]);
    expect(preview.files.find((file) => file.path === "image.bin")).toMatchObject({
      kind: "binary",
      local: null,
      remote: null,
    });
    expect(preview.files.find((file) => file.path === "run.sh")).toMatchObject({
      modeConflict: true,
      localExecutable: true,
      remoteExecutable: false,
    });
    const decisions = [
      {
        path: "SKILL.md",
        choice: "manual" as const,
        content: `---\nname: ${"x".repeat(2000)}\ndescription: Invalid name length\n---\n`,
      },
      { path: "image.bin", choice: "remote" as const },
      { path: "run.sh", choice: "local" as const },
    ];
    expect(
      (await service.resolve({ target, snapshot: preview.snapshot, resolutions: decisions }))
        .status,
    ).toBe("error");
    expect((await capabilities.get(target.id)).manifest.latestRevision).toBe(1);
    expect(await run(bare, ["show", "main:SKILL.md"])).toBe(skill);
    decisions[0]!.content = skill.replace("# Review", "# Merged review");
    expect(
      (await service.resolve({ target, snapshot: preview.snapshot, resolutions: decisions }))
        .status,
    ).toBe("synced");
    expect(await run(bare, ["show", "main:SKILL.md"])).toContain("# Merged review");
    expect(await run(bare, ["ls-tree", "main", "run.sh"])).toContain("100755");
    const path = await capabilities.skillFilesPath(
      target.id,
      (await capabilities.get(target.id)).manifest.latestRevision,
    );
    expect(await readFile(join(path, "image.bin"))).toEqual(Buffer.from([0, 1, 2]));
    expect((await service.sync(target)).status).toBe("synced");
  }, 30_000);

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
    await run(seed, ["config", "core.filemode", "false"]);
    await chmod(join(seed, "scripts", "check.sh"), 0o644);
    expect(await run(seed, ["ls-files", "--stage", "scripts/check.sh"])).toContain("100755");
    expect((await stat(join(seed, "scripts", "check.sh"))).mode & 0o111).toBe(0);
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
    expect(initial.definition.kind === "skill" && initial.definition.executablePaths).toEqual([
      "scripts/check.sh",
    ]);
    expect(
      (await capabilities.listSkillFiles({ id: target.id, revision: 1 })).some((file) =>
        file.path.includes(".git"),
      ),
    ).toBe(false);
    expect(
      (await stat(join(await capabilities.skillFilesPath(target.id, 1), "scripts", "check.sh")))
        .mode & 0o111,
    ).not.toBe(0);
    await chmod(
      join(await capabilities.skillFilesPath(target.id, 1), "scripts", "check.sh"),
      0o600,
    );
    expect((await service.sync(target)).status).toBe("synced");
    expect((await capabilities.get(target.id)).manifest.latestRevision).toBe(1);
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

// Integration tests use a real bare repository and the real knowledge revision store.
describe("knowledge Git metadata synchronization", () => {
  const meta = {
    description: "Guide description",
    trigger: "model_decision" as const,
    priority: "high" as const,
    trustLevel: "workspace" as const,
    sensitivity: "confidential" as const,
  };
  async function commit(seed: string) {
    await run(seed, ["add", "-A"]);
    await run(seed, ["commit", "-m", "Metadata change"]);
    await run(seed, ["push", "origin", "main"]);
  }
  it("exports every field without modifying Markdown and restores them on another device", async () => {
    const { seed, stores, service, source, root, bare } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    const current = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(target.id, "guide.md", current.content, meta, current.revision!);
    expect((await service.sync(target)).status).toBe("synced");
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    const yaml = await readFile(join(seed, ".pragma/metadata/guide.md.yaml"), "utf8");
    expect(yaml).toContain("description: Guide description");
    expect(await readFile(join(seed, "guide.md"), "utf8")).toBe(current.content);
    expect(await readFile(join(seed, "image.txt"), "utf8")).toBe(
      "Not managed by the knowledge base.\n",
    );
    const otherStores = createContextStoreStore({ storesPath: join(root, "other-stores") });
    const other = createAssetGitService({
      stateRoot: join(root, "other-state"),
      stores: otherStores,
      capabilities: {} as CapabilityStore,
    });
    const imported = await other.import({ kind: "knowledge", source });
    expect((await otherStores.getSnapshot(imported.id)).files).toHaveLength(1);
    expect((await otherStores.getContent(imported.id, "guide.md")).metadata).toEqual(meta);
    const head = await run(bare, ["rev-parse", "main"]);
    const revision = (await stores.getSnapshot(target.id)).revision;
    expect((await service.sync(target)).status).toBe("synced");
    expect(await run(bare, ["rev-parse", "main"])).toBe(head);
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
  });
  it.each([
    "\uFEFF# Guide\r\nExact content\r\n",
    "---\ntitle: Original\npriority: original-document-field\n---\n# Guide\n",
    "# Without trailing newline",
    "",
  ])(
    "preserves literal Markdown bytes through import and metadata-only synchronization: %j",
    async (content) => {
      const { seed, bare, stores, service, source } = await fixture();
      const bytes = Buffer.from(content);
      await writeFile(join(seed, "guide.md"), bytes);
      await commit(seed);
      const target = await service.import({ kind: "knowledge", source });
      const file = await stores.getContent(target.id, "guide.md");
      expect(Buffer.from(file.content)).toEqual(bytes);
      await stores.updateFile(target.id, "guide.md", file.content, meta, file.revision!);
      expect((await service.sync(target)).status).toBe("synced");
      const exported = await execFileAsync("git", ["-C", bare, "show", "main:guide.md"], {
        encoding: "buffer",
      });
      expect(exported.stdout).toEqual(bytes);
    },
  );
  it("rejects invalid manual YAML even when the associated conflicting document is deleted", async () => {
    const { seed, bare, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    await service.sync(target);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    const file = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(
      target.id,
      "guide.md",
      "# Local\n",
      { ...file.metadata, priority: "high" },
      file.revision!,
    );
    await writeFile(join(seed, "guide.md"), "# Remote\n");
    const sidecar = join(seed, ".pragma/metadata/guide.md.yaml");
    await writeFile(
      sidecar,
      (await readFile(sidecar, "utf8")).replace("priority: normal", "priority: low"),
    );
    await commit(seed);
    const preview = await service.conflicts(target);
    expect(preview.files.map((file) => file.path).toSorted()).toEqual([
      ".pragma/metadata/guide.md.yaml",
      "guide.md",
    ]);
    const revision = (await stores.getSnapshot(target.id)).revision;
    const head = await run(bare, ["rev-parse", "main"]);
    expect(
      await service.resolve({
        target,
        snapshot: preview.snapshot,
        resolutions: [
          { path: "guide.md", choice: "delete" },
          {
            path: ".pragma/metadata/guide.md.yaml",
            choice: "manual",
            content: "priority: impossible\n",
          },
        ],
      }),
    ).toMatchObject({ status: "error", errorPath: ".pragma/metadata/guide.md.yaml" });
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(head);
  });
  it("merges concurrent fields, restores remote-only changes and clears optional fields", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    let file = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(target.id, "guide.md", file.content, meta, file.revision!);
    await service.sync(target);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    file = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(
      target.id,
      "guide.md",
      file.content,
      { ...meta, priority: "critical" },
      file.revision!,
    );
    const sidecar = join(seed, ".pragma/metadata/guide.md.yaml");
    const yaml = (await readFile(sidecar, "utf8"))
      .replace("description: Guide description\n", "")
      .replace("sensitivity: confidential", "sensitivity: restricted");
    await writeFile(sidecar, yaml);
    await commit(seed);
    expect((await service.sync(target)).status).toBe("synced");
    const remaining = { ...meta, description: undefined };
    expect((await stores.getContent(target.id, "guide.md")).metadata).toEqual({
      ...remaining,
      priority: "critical",
      sensitivity: "restricted",
    });
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    await writeFile(
      sidecar,
      (await readFile(sidecar, "utf8")).replace("trigger: model_decision", "trigger: always_on"),
    );
    await commit(seed);
    expect((await service.sync(target)).status).toBe("synced");
    expect((await stores.getContent(target.id, "guide.md")).metadata.trigger).toBe("always_on");
  });
  it("reports field conflicts as YAML and validates manual resolutions before publication", async () => {
    const { seed, bare, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    await service.sync(target);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    const file = await stores.getContent(target.id, "guide.md");
    await stores.updateFile(
      target.id,
      "guide.md",
      file.content,
      { ...file.metadata, priority: "high" },
      file.revision!,
    );
    const sidecar = join(seed, ".pragma/metadata/guide.md.yaml");
    await writeFile(
      sidecar,
      (await readFile(sidecar, "utf8")).replace("priority: normal", "priority: low"),
    );
    await commit(seed);
    expect((await service.sync(target)).status).toBe("conflict");
    const preview = await service.conflicts(target);
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({
      path: ".pragma/metadata/guide.md.yaml",
      metadata: true,
      documentPath: "guide.md",
    });
    const revision = (await stores.getSnapshot(target.id)).revision,
      head = await run(bare, ["rev-parse", "main"]);
    const rejected = await service.resolve({
      target,
      snapshot: preview.snapshot,
      resolutions: [
        { path: preview.files[0]!.path, choice: "manual", content: "priority: impossible\n" },
      ],
    });
    expect(rejected.status).toBe("error");
    expect(rejected.errorPath).toBe(preview.files[0]!.path);
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(head);
    expect(
      (
        await service.resolve({
          target,
          snapshot: preview.snapshot,
          resolutions: [
            {
              path: preview.files[0]!.path,
              choice: "manual",
              content: preview.files[0]!.mergeLocal!,
            },
          ],
        })
      ).status,
    ).toBe("synced");
    expect((await stores.getContent(target.id, "guide.md")).metadata.priority).toBe("high");
  });
  it.each(["local", "remote"] as const)(
    "preserves independent metadata field edits when resolving conflicting fields with %s",
    async (choice) => {
      const { seed, stores, service, source } = await fixture();
      const target = await service.import({ kind: "knowledge", source });
      await service.sync(target);
      await run(seed, ["pull", "--ff-only", "origin", "main"]);
      const file = await stores.getContent(target.id, "guide.md");
      await stores.updateFile(
        target.id,
        "guide.md",
        file.content,
        { ...file.metadata, description: "Local description", priority: "high" },
        file.revision!,
      );
      const path = ".pragma/metadata/guide.md.yaml",
        sidecar = join(seed, path);
      await writeFile(
        sidecar,
        (await readFile(sidecar, "utf8")).replace("priority: normal", "priority: low") +
          "sensitivity: restricted\n",
      );
      await commit(seed);
      const preview = await service.conflicts(target);
      expect(
        (
          await service.resolve({
            target,
            snapshot: preview.snapshot,
            resolutions: [{ path, choice }],
          })
        ).status,
      ).toBe("synced");
      expect((await stores.getContent(target.id, "guide.md")).metadata).toEqual({
        trigger: "manual",
        priority: choice === "local" ? "high" : "low",
        description: "Local description",
        sensitivity: "restricted",
      });
    },
  );
  it("retains metadata when YAML is removed, mirrors nested documents, and cleans deleted documents", async () => {
    const { seed, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    await stores.createFile(target.id, "guides/setup.md", "# Nested\n", meta);
    await service.sync(target);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    expect(await readFile(join(seed, ".pragma/metadata/guides/setup.md.yaml"), "utf8")).toContain(
      "priority: high",
    );
    await run(seed, ["rm", ".pragma/metadata/guides/setup.md.yaml"]);
    await commit(seed);
    expect((await service.sync(target)).status).toBe("synced");
    expect((await stores.getContent(target.id, "guides/setup.md")).metadata).toEqual(meta);
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    expect(await readFile(join(seed, ".pragma/metadata/guides/setup.md.yaml"), "utf8")).toContain(
      "priority: high",
    );
    await stores.deleteEntry(target.id, "guides/setup.md", "file");
    expect((await service.sync(target)).status).toBe("synced");
    await run(seed, ["pull", "--ff-only", "origin", "main"]);
    await expect(
      readFile(join(seed, ".pragma/metadata/guides/setup.md.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["local", "remote"] as const)(
    "resolves deletion versus metadata editing with the %s document and metadata together",
    async (choice) => {
      const { seed, stores, service, source } = await fixture();
      const target = await service.import({ kind: "knowledge", source });
      await service.sync(target);
      await run(seed, ["pull", "--ff-only", "origin", "main"]);
      const file = await stores.getContent(target.id, "guide.md");
      await stores.updateFile(
        target.id,
        "guide.md",
        file.content,
        { ...file.metadata, priority: "high" },
        file.revision!,
      );
      await run(seed, ["rm", "guide.md", ".pragma/metadata/guide.md.yaml"]);
      await commit(seed);
      expect((await service.sync(target)).status).toBe("conflict");
      const preview = await service.conflicts(target);
      expect(preview.files).toHaveLength(1);
      expect(preview.files[0]).toMatchObject({ path: "guide.md", documentConflict: true });
      expect(
        (
          await service.resolve({
            target,
            snapshot: preview.snapshot,
            resolutions: [{ path: "guide.md", choice }],
          })
        ).status,
      ).toBe("synced");
      if (choice === "local")
        expect((await stores.getContent(target.id, "guide.md")).metadata.priority).toBe("high");
      else expect((await stores.getSnapshot(target.id)).files).toEqual([]);
    },
  );
  it("rejects orphan YAML and reserved local paths without creating a revision or pushing", async () => {
    const { seed, bare, stores, service, source } = await fixture();
    const target = await service.import({ kind: "knowledge", source });
    await mkdir(join(seed, ".pragma/metadata"), { recursive: true });
    await writeFile(
      join(seed, ".pragma/metadata/missing.md.yaml"),
      "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: manual\npriority: normal\n",
    );
    await commit(seed);
    const revision = (await stores.getSnapshot(target.id)).revision,
      head = await run(bare, ["rev-parse", "main"]);
    expect((await service.sync(target)).status).toBe("error");
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(head);
    await expect(service.import({ kind: "knowledge", source })).rejects.toThrow(
      "corresponding Markdown",
    );
    await stores.createFile(target.id, ".pragma/metadata/occupied.md", "# Occupied\n");
    await expect(service.sync(target)).rejects.toThrow("reserved");
  });
});

it("rejects malformed, future and oversized remote YAML and metadata symlinks before publication", async () => {
  const { seed, bare, stores, service, source } = await fixture();
  const target = await service.import({ kind: "knowledge", source });
  await service.sync(target);
  await run(seed, ["pull", "--ff-only", "origin", "main"]);
  const path = ".pragma/metadata/guide.md.yaml",
    sidecar = join(seed, path);
  const revision = (await stores.getSnapshot(target.id)).revision;
  for (const yaml of [
    "schemaVersion: [\n",
    "schemaVersion: pragma.knowledge-document-metadata/v99\ntrigger: manual\npriority: normal\n",
    "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: manual\npriority: normal\npriority: high\n",
    "x".repeat(65_537),
  ]) {
    await writeFile(sidecar, yaml);
    await run(seed, ["add", "-A"]);
    await run(seed, ["commit", "-m", "Invalid metadata"]);
    await run(seed, ["push", "origin", "main"]);
    const head = await run(bare, ["rev-parse", "main"]);
    expect(await service.sync(target)).toMatchObject({ status: "error", errorPath: path });
    expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
    expect(await run(bare, ["rev-parse", "main"])).toBe(head);
  }
  await rm(sidecar);
  await symlink("../../../guide.md", sidecar);
  await run(seed, ["add", "-A"]);
  await run(seed, ["commit", "-m", "Metadata symlink"]);
  await run(seed, ["push", "origin", "main"]);
  expect((await service.sync(target)).status).toBe("error");
  expect((await stores.getSnapshot(target.id)).revision).toBe(revision);
}, 30_000);
