import { PRAGMA_DSL_WRITE_API_VERSION, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { describe, expect, it, vi } from "vitest";

import type { PragmaProjectSnapshot } from "../../../shared/contracts/index.ts";
import { MissionSchema } from "../../../shared/contracts/index.ts";
import {
  createDesktopLocalHostExecutorResolver,
  executorDescriptorFromMissionOption,
  toLocalHostRunRequest,
} from "./local-host-mission-adapter.ts";

const workspace = {
  schemaVersion: "pragma.integration-workspace/v1" as const,
  requestedPath: "/tmp/pragma-m9-workspace",
  canonicalPath: "/tmp/pragma-m9-workspace",
  displayName: "pragma-m9-workspace",
  identityHash: `sha256:${"a".repeat(64)}`,
  access: { exists: true, readable: true, writable: true },
  source: "explicit" as const,
};

function mission(input: {
  readonly kind: "expert" | "flow";
  readonly ref: string;
  readonly flowInput?: Record<string, unknown>;
}) {
  return MissionSchema.parse({
    schemaVersion: "pragma.mission/v10",
    id: "00000000-0000-4000-8000-000000000901",
    title: "M9 adapter test",
    goal: "Run through the Local Host port.",
    initialMessageId: "00000000-0000-4000-8000-000000000902",
    workspace: { path: workspace.canonicalPath, basename: workspace.displayName },
    project: { id: "studio", revision: 7 },
    executor: {
      kind: input.kind,
      ref: input.ref,
      name: input.kind === "flow" ? "Test Flow" : "Test Expert",
      version: "1",
    },
    ...(input.flowInput === undefined ? {} : { flowInput: input.flowInput }),
    origin: { type: "user" },
    contextMounts: [],
    lifecycleStatus: "active",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
}

describe("Desktop Local Host Mission adapter", () => {
  it("keeps Desktop Mission identity out of the generic run request", () => {
    const request = toLocalHostRunRequest({
      mission: mission({ kind: "expert", ref: "expert:0000000000000000" }),
      workspace,
      executorSource: "project",
    });

    expect(request).toEqual({
      requestId: "00000000-0000-4000-8000-000000000902",
      command: "expert.run",
      executor: { kind: "expert", id: "0000000000000000" },
      workspace,
      detach: true,
      project: { projectId: "studio", revision: 7 },
      prompt: "Run through the Local Host port.",
    });
    expect("missionId" in request).toBe(false);
  });

  it("maps Flow input without turning product fields into Host DTO fields", () => {
    const request = toLocalHostRunRequest({
      mission: mission({
        kind: "flow",
        ref: "flow:0000000000000001",
        flowInput: { answer: "yes" },
      }),
      workspace,
      executorSource: "project",
    });

    expect(request).toMatchObject({
      command: "flow.run",
      executor: { kind: "flow", id: "0000000000000001" },
      input: { answer: "yes" },
    });
    expect("title" in request).toBe(false);
    expect("modelOverride" in request).toBe(false);
  });

  it("creates a pinned-safe built-in descriptor from the Desktop catalog", () => {
    const descriptor = executorDescriptorFromMissionOption({
      kind: "expert",
      ref: "expert:0000000000000000",
      name: "Built-in Expert",
      description: "Test built-in executor",
      origin: "built-in",
      avatarId: "default",
      readOnly: true,
      customized: false,
    });

    expect(descriptor).toMatchObject({
      source: "built_in",
      ref: { kind: "expert", id: "0000000000000000" },
      availability: { status: "ready" },
    });
    expect(descriptor.project).toBeUndefined();
  });

  it("resolves a project executor from the requested exact revision only", async () => {
    const revision = 7;
    const snapshot = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "studio",
      revision,
      resources: [expertFixture()],
      diagnostics: [],
      projectFingerprint: "b".repeat(64),
    } satisfies PragmaProjectSnapshot;
    const getRevision = vi.fn(async (requestedRevision: number) => {
      expect(requestedRevision).toBe(revision);
      return snapshot;
    });
    const getHead = vi.fn(async () => {
      throw new Error("project head must not be read for an attached run");
    });
    const resolver = createDesktopLocalHostExecutorResolver({
      executors: { list: async () => [] } as never,
      project: {
        projectId: "studio",
        getRevision,
        get: getHead,
      } as never,
    });

    const resolved = await resolver({
      ref: { kind: "expert", id: "1xddvess309a6gme" },
      projectId: "studio",
      revision,
      workspace,
    });

    expect(getRevision).toHaveBeenCalledWith(revision);
    expect(getHead).not.toHaveBeenCalled();
    expect(resolved?.descriptor).toMatchObject({
      source: "project",
      project: { projectId: "studio", revision, fingerprint: "b".repeat(64) },
    });
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      avatarId: "pragma.avatar.expert.default",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
