import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContentAddressedStore } from "../src/storage/content-addressed-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("ContentAddressedStore", () => {
  it("deduplicates unchanged files across Merkle snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-cas-"));
    roots.push(root);
    const store = new ContentAddressedStore(join(root, "objects"));
    const first = await store.putSnapshot(
      new Map([
        ["experts/writer.yaml", Buffer.from("writer-v1")],
        ["assets/guide.md", Buffer.from("shared-guide")],
      ]),
    );
    const second = await store.putSnapshot(
      new Map([
        ["experts/writer.yaml", Buffer.from("writer-v2")],
        ["assets/guide.md", Buffer.from("shared-guide")],
      ]),
    );

    expect(second.root.hash).not.toBe(first.root.hash);
    const firstRoot = await store.readTree(first.root.hash);
    const secondRoot = await store.readTree(second.root.hash);
    expect(firstRoot.entries.find((entry) => entry.name === "assets")?.hash).toBe(
      secondRoot.entries.find((entry) => entry.name === "assets")?.hash,
    );
    const checkout = join(root, "checkout");
    await store.materializeTree(second.root.hash, checkout);
    await expect(readFile(join(checkout, "assets", "guide.md"), "utf8")).resolves.toBe(
      "shared-guide",
    );
  });

  it("collects only objects unreachable from revision roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-cas-gc-"));
    roots.push(root);
    const store = new ContentAddressedStore(join(root, "objects"));
    const snapshot = await store.putSnapshot(new Map([["pragma.yaml", Buffer.from("root")]]));
    const orphan = await store.putBlob(Buffer.from("orphan"));

    const result = await store.collectGarbage({ roots: [snapshot.root], graceMs: 0 });

    expect(result.deletedObjects).toBe(1);
    await expect(stat(store.objectPath(orphan))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(store.objectPath(snapshot.root))).resolves.toBeDefined();
  });
});
