import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PragmaPaths } from "@pragma/core";
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
    const store = createAutomationStore(paths);
    const binding = createAutomationBinding({
      automationRef: "automation:daily_review@1.0.0",
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
    const store = createAutomationStore(paths);
    const first = createAutomationBinding({
      automationRef: "automation:daily_review@1.0.0",
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
    const path = paths.automationBinding("automation:daily_review@1.0.0");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: "pragma.automation-binding/v2" }));

    await expect(
      createAutomationStore(paths).getBinding("automation:daily_review@1.0.0"),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain("pragma.automation-binding/v2");
  });
});

async function temporaryPaths(): Promise<PragmaPaths> {
  const root = await mkdtemp(join(tmpdir(), "pragma-automation-store-"));
  temporaryRoots.push(root);
  return new PragmaPaths({ pragmaHome: root });
}
