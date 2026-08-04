import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileExecutionStore } from "../src/execution/execution-store.ts";
import {
  HandoffService,
  unwrapInvocationHandoff,
} from "../src/execution/handoff/handoff-service.ts";
import { withExecutionRunScope } from "../src/runtime/run-context.ts";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";

describe("Execution handoff", () => {
  it("keeps small output inline and externalizes large output through Context System", async () => {
    const fixture = await createFixture();
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");

    const inline = await service.normalize("root", "small");
    expect(inline).toEqual({ type: "inline", value: "small" });

    const largeText = "large handoff\n".repeat(4_000);
    const handoff = await service.normalize("root", largeText);
    expect(handoff).toMatchObject({
      type: "context",
      contexts: [{ namespace: "pragma.handoff", mediaType: "text/plain" }],
    });
    if (handoff.type !== "context") throw new Error("Expected a Context handoff.");

    const reference = handoff.contexts[0]!;
    const stored = await service.store.readContext({ id: reference.id, start: 0, offset: 64 });
    expect(stored).toMatchObject({
      ok: true,
      value: {
        contentRange: { truncated: true },
      },
    });
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.content).toBe(largeText.slice(0, stored.value.content.length));

    const search = await service.store.searchContext({
      query: "large handoff",
      maxResults: 2,
    });
    expect(search).toMatchObject({ ok: true });
    if (!search.ok) throw new Error(search.error.message);
    expect(search.value).toHaveLength(2);

    const outputPath = join(
      new PragmaPaths({ pragmaHome: fixture.home }).executionHandoffsRoot("execution"),
      "generated",
      reference.id,
    );
    await expect(readFile(outputPath, "utf8")).resolves.toBe(largeText);
    expect(unwrapInvocationHandoff(handoff)).toEqual(handoff);
  });

  it("federates handoffs from every visible Execution", async () => {
    const fixture = await createFixture();
    const previousService = new HandoffService({
      executionId: "previous-execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await previousService.beginInvocationAttempt("child", "attempt-1");
    const output = "previous handoff\n".repeat(4_000);
    const handoff = await previousService.normalize("child", output);
    if (handoff.type !== "context") throw new Error("Expected a Context handoff.");

    const currentService = new HandoffService({
      executionId: "current-execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
      resolveVisibleExecutionIds: () => ["previous-execution", "current-execution"],
    });
    const context = withExecutionRunScope(undefined, { executionId: "current-execution" });

    const read = await currentService.contextStore.readContext({
      id: handoff.contexts[0]!.id,
      context,
    });
    const list = await currentService.contextStore.listContext({ context });
    const search = await currentService.contextStore.searchContext({
      query: "previous handoff",
      context,
    });

    expect(read).toMatchObject({ ok: true, value: { content: output } });
    expect(list).toMatchObject({ ok: true, value: [{ id: handoff.contexts[0]!.id }] });
    expect(search).toMatchObject({ ok: true });
    if (!search.ok) throw new Error(search.error.message);
    expect(search.value.some((match) => match.id === handoff.contexts[0]!.id)).toBe(true);

    const isolatedService = new HandoffService({
      executionId: "isolated-execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
      resolveVisibleExecutionIds: () => ["isolated-execution"],
    });
    await expect(
      isolatedService.contextStore.readContext({ id: handoff.contexts[0]!.id }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "context_not_found" },
    });
  });

  it("fails closed when visible Executions contain the same context id", async () => {
    const fixture = await createFixture();
    const services = ["execution-a", "execution-b"].map(
      (executionId) =>
        new HandoffService({
          executionId,
          executions: fixture.executions,
          pragmaHome: fixture.home,
        }),
    );
    for (const service of services) {
      await service.beginInvocationAttempt("shared-invocation", "attempt-1");
      await service.normalize("shared-invocation", "duplicate\n".repeat(5_000));
    }
    const reader = new HandoffService({
      executionId: "current-execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
      resolveVisibleExecutionIds: () => ["execution-a", "execution-b"],
    });
    const id = "invocations/c2hhcmVkLWludm9jYXRpb24/output.txt";

    await expect(reader.contextStore.listContext()).resolves.toMatchObject({
      ok: false,
      error: { code: "context_conflict" },
    });
    await expect(reader.contextStore.readContext({ id })).resolves.toMatchObject({
      ok: false,
      error: { code: "context_conflict" },
    });
    await expect(reader.contextStore.searchContext({ query: "duplicate" })).resolves.toMatchObject({
      ok: false,
      error: { code: "context_conflict" },
    });
  });

  it("registers a workspace file without copying it and exposes revision changes", async () => {
    const fixture = await createFixture();
    const workspace = await mkdtemp(join(tmpdir(), "pragma-handoff-workspace-"));
    await writeFile(join(workspace, "report.md"), "# First\n", "utf8");
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");

    const first = await service.registerWorkspaceFile({
      invocationId: "root",
      toolCallId: "tool-1",
      workspaceRoot: workspace,
      path: "report.md",
      description: "Review report",
    });
    const handoff = await service.normalize("root", "Report completed.");
    expect(handoff).toMatchObject({
      type: "context",
      summary: "Report completed.",
      contexts: [{ id: first.id, mediaType: "text/markdown" }],
    });

    await writeFile(join(workspace, "report.md"), "# Second\n", "utf8");
    const read = await service.store.readContext({ id: first.id });
    expect(read).toMatchObject({ ok: true, value: { content: "# Second\n" } });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.revision).not.toBe(first.revision);

    const generatedRoot = new PragmaPaths({
      pragmaHome: fixture.home,
    }).executionGeneratedHandoffsRoot("execution");
    await expect(readFile(join(generatedRoot, first.id), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects workspace path traversal", async () => {
    const fixture = await createFixture();
    const workspace = await mkdtemp(join(tmpdir(), "pragma-handoff-workspace-"));
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");

    await expect(
      service.registerWorkspaceFile({
        invocationId: "root",
        toolCallId: "tool-1",
        workspaceRoot: workspace,
        path: "../outside.md",
      }),
    ).rejects.toThrow("escapes its authorized root");
  });

  it("drops incomplete-attempt handoffs before normalizing a retry", async () => {
    const fixture = await createFixture();
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");
    const first = await service.normalize("root", "large\n".repeat(8_000));
    expect(first.type).toBe("context");
    if (first.type !== "context") throw new Error("Expected a Context handoff.");
    const staleReference = first.contexts[0]!;

    await service.beginInvocationAttempt("root", "attempt-2");
    await expect(service.normalize("root", "retry result")).resolves.toEqual({
      type: "inline",
      value: "retry result",
    });
    await expect(service.store.listReferencesForInvocation("root", "attempt-2")).resolves.toEqual(
      [],
    );
    await expect(service.store.readContext({ id: staleReference.id })).resolves.toMatchObject({
      ok: false,
      error: { code: "context_not_found" },
    });
  });

  it("rejects an idempotent retry that changes the registered workspace source", async () => {
    const fixture = await createFixture();
    const workspace = await mkdtemp(join(tmpdir(), "pragma-handoff-workspace-"));
    await mkdir(join(workspace, "first"));
    await mkdir(join(workspace, "second"));
    await writeFile(join(workspace, "first", "report.md"), "first", "utf8");
    await writeFile(join(workspace, "second", "report.md"), "second", "utf8");
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");

    await service.registerWorkspaceFile({
      invocationId: "root",
      toolCallId: "tool-1",
      workspaceRoot: workspace,
      path: "first/report.md",
    });
    await expect(
      service.registerWorkspaceFile({
        invocationId: "root",
        toolCallId: "tool-1",
        workspaceRoot: workspace,
        path: "second/report.md",
      }),
    ).rejects.toThrow("idempotency conflict");
  });

  it("rejects a workspace reference after the registered root is replaced by a symlink", async () => {
    const fixture = await createFixture();
    const workspace = await mkdtemp(join(tmpdir(), "pragma-handoff-workspace-"));
    const moved = `${workspace}-moved`;
    await writeFile(join(workspace, "report.md"), "content", "utf8");
    const service = new HandoffService({
      executionId: "execution",
      executions: fixture.executions,
      pragmaHome: fixture.home,
    });
    await service.beginInvocationAttempt("root", "attempt-1");
    const reference = await service.registerWorkspaceFile({
      invocationId: "root",
      toolCallId: "tool-1",
      workspaceRoot: workspace,
      path: "report.md",
    });

    await rename(workspace, moved);
    await symlink(moved, workspace, "dir");

    await expect(service.store.readContext({ id: reference.id })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "store_error",
        details: { message: "Handoff workspace root identity changed after registration." },
      },
    });
  });
});

async function createFixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-handoff-"));
  const executions = createFileExecutionStore({ pragmaHome: home });
  const now = new Date().toISOString();
  await executions.create(
    {
      schemaVersion: "pragma.execution/v8",
      executionId: "execution",
      version: 0,
      kind: "expert-turn",
      definition: { id: "expert", kind: "expert" },
      rootInvocationId: "root",
      status: "running",
      input: "input",
      state: {},
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      invocationId: "root",
      rootInvocationId: "root",
      definition: { id: "expert", kind: "expert" },
      contextId: "root-context",
      status: "running",
      input: "input",
      createdAt: now,
      updatedAt: now,
    },
  );
  return { home, executions };
}
