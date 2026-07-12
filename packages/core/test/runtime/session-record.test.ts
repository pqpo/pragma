import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeSessionRecord,
  restoreRuntimeSessionRecord,
  updateRuntimeSessionRecord,
} from "../../src/runtime/session-record.ts";
import { PragmaPaths } from "../../src/storage/pragma-paths.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runtime session ownership", () => {
  it("atomically allows only one Workflow to claim a system Session id", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-session-owner-test-"));
    tempDirs.push(pragmaHome);
    const paths = new PragmaPaths({ pragmaHome });
    const create = (workflowRunId: string) =>
      createRuntimeSessionRecord({
        paths,
        owner: { workflowRunId },
        systemSessionId: "shared-system-session",
        agentId: "agent-1",
        runtime: {
          id: "runtime-1",
          kind: "runtime-kind-1",
          displayName: "Runtime 1",
        },
        workspace: "/workspace",
      });

    const results = await Promise.allSettled([create("workflow-a"), create("workflow-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("is already owned by workflow"),
      }),
    });

    const owner = JSON.parse(
      await readFile(paths.systemSessionOwner("shared-system-session"), "utf8"),
    ) as { readonly workflowRunId: string };
    expect(["workflow-a", "workflow-b"]).toContain(owner.workflowRunId);
  });

  it("rejects reusing a claimed system Session id even in the same Workflow", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-session-owner-test-"));
    tempDirs.push(pragmaHome);
    const paths = new PragmaPaths({ pragmaHome });
    const options = {
      paths,
      owner: { workflowRunId: "workflow-a" },
      systemSessionId: "system-session-a",
      agentId: "agent-1",
      runtime: {
        id: "runtime-1",
        kind: "runtime-kind-1",
        displayName: "Runtime 1",
      },
      workspace: "/workspace",
    } as const;

    await createRuntimeSessionRecord(options);
    await expect(createRuntimeSessionRecord(options)).rejects.toThrow(
      "System session system-session-a is already owned by workflow workflow-a",
    );
  });

  it("validates restore identity and records workspace transitions", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-session-owner-test-"));
    tempDirs.push(pragmaHome);
    const paths = new PragmaPaths({ pragmaHome });
    const owner = { workflowRunId: "workflow-a", taskRunId: "task-a" };
    const runtime = {
      id: "runtime-1",
      kind: "runtime-kind-1",
      displayName: "Runtime 1",
    };
    let record = await createRuntimeSessionRecord({
      paths,
      owner,
      systemSessionId: "system-session-a",
      agentId: "agent-1",
      runtime,
      workspace: "/workspace-a",
    });
    const runtimeSession = { type: runtime.kind, id: "native-session-a" };
    record = await updateRuntimeSessionRecord(paths, record, {
      runtimeSessionRef: runtimeSession,
      status: "closed",
    });

    await expect(
      restoreRuntimeSessionRecord({
        paths,
        owner,
        systemSessionId: record.systemSessionId,
        agentId: "agent-2",
        runtime,
        runtimeSession,
        workspace: "/workspace-b",
      }),
    ).rejects.toThrow("Agent mismatch while restoring runtime session");
    await expect(
      restoreRuntimeSessionRecord({
        paths,
        owner,
        systemSessionId: record.systemSessionId,
        agentId: record.agentId,
        runtime: { ...runtime, id: "runtime-2" },
        runtimeSession,
        workspace: "/workspace-b",
      }),
    ).rejects.toThrow("Runtime descriptor mismatch while restoring runtime session");
    await expect(
      restoreRuntimeSessionRecord({
        paths,
        owner,
        systemSessionId: record.systemSessionId,
        agentId: record.agentId,
        runtime,
        runtimeSession: { type: runtime.kind, id: "native-session-b" },
        workspace: "/workspace-b",
      }),
    ).rejects.toThrow("Runtime session id mismatch while restoring runtime session");
    await expect(
      restoreRuntimeSessionRecord({
        paths,
        owner: { workflowRunId: owner.workflowRunId, taskRunId: "task-b" },
        expectedTaskRunId: "task-b",
        systemSessionId: record.systemSessionId,
        agentId: record.agentId,
        runtime,
        runtimeSession,
        workspace: "/workspace-b",
      }),
    ).rejects.toThrow("Task mismatch while restoring runtime session");

    const restored = await restoreRuntimeSessionRecord({
      paths,
      owner,
      expectedTaskRunId: owner.taskRunId,
      systemSessionId: record.systemSessionId,
      agentId: record.agentId,
      runtime,
      runtimeSession,
      workspace: "/workspace-b",
    });
    expect(restored).toMatchObject({
      currentWorkspace: "/workspace-b",
      workspaceHistory: ["/workspace-a", "/workspace-b"],
      status: "active",
    });
  });

  it("fails restore when the original Runtime system Session is missing", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-session-owner-test-"));
    tempDirs.push(pragmaHome);
    const paths = new PragmaPaths({ pragmaHome });

    await expect(
      restoreRuntimeSessionRecord({
        paths,
        owner: { workflowRunId: "workflow-missing", taskRunId: "task-missing" },
        expectedTaskRunId: "task-missing",
        systemSessionId: "system-session-missing",
        agentId: "agent-1",
        runtime: {
          id: "runtime-1",
          kind: "runtime-kind-1",
          displayName: "Runtime 1",
        },
        runtimeSession: { type: "runtime-kind-1", id: "native-session-missing" },
        workspace: "/workspace",
      }),
    ).rejects.toThrow(
      "Runtime system session was not found: system-session-missing in workflow workflow-missing",
    );
  });
});
