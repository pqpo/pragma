import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PragmaBlueprintCacheObservation,
  PragmaBlueprintCacheStore,
} from "../src/compiler/pragma-project.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("Pragma project Blueprint cache", () => {
  it("rehydrates a serialized Blueprint from the Host cache within the warm-load gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-blueprint-cache-"));
    roots.push(root);
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      ["apiVersion: pragma/v3", "kind: Bundle", "imports: []", "resources: []", ""].join("\n"),
    );
    const values = new Map<string, Uint8Array>();
    const store: PragmaBlueprintCacheStore = {
      read: async (key) => values.get(key),
      write: async (key, value) => {
        values.set(key, value);
      },
    };
    const firstObservations: PragmaBlueprintCacheObservation[] = [];
    const firstModule = await import("../src/compiler/pragma-project.ts");

    await firstModule.loadPragmaProject(entry, {
      rootDir: root,
      sourceIdentity: "immutable-revision-1",
      blueprintCache: store,
      onBlueprintCacheLookup: (observation) => firstObservations.push(observation),
    });
    await vi.waitFor(() => expect(values.size).toBe(1));
    expect(firstObservations).toEqual([expect.objectContaining({ tier: "miss", hit: false })]);

    // A fresh module simulates a process whose compiler L1 is empty. Invalidating
    // the source proves the result below came from the serialized Host Blueprint.
    vi.resetModules();
    await writeFile(entry, "not valid Pragma YAML\n");
    const secondObservations: PragmaBlueprintCacheObservation[] = [];
    const secondModule = await import("../src/compiler/pragma-project.ts");
    const project = await secondModule.loadPragmaProject(entry, {
      rootDir: root,
      sourceIdentity: "immutable-revision-1",
      blueprintCache: store,
      onBlueprintCacheLookup: (observation) => secondObservations.push(observation),
    });
    expect(project.listResources()).toEqual([]);
    expect(secondObservations).toEqual([expect.objectContaining({ tier: "host", hit: true })]);
    expect(secondObservations[0]!.durationMs).toBeLessThan(200);
  }, 15_000);
});
