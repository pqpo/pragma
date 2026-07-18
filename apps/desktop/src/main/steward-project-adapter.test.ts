import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { createDesktopStewardProjectPort } from "./steward-project-adapter.ts";

describe("Desktop Steward DSL project adapter", () => {
  it("creates and updates the same exact ref through immutable project revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-project-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopStewardProjectPort({ project, stateRoot: join(root, "state") });
    const first = await adapter.prepare({ expectedProjectRevision: 0, sources: [expert("First")] });
    expect(first.diagnostics).toEqual([]);
    expect(first.changes).toMatchObject([{ ref: "expert:writer@1.0.0", kind: "created" }]);
    await expect(
      adapter.commit({ changeSetId: first.changeSetId, operationId: "first" }),
    ).resolves.toMatchObject({ projectRevision: 1 });

    const second = await adapter.prepare({
      expectedProjectRevision: 1,
      sources: [expert("Second")],
    });
    expect(second.changes).toMatchObject([{ ref: "expert:writer@1.0.0", kind: "updated" }]);
    const committed = await adapter.commit({
      changeSetId: second.changeSetId,
      operationId: "second",
    });
    expect(committed.projectRevision).toBe(2);
    expect((await adapter.read("expert:writer@1.0.0")).source).toContain("Second");
  });

  it("replays a committed operation idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-idempotent-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopStewardProjectPort({ project, stateRoot: join(root, "state") });
    const candidate = await adapter.prepare({
      expectedProjectRevision: 0,
      sources: [expert("One")],
    });
    const first = await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "same" });
    const second = await adapter.commit({
      changeSetId: candidate.changeSetId,
      operationId: "same",
    });
    expect(second).toEqual(first);
    expect((await project.get()).revision).toBe(1);
  });
});

function expert(description: string): string {
  return [
    "apiVersion: pragma/v2",
    "kind: Expert",
    "metadata:",
    "  id: writer",
    "  version: 1.0.0",
    "  name: Writer",
    `  description: ${description}`,
    "  tags: []",
    "spec:",
    "  scope: Write.",
    "  capabilities: []",
    "  toolApprovals: {}",
    "  contextStores: []",
    "  plugins: []",
    "  tools: []",
    "",
  ].join("\n");
}
