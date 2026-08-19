import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("treats capture as the master switch for persisted global settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-master-switch-"));
    const store = createFileMemoryPolicyStore({ pragmaHome: home });

    await expect(
      store.updateGlobal({
        expectedRevision: 0,
        policy: { capture: "disabled", recall: "enabled", learning: "local-candidates" },
      }),
    ).resolves.toMatchObject({
      revision: 1,
      policy: { capture: "disabled", recall: "disabled", learning: "disabled" },
    });
    await expect(store.getGlobal()).resolves.toMatchObject({
      revision: 1,
      policy: { capture: "disabled", recall: "disabled", learning: "disabled" },
    });
    await expect(store.resolveAt({ occurredAt: new Date().toISOString() })).resolves.toMatchObject({
      capture: false,
      recall: false,
      learning: "disabled",
    });
  });

  it("resolves the policy revision effective when the event occurred and rejects stale writers", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-history-"));
    let time = new Date("2026-08-01T01:00:00.000Z");
    const store = createFileMemoryPolicyStore({ pragmaHome: home, now: () => time });

    await store.updateGlobal({
      expectedRevision: 0,
      policy: { capture: "disabled", recall: "disabled", learning: "disabled" },
    });
    await expect(
      store.updateGlobal({
        expectedRevision: 0,
        policy: { capture: "enabled", recall: "enabled", learning: "local-candidates" },
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
      policy: { capture: "enabled", recall: "enabled", learning: "local-candidates" },
    });
    await expect(
      store.resolveAt({ occurredAt: "2026-08-01T01:30:00.000Z" }),
    ).resolves.toMatchObject({ capture: false, recall: false, learning: "disabled" });
  });

  it("fails closed when persisted policy history is corrupt or from a future schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-policy-corrupt-"));
    const path = new PragmaPaths({ pragmaHome: home }).memoryGlobalPolicy();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: "pragma.memory-policy-history/v2", revisions: [] }),
    );
    const store = createFileMemoryPolicyStore({ pragmaHome: home });

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
