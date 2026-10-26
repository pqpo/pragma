import { describe, expect, it, vi } from "vitest";
import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";
import { AssetDirectoryLoader } from "./asset-directory-loader.ts";
import { visibleAssetFileEntries } from "./AssetFileTree.tsx";

const folder = (id: string): ContextStoreEntry => ({ id, kind: "directory" });
const file = (id: string): ContextStoreEntry => ({ id, kind: "file" });

describe("lazy asset directories", () => {
  it("distinguishes unknown children from paths deleted or replaced during refresh", async () => {
    let updated = false;
    const loader = new AssetDirectoryLoader(async () =>
      updated ? [file("guides")] : [folder("guides")],
    );
    await loader.refresh();
    expect(loader.contains("guides/a.md")).toBeUndefined();
    expect(loader.contains("missing/a.md")).toBe(false);
    updated = true;
    await loader.refresh();
    expect(loader.contains("guides/a.md")).toBe(false);
  });
  it("does not collapse a refreshed directory when an obsolete request fails", async () => {
    let reject!: (error: Error) => void;
    let attempts = 0;
    const loader = new AssetDirectoryLoader(async (directory) => {
      if (directory === "") return [folder("guides")];
      if (attempts++ === 0)
        return await new Promise<ContextStoreEntry[]>((_, fail) => {
          reject = fail;
        });
      return [file("guides/new.md")];
    });
    await loader.refresh();
    const stale = loader.toggle("guides");
    const settled = stale.catch(() => undefined);
    await Promise.resolve();
    await loader.refresh();
    reject(new Error("obsolete"));
    expect(await settled).toBe(false);
    expect(loader.getSnapshot().collapsed.has("guides")).toBe(false);
    expect(loader.getSnapshot().entries).toContainEqual(file("guides/new.md"));
  });

  it("removes deleted descendants even if refreshing a sibling fails", async () => {
    let updated = false;
    const loader = new AssetDirectoryLoader(async (directory) => {
      if (directory === "")
        return updated ? [folder("sibling")] : [folder("guides"), folder("sibling")];
      if (directory === "sibling" && updated) throw new Error("unavailable");
      return [file(`${directory}/a.md`)];
    });
    await loader.refresh();
    await loader.toggle("guides");
    await loader.toggle("sibling");
    updated = true;
    await expect(loader.refresh()).rejects.toThrow("unavailable");
    expect(loader.getSnapshot().entries.some((entry) => entry.id.startsWith("guides/"))).toBe(
      false,
    );
  });

  it("requests only the root of a 1,000-file resource, then caches explicitly opened directories", async () => {
    const root = Array.from({ length: 5 }, (_, index) => folder(`folder-${index}`));
    const read = vi.fn(async (directory: string) =>
      directory === ""
        ? root
        : Array.from({ length: 200 }, (_, index) => file(`${directory}/${index}.md`)),
    );
    const loader = new AssetDirectoryLoader(read);
    await loader.refresh();
    expect(read.mock.calls).toEqual([[""]]);
    expect(loader.getSnapshot().entries).toEqual(root);
    expect(loader.getSnapshot().collapsed).toEqual(new Set(root.map((entry) => entry.id)));

    await loader.toggle("folder-0");
    expect(read.mock.calls).toEqual([[""], ["folder-0"]]);
    expect(loader.getSnapshot().entries).toHaveLength(205);
    await loader.toggle("folder-0");
    expect(
      visibleAssetFileEntries(loader.getSnapshot().entries, loader.getSnapshot().collapsed),
    ).toHaveLength(5);
    await loader.toggle("folder-0");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("deduplicates in-flight reads, exposes pending state, and retries failed directories", async () => {
    let resolve!: (entries: ContextStoreEntry[]) => void;
    const read = vi.fn(
      () =>
        new Promise<ContextStoreEntry[]>((done) => {
          resolve = done;
        }),
    );
    const loader = new AssetDirectoryLoader(read);
    const first = loader.load("guides");
    const second = loader.load("guides");
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(loader.getSnapshot().pending.has("guides")).toBe(true);
    resolve([]);
    await Promise.all([first, second]);
    expect(loader.getSnapshot().pending.size).toBe(0);

    const retry = vi.fn(async (): Promise<readonly ContextStoreEntry[]> => {
      throw new Error("unavailable");
    });
    const failed = new AssetDirectoryLoader(retry);
    failed.setEntries(() => [folder("guides")]);
    await expect(failed.toggle("guides")).rejects.toThrow("unavailable");
    expect(failed.getSnapshot().collapsed.has("guides")).toBe(true);
    retry.mockImplementation(async () => []);
    await failed.toggle("guides");
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("refreshes expanded directories, evicts closed caches, and removes deleted descendants", async () => {
    const contents = new Map<string, ContextStoreEntry[]>([
      ["", [folder("guides"), folder("closed")]],
      ["guides", [folder("guides/nested"), file("guides/old.md")]],
      ["guides/nested", [file("guides/nested/old.md")]],
      ["closed", [file("closed/old.md")]],
    ]);
    const read = vi.fn(async (directory: string) => contents.get(directory) ?? []);
    const loader = new AssetDirectoryLoader(read);
    await loader.refresh();
    await loader.toggle("guides");
    await loader.toggle("guides/nested");
    await loader.toggle("closed");
    await loader.toggle("closed");
    contents.set("guides", [file("guides/new.md")]);
    read.mockClear();
    await loader.refresh();
    expect(read.mock.calls).toEqual([[""], ["guides"]]);
    expect(loader.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      "closed",
      "guides",
      "guides/new.md",
    ]);
    await loader.toggle("closed");
    expect(read).toHaveBeenLastCalledWith("closed");
  });

  it("ignores obsolete responses and preserves cached descendants across folder renames", async () => {
    let resolve!: (entries: ContextStoreEntry[]) => void;
    const loader = new AssetDirectoryLoader(async (directory) =>
      directory === ""
        ? [folder("guides")]
        : await new Promise<ContextStoreEntry[]>((done) => {
            resolve = done;
          }),
    );
    await loader.refresh();
    const stale = loader.load("guides");
    await Promise.resolve();
    await loader.refresh();
    resolve([file("guides/stale.md")]);
    await stale;
    expect(loader.getSnapshot().entries).toEqual([folder("guides")]);
    loader.setEntries(() => [folder("guides"), file("guides/a.md")]);
    loader.rebase("guides", "renamed");
    expect(loader.getSnapshot().entries).toEqual([folder("renamed"), file("renamed/a.md")]);
  });

  it("invalidates a deleted folder cache when its path is reused", async () => {
    const read = vi.fn(async (directory: string) =>
      directory === "" ? [folder("guides")] : [file("guides/a.md")],
    );
    const loader = new AssetDirectoryLoader(read);
    await loader.refresh();
    await loader.toggle("guides");
    loader.remove("guides");
    loader.setEntries((entries) => [...entries, folder("guides")]);
    await loader.toggle("guides");
    expect(read.mock.calls).toEqual([[""], ["guides"], ["guides"]]);
    expect(loader.getSnapshot().entries).toContainEqual(file("guides/a.md"));
    await expect(loader.reveal("removed/a.md")).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
