import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSystemContextStore } from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("FileSystemContextStore", () => {
  it("keeps Git internals out of listing, search, and direct reads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-file-context-git-"));
    temporaryRoots.push(rootDir);
    await mkdir(join(rootDir, ".git"));
    await writeFile(join(rootDir, ".git", "config.md"), "hidden token", "utf8");
    await writeFile(join(rootDir, "visible.md"), "visible", "utf8");
    const store = new FileSystemContextStore({ rootDir });

    await expect(store.listContext({})).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "visible.md" })],
    });
    await expect(
      store.searchContext({ query: "hidden token", scope: "content", maxResults: 10 }),
    ).resolves.toMatchObject({ ok: true, value: [] });
    await expect(store.readContext({ id: ".git/config.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
  });

  it("preserves Git metadata paths when reconstructing trusted historical storage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-file-context-legacy-git-"));
    temporaryRoots.push(rootDir);
    const store = new FileSystemContextStore({ rootDir, allowGitMetadataPaths: true });

    await expect(
      store.addContext({ id: ".git/internal.md", content: "# Historical metadata\n" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(store.listContext()).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: ".git/internal.md" })],
    });
    await expect(store.readContext({ id: ".git/internal.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Historical metadata\n" },
    });
  });

  it("prepends and appends content with the requested separator", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-file-context-"));
    temporaryRoots.push(rootDir);
    const store = new FileSystemContextStore({ rootDir });
    const added = await store.addContext({ id: "notes.md", content: "body" });
    if (!added.ok) throw new Error(added.error.message);

    const started = await store.editContext({
      id: "notes.md",
      mode: "prepend",
      content: "head-",
      separator: "newline",
      expectedRevision: added.value.revision,
    });
    expect(started).toMatchObject({
      ok: true,
      value: { content: "head-\nbody", mode: "prepend" },
    });
    if (!started.ok) throw new Error(started.error.message);

    await expect(
      store.editContext({
        id: "notes.md",
        mode: "replace",
        content: "stale",
        expectedRevision: added.value.revision,
        expectedEtag: added.value.etag,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "context_conflict",
        details: {
          expectedRevision: added.value.revision,
          currentRevision: started.value.revision,
          expectedEtag: added.value.etag,
          currentEtag: started.value.etag,
        },
      },
    });

    await expect(
      store.editContext({
        id: "notes.md",
        mode: "append",
        content: "-tail",
        separator: "blank_line",
        expectedEtag: started.value.etag,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { content: "head-\nbody\n\n-tail", mode: "append" },
    });
  });

  it("rejects path traversal without touching files outside the Context root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "pragma-file-context-boundary-"));
    temporaryRoots.push(parentDir);
    const rootDir = join(parentDir, "root");
    const outsidePath = join(parentDir, "outside.md");
    await mkdir(rootDir);
    await writeFile(outsidePath, "outside", "utf8");
    const store = new FileSystemContextStore({ rootDir });

    await expect(store.readContext({ id: "../outside.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
    await expect(
      store.addContext({ id: "../outside.md", content: "overwritten" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "store_error" } });
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside");
  });

  it("rejects a symlink that escapes the Context root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "pragma-file-context-symlink-"));
    temporaryRoots.push(parentDir);
    const rootDir = join(parentDir, "root");
    const outsidePath = join(parentDir, "outside.md");
    await mkdir(rootDir);
    await writeFile(outsidePath, "outside", "utf8");
    await symlink(outsidePath, join(rootDir, "linked.md"));
    const store = new FileSystemContextStore({ rootDir });

    await expect(store.readContext({ id: "linked.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
  });

  it("applies Host authorization to reads, writes, listing, and search", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-file-context-auth-"));
    temporaryRoots.push(rootDir);
    await writeFile(join(rootDir, "allowed.md"), "visible content", "utf8");
    const authorize = vi.fn(({ operation, ids }: { operation: string; ids: readonly string[] }) =>
      operation === "list" ? ids : [],
    );
    const store = new FileSystemContextStore({ rootDir, authorize });

    await expect(store.listContext({})).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "allowed.md" })],
    });
    await expect(store.readContext({ id: "allowed.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await expect(store.addContext({ id: "new.md", content: "denied" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await expect(
      store.searchContext({ query: "visible", scope: "content", maxResults: 10 }),
    ).resolves.toMatchObject({ ok: true, value: [] });
    expect(authorize.mock.calls.map(([input]) => input.operation)).toEqual([
      "list",
      "read",
      "add",
      "search",
    ]);
  });
});
