import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { createFileMemoryPolicyStore } from "../src/index.ts";

describe("FileMemoryPolicyStore", () => {
  it("uses safe defaults and resolves the strict intersection of root, producer, and mission", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-"));
    let time = new Date("2026-08-01T00:00:00.000Z");
    const store = createFileMemoryPolicyStore({ pragmaHome: home, now: () => time });
    const rootRef = { type: "pragma.expert-team", id: "review-team" } as const;
    const producerRef = { type: "pragma.expert", id: "reviewer" } as const;

    await expect(store.getGlobal()).resolves.toMatchObject({
      revision: 0,
      policy: { capture: "disabled", recall: "disabled", learning: "disabled" },
    });
    await expect(store.getOverride(rootRef)).resolves.toMatchObject({
      revision: 0,
      policy: { capture: "inherit", recall: "inherit", learning: "inherit" },
    });

    time = new Date("2026-08-01T01:00:00.000Z");
    await store.updateOverride({
      targetRef: rootRef,
      expectedRevision: 0,
      policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
    });
    time = new Date("2026-08-01T02:00:00.000Z");
    await store.updateOverride({
      targetRef: producerRef,
      expectedRevision: 0,
      policy: { capture: "disabled", recall: "enabled", learning: "disabled" },
    });

    await expect(
      store.resolveAt({
        rootRef,
        producerRefs: [producerRef, producerRef],
        occurredAt: "2026-08-01T03:00:00.000Z",
        missionRestriction: { recall: false },
      }),
    ).resolves.toEqual({
      capture: false,
      recall: false,
      learning: "disabled",
      appliedRevisions: [
        { scope: "global", revision: 0 },
        { scope: "asset", targetRef: rootRef, revision: 1 },
        { scope: "asset", targetRef: producerRef, revision: 1 },
        { scope: "mission", revision: 0 },
      ],
    });
  });

  it("keeps child settings while the global switch gates effective policy", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-master-switch-"));
    const store = createFileMemoryPolicyStore({ pragmaHome: home });

    await expect(
      store.updateGlobal({
        expectedRevision: 0,
        policy: {
          enabled: "disabled",
          capture: "disabled",
          recall: "enabled",
          learning: "local-candidates",
        },
      }),
    ).resolves.toMatchObject({
      revision: 1,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    await expect(store.getGlobal()).resolves.toMatchObject({
      revision: 1,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    await expect(store.resolveAt({ occurredAt: new Date().toISOString() })).resolves.toMatchObject({
      capture: false,
      recall: false,
      learning: "disabled",
    });

    await store.updateGlobal({
      expectedRevision: 1,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    await expect(store.resolveAt({ occurredAt: new Date().toISOString() })).resolves.toMatchObject({
      capture: true,
      recall: true,
      learning: "local-candidates",
    });
  });

  it("resolves the policy revision effective when the event occurred and rejects stale writers", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-history-"));
    let time = new Date("2026-08-01T01:00:00.000Z");
    const store = createFileMemoryPolicyStore({ pragmaHome: home, now: () => time });

    await store.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "disabled",
        learning: "disabled",
      },
    });
    await expect(
      store.updateGlobal({
        expectedRevision: 0,
        policy: {
          enabled: "enabled",
          capture: "enabled",
          recall: "enabled",
          learning: "local-candidates",
        },
      }),
    ).rejects.toMatchObject({ code: "memory_policy_revision_conflict", expected: 0, actual: 1 });

    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T00:30:00.000Z" }),
    ).resolves.toMatchObject({ capture: false, recall: false, learning: "disabled" });
    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T01:30:00.000Z" }),
    ).resolves.toMatchObject({ capture: false, recall: false, learning: "disabled" });

    time = new Date("2026-08-01T02:00:00.000Z");
    await store.updateGlobal({
      expectedRevision: 1,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T01:30:00.000Z" }),
    ).resolves.toMatchObject({ capture: false, recall: false, learning: "disabled" });
  });

  it("migrates legacy global history with a backup and replayable journal", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-migration-"));
    const path = new PragmaPaths({ pragmaHome: home }).memoryGlobalPolicy();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "pragma.memory-policy-history/v1",
        revisions: [
          {
            schemaVersion: "pragma.memory-policy/v1",
            scope: "global",
            revision: 1,
            effectiveFrom: "2026-08-01T01:00:00.000Z",
            policy: { capture: "disabled", recall: "enabled", learning: "local-candidates" },
          },
          {
            schemaVersion: "pragma.memory-policy/v1",
            scope: "global",
            revision: 2,
            effectiveFrom: "2026-08-01T02:00:00.000Z",
            policy: { capture: "enabled", recall: "disabled", learning: "disabled" },
          },
        ],
      }),
    );
    await writeFile(
      `${path}.migration-journal`,
      JSON.stringify({
        schemaVersion: "pragma.memory-policy-migration-journal/v1",
        sourceSchemaVersion: "pragma.memory-policy-history/v1",
        targetSchemaVersion: "pragma.memory-policy-history/v2",
        sourcePath: path,
        backupPath: `${path}.v1-backup`,
      }),
    );
    const store = createFileMemoryPolicyStore({ pragmaHome: home });

    await expect(store.getGlobal(new Date("2026-08-01T01:30:00.000Z"))).resolves.toMatchObject({
      schemaVersion: "pragma.memory-policy/v2",
      revision: 1,
      policy: { enabled: "disabled", recall: "enabled", learning: "local-candidates" },
    });
    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T01:30:00.000Z" }),
    ).resolves.toMatchObject({
      capture: false,
      recall: false,
      learning: "disabled",
    });
    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T02:30:00.000Z" }),
    ).resolves.toMatchObject({
      capture: true,
      recall: false,
      learning: "disabled",
    });

    await expect(
      readFile(path).then((value) => JSON.parse(value.toString())),
    ).resolves.toMatchObject({ schemaVersion: "pragma.memory-policy-history/v2" });
    await expect(readFile(`${path}.v1-backup`, "utf8")).resolves.toContain(
      "pragma.memory-policy-history/v1",
    );
    await expect(readFile(`${path}.migration-journal`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when persisted policy history is corrupt or from a future schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-corrupt-"));
    const path = new PragmaPaths({ pragmaHome: home }).memoryGlobalPolicy();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "pragma.memory-policy-history/v2",
        revisions: [
          {
            schemaVersion: "pragma.memory-policy/v2",
            scope: "global",
            revision: 1,
            effectiveFrom: "2026-08-01T00:00:00.000Z",
            policy: {
              enabled: "disabled",
              capture: "disabled",
              recall: "enabled",
              learning: "local-candidates",
            },
          },
        ],
      }),
    );
    const store = createFileMemoryPolicyStore({ pragmaHome: home });

    await expect(store.getGlobal()).resolves.toMatchObject({
      schemaVersion: "pragma.memory-policy/v2",
      revision: 1,
      policy: { enabled: "disabled", recall: "enabled", learning: "local-candidates" },
    });

    await writeFile(
      path,
      JSON.stringify({ schemaVersion: "pragma.memory-policy-history/v3", revisions: [] }),
    );
    await expect(store.getGlobal()).rejects.toThrow();
    await expect(store.resolveAt({ occurredAt: "2026-08-01T00:00:00.000Z" })).rejects.toThrow();

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "pragma.memory-policy-history/v1",
        revisions: [
          {
            schemaVersion: "pragma.memory-policy/v1",
            scope: "global",
            revision: 2,
            effectiveFrom: "2026-08-01T00:00:00.000Z",
            policy: { capture: "enabled", recall: "enabled", learning: "local-candidates" },
          },
        ],
      }),
    );
    await expect(store.getGlobal()).rejects.toThrow("not contiguous");
  });
});
