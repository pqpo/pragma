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
  it("coalesces concurrent source builds after a cache miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-blueprint-single-flight-"));
    roots.push(root);
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      ["apiVersion: pragma/v5", "kind: Bundle", "imports: []", "resources: []", ""].join("\n"),
    );
    const write = vi.fn(async () => undefined);
    const store: PragmaBlueprintCacheStore = {
      read: async () => undefined,
      write,
    };
    const compiler = await import("../src/compiler/pragma-project.ts");

    await Promise.all([
      compiler.loadPragmaProject(entry, {
        rootDir: root,
        sourceIdentity: "immutable-single-flight-revision",
        blueprintCache: store,
      }),
      compiler.loadPragmaProject(entry, {
        rootDir: root,
        sourceIdentity: "immutable-single-flight-revision",
        blueprintCache: store,
      }),
    ]);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  }, 15_000);

  it("rehydrates a serialized Blueprint from the Host cache within the warm-load gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-blueprint-cache-"));
    roots.push(root);
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      ["apiVersion: pragma/v5", "kind: Bundle", "imports: []", "resources: []", ""].join("\n"),
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

  it("rebuilds a legacy Blueprint cache that can hide resources rejected by an old parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-blueprint-version-"));
    roots.push(root);
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      [
        "apiVersion: pragma/v5",
        "kind: Bundle",
        "imports: []",
        "resources:",
        "  - apiVersion: pragma/v5",
        "    kind: ExpertTeam",
        "    metadata:",
        "      id: vyv9pwwzaksth2dd",
        "      avatarId: pragma.avatar.team.default",
        "      name: Delivery",
        "      description: Coordinates delivery",
        "      tags: []",
        "    spec:",
        "      coordinator: { ref: expert:mrvsehytqfmb814x }",
        "      members: [{ ref: expert:3sfd30h5017wd17d }]",
        "      delegation: {}",
        "",
      ].join("\n"),
    );
    const remove = vi.fn<NonNullable<PragmaBlueprintCacheStore["remove"]>>(async () => undefined);
    const write = vi.fn<PragmaBlueprintCacheStore["write"]>(async () => undefined);
    const store: PragmaBlueprintCacheStore = {
      read: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: "pragma.project-blueprint/v1",
            compilerVersion: "pragma.dsl/v6",
            sourceIdentity: "immutable-versioned-revision",
            entry: "pragma.yaml",
            resources: [],
            artifacts: [],
            diagnostics: [
              {
                severity: "error",
                code: "schema.invalid",
                message: 'Unrecognized key: "avatarId"',
              },
            ],
          }),
        ),
      write,
      remove,
    };
    const compiler = await import("../src/compiler/pragma-project.ts");

    const project = await compiler.loadPragmaProject(entry, {
      rootDir: root,
      sourceIdentity: "immutable-versioned-revision",
      blueprintCache: store,
    });

    expect(project.listResources()).toEqual([
      expect.objectContaining({
        kind: "ExpertTeam",
        metadata: expect.objectContaining({ id: "vyv9pwwzaksth2dd" }),
      }),
    ]);
    expect(remove).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const encoded = write.mock.calls[0]?.[1];
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(encoded))).toMatchObject({
      schemaVersion: "pragma.project-blueprint/v2",
      resources: [{ resource: { kind: "ExpertTeam" } }],
      diagnostics: [],
    });
  });
});
