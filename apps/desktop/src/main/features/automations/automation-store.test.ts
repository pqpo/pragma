import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { derivePragmaResourceId, PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createAutomationBinding, createAutomationStore } from "./automation-store.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AutomationStore", () => {
  it("persists a strict binding and a recoverable FIFO queue", async () => {
    const paths = await temporaryPaths();
    const store = createAutomationStore(paths, "studio");
    const binding = createAutomationBinding({
      automationRef: "automation:hrxn3mv2e991j2rj",
      rotateGeneration: true,
      workspace: { path: "/work/review", basename: "review" },
      toolPermissionMode: "request-approval",
    });
    await store.saveBinding(binding);
    await store.updateState(binding.automationRef, binding.generation, (state) => ({
      ...state,
      queue: [
        {
          eventId: "event-1",
          scheduledFor: "2026-07-23T01:00:00.000Z",
          missionId: "21ec2020-3aea-4d3d-a5f0-f60732631e15",
          createdAt: "2026-07-23T01:00:00.000Z",
        },
      ],
    }));

    await expect(store.getBinding(binding.automationRef)).resolves.toEqual(binding);
    await expect(store.getState(binding.automationRef, binding.generation)).resolves.toMatchObject({
      schemaVersion: "pragma.automation-state/v1",
      queue: [{ eventId: "event-1" }],
    });
  });

  it("starts a fresh state projection after a binding generation rotates", async () => {
    const paths = await temporaryPaths();
    const store = createAutomationStore(paths, "studio");
    const first = createAutomationBinding({
      automationRef: "automation:hrxn3mv2e991j2rj",
      rotateGeneration: true,
      workspace: { path: "/work/review", basename: "review" },
      toolPermissionMode: "request-approval",
    });
    const second = createAutomationBinding({
      automationRef: first.automationRef,
      previous: first,
      rotateGeneration: true,
      workspace: first.workspace,
      toolPermissionMode: first.toolPermissionMode,
    });
    await store.saveBinding(first);
    await store.updateState(first.automationRef, first.generation, (state) => ({
      ...state,
      missionId: "21ec2020-3aea-4d3d-a5f0-f60732631e15",
    }));
    await store.saveBinding(second);

    await expect(store.getState(second.automationRef, second.generation)).resolves.toMatchObject({
      generation: second.generation,
      queue: [],
      runs: [],
    });
  });

  it("fails closed on a future binding schema", async () => {
    const paths = await temporaryPaths();
    const path = paths.automationBinding("automation:hrxn3mv2e991j2rj");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: "pragma.automation-binding/v2" }));

    await expect(
      createAutomationStore(paths, "studio").getBinding("automation:hrxn3mv2e991j2rj"),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain("pragma.automation-binding/v2");
  });

  it("migrates a v1 binding and state with the owning project ID", async () => {
    const paths = await temporaryPaths();
    const projectId = "customer-project";
    const legacyRef = "automation:daily_review@1.0.0";
    const expectedRef = `automation:${derivePragmaResourceId(
      `${projectId}\0Automation\0daily_review`,
    )}`;
    const legacy = await writeLegacyAutomation(paths, legacyRef);

    const store = createAutomationStore(paths, projectId);

    await expect(store.getBinding(expectedRef)).resolves.toMatchObject({
      schemaVersion: "pragma.automation-binding/v2",
      automationRef: expectedRef,
      generation: legacy.generation,
    });
    await expect(store.getState(expectedRef, legacy.generation)).resolves.toMatchObject({
      automationRef: expectedRef,
      generation: legacy.generation,
      queue: [{ eventId: "legacy-event" }],
    });
    await expect(readFile(paths.automationBinding(legacyRef), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(paths.automationState(legacyRef), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replays a pending binding and state migration journal before cleaning legacy files", async () => {
    const paths = await temporaryPaths();
    const projectId = "studio";
    const legacyRef = "automation:daily_review@1.0.0";
    const expectedRef = `automation:${derivePragmaResourceId(
      `${projectId}\0Automation\0daily_review`,
    )}`;
    const legacy = await writeLegacyAutomation(paths, legacyRef);
    const migratedBinding = {
      ...legacy,
      schemaVersion: "pragma.automation-binding/v2",
      automationRef: expectedRef,
    };
    const migratedState = {
      ...(JSON.parse(await readFile(paths.automationState(legacyRef), "utf8")) as object),
      automationRef: expectedRef,
    };
    await mkdir(paths.storageStateRoot(), { recursive: true });
    await writeFile(
      join(paths.storageStateRoot(), "automation-binding-v1-to-v2.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.automation-binding", id: projectId },
        fromVersion: 1,
        toVersion: 2,
        documents: {
          [relative(paths.root, paths.automationBinding(expectedRef))]: migratedBinding,
          [relative(paths.root, paths.automationState(expectedRef))]: migratedState,
        },
      })}\n`,
    );

    const store = createAutomationStore(paths, projectId);

    await expect(store.getBinding(expectedRef)).resolves.toMatchObject({
      automationRef: expectedRef,
    });
    await expect(store.getState(expectedRef, legacy.generation)).resolves.toMatchObject({
      automationRef: expectedRef,
      queue: [{ eventId: "legacy-event" }],
    });
    await expect(
      readFile(join(paths.storageStateRoot(), "automation-binding-v1-to-v2.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeLegacyAutomation(paths: PragmaPaths, legacyRef: string) {
  const current = createAutomationBinding({
    automationRef: "automation:hrxn3mv2e991j2rj",
    rotateGeneration: true,
    workspace: { path: "/work/legacy", basename: "legacy" },
    toolPermissionMode: "request-approval",
  });
  const legacy = {
    ...current,
    schemaVersion: "pragma.automation-binding/v1",
    automationRef: legacyRef,
  };
  await mkdir(dirname(paths.automationBinding(legacyRef)), { recursive: true });
  await writeFile(paths.automationBinding(legacyRef), `${JSON.stringify(legacy)}\n`);
  await mkdir(dirname(paths.automationState(legacyRef)), { recursive: true });
  await writeFile(
    paths.automationState(legacyRef),
    `${JSON.stringify({
      schemaVersion: "pragma.automation-state/v1",
      automationRef: legacyRef,
      generation: legacy.generation,
      queue: [
        {
          eventId: "legacy-event",
          scheduledFor: "2026-07-23T01:00:00.000Z",
          missionId: "21ec2020-3aea-4d3d-a5f0-f60732631e15",
          createdAt: "2026-07-23T01:00:00.000Z",
        },
      ],
      runs: [],
      updatedAt: "2026-07-23T01:00:00.000Z",
    })}\n`,
  );
  return legacy;
}

async function temporaryPaths(): Promise<PragmaPaths> {
  const root = await mkdtemp(join(tmpdir(), "pragma-automation-store-"));
  temporaryRoots.push(root);
  return new PragmaPaths({ pragmaHome: root });
}
