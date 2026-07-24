import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAtomicStateMigration,
  defineStateMigrationChain,
  PragmaPaths,
  readRuntimeSessionRecord,
  recoverAtomicStateMigration,
  StateVersionTooNewError,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("versioned state migrations", () => {
  it("applies an explicit adjacent migration chain to the current schema", () => {
    const chain = defineStateMigrationChain({
      family: "pragma.example",
      currentVersion: 3,
      currentSchema: z.object({
        schemaVersion: z.literal("pragma.example/v3"),
        displayName: z.string(),
      }),
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          inputSchema: z.object({
            schemaVersion: z.literal("pragma.example/v1"),
            name: z.string(),
          }),
          migrate(value) {
            const record = value as { readonly name: string };
            return { schemaVersion: "pragma.example/v2", label: record.name };
          },
        },
        {
          fromVersion: 2,
          toVersion: 3,
          inputSchema: z.object({
            schemaVersion: z.literal("pragma.example/v2"),
            label: z.string(),
          }),
          migrate(value) {
            const record = value as { readonly label: string };
            return { schemaVersion: "pragma.example/v3", displayName: record.label };
          },
        },
      ],
    });

    expect(chain.upgrade({ schemaVersion: "pragma.example/v1", name: "Pragma" })).toEqual({
      value: { schemaVersion: "pragma.example/v3", displayName: "Pragma" },
      fromVersion: 1,
      toVersion: 3,
      migrated: true,
    });
  });

  it("rejects state written by a newer application without changing it", () => {
    const chain = defineStateMigrationChain({
      family: "pragma.example",
      currentVersion: 2,
      currentSchema: z.object({ schemaVersion: z.literal("pragma.example/v2") }),
    });

    expect(() => chain.upgrade({ schemaVersion: "pragma.example/v3" })).toThrow(
      StateVersionTooNewError,
    );
  });

  it("replays a partially applied multi-document migration journal", async () => {
    const root = await temporaryRoot("pragma-state-migration-");
    const journalFile = join(root, "state-migration.json");
    const documents = {
      "record.json": { schemaVersion: "pragma.example/v2", value: "new" },
      "children.json": [{ id: "child", output: { type: "inline", value: "done" } }],
    };
    const validateDocuments = (value: Readonly<Record<string, unknown>>) => {
      z.object({ schemaVersion: z.literal("pragma.example/v2"), value: z.string() }).parse(
        value["record.json"],
      );
      z.array(
        z.object({
          id: z.string(),
          output: z.object({ type: z.literal("inline"), value: z.unknown() }),
        }),
      ).parse(value["children.json"]);
    };
    await mkdir(root, { recursive: true });
    await writeJson(join(root, "record.json"), documents["record.json"]);
    await writeJson(join(root, "children.json"), [{ id: "child", output: "old" }]);
    await writeJson(journalFile, {
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.example", id: "example" },
      fromVersion: 1,
      toVersion: 2,
      documents,
    });

    await expect(
      recoverAtomicStateMigration({
        aggregateRoot: root,
        journalFile,
        resource: { family: "pragma.example", id: "example" },
        validateDocuments,
      }),
    ).resolves.toBe(true);

    await expect(readJson(join(root, "record.json"))).resolves.toEqual(documents["record.json"]);
    await expect(readJson(join(root, "children.json"))).resolves.toEqual(
      documents["children.json"],
    );
    await expect(readFile(journalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every document before publishing the migration journal", async () => {
    const root = await temporaryRoot("pragma-state-validation-");
    const journalFile = join(root, "state-migration.json");

    await expect(
      applyAtomicStateMigration({
        aggregateRoot: root,
        journalFile,
        resource: { family: "pragma.example", id: "example" },
        fromVersion: 1,
        toVersion: 2,
        documents: {
          "record.json": { schemaVersion: "pragma.example/v2" },
          "../escaped.json": {},
        },
        validateDocuments() {},
      }),
    ).rejects.toThrow("escapes its aggregate root");
    await expect(readFile(journalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "..", "escaped.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers Runtime Session state with the same fail-closed version policy", async () => {
    const home = await temporaryRoot("pragma-runtime-session-future-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, {
      schemaVersion: "pragma.runtime-session/v4",
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "runtime-session",
    });
    const before = await readFile(file, "utf8");

    await expect(readRuntimeSessionRecord(paths, "owner", "runtime-session")).rejects.toThrow(
      "unsupported-state-version",
    );

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("upgrades Runtime Session v2 records with an empty context-window snapshot", async () => {
    const home = await temporaryRoot("pragma-runtime-session-v2-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, {
      schemaVersion: "pragma.runtime-session/v2",
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "runtime-session",
      expertId: "expert",
      runtime: { id: "runtime", kind: "test" },
      runtimeSessionRef: { type: "test", id: "native-session" },
      currentWorkspace: "/workspace",
      workspaceHistory: ["/workspace"],
      processState: "stopped",
      retentionState: "retained",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });

    const upgraded = await readRuntimeSessionRecord(paths, "owner", "runtime-session");
    expect(upgraded).toEqual(
      expect.objectContaining({ schemaVersion: "pragma.runtime-session/v3" }),
    );
    expect(upgraded).not.toHaveProperty("contextWindowUsage");
    await expect(readJson(file)).resolves.toEqual(
      expect.objectContaining({ schemaVersion: "pragma.runtime-session/v3" }),
    );
  });

  it("reads current Runtime Session context-window snapshots without rewriting them", async () => {
    const home = await temporaryRoot("pragma-runtime-session-v3-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, {
      schemaVersion: "pragma.runtime-session/v3",
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "runtime-session",
      expertId: "expert",
      runtime: { id: "runtime", kind: "test" },
      runtimeSessionRef: { type: "test", id: "native-session" },
      contextWindowUsage: {
        usedTokens: 32_000,
        contextWindowTokens: 128_000,
        percent: 25,
        measurement: "estimated",
        observedAt: "2026-07-24T00:00:00.000Z",
      },
      currentWorkspace: "/workspace",
      workspaceHistory: ["/workspace"],
      processState: "stopped",
      retentionState: "retained",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    const before = await readFile(file, "utf8");

    await expect(readRuntimeSessionRecord(paths, "owner", "runtime-session")).resolves.toMatchObject(
      { contextWindowUsage: { usedTokens: 32_000, percent: 25 } },
    );
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
