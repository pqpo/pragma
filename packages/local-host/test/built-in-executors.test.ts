import { createTextToolResult } from "@pragma/core";
import { getToolResultText } from "@pragma/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStaticRuntimeResolver,
  snapshotRuntimeFeatures,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import {
  BUILT_IN_PRAGMA_ID,
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
  STORE_REVISION_EXPERT_ID,
} from "@pragma/built-in-agents";
import type { PragmaAdapterHost } from "@pragma/interpreter";
import type { WorkspaceSelection } from "@pragma/shared/integration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostBuiltInExecutorResolver } from "../src/built-in-executors.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Local Host built-in executors", () => {
  it("compiles default Pragma with its built-in dependencies and invokes shared delegation tools", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-host-built-in-"));
    temporaryRoots.push(home);
    const resolver = createLocalHostBuiltInExecutorResolver({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        defaultRuntimeId: "test-runtime",
        runtimes: [
          {
            features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
            descriptor: { id: "test-runtime", kind: "test", displayName: "Test Runtime" },
            canUse: () => ({ usable: true }),
          },
        ],
      }),
      adapterHost: managementAdapterHost(home),
    });

    const resolved = await resolver({
      ref: { kind: "expert", id: BUILT_IN_PRAGMA_ID },
      workspace: workspace(home),
    });
    expect(resolved?.definition).toMatchObject({ id: BUILT_IN_PRAGMA_ID });
    if (resolved === undefined || "kind" in resolved.definition) {
      throw new Error("Expected the built-in Pragma Expert definition.");
    }
    const tool = resolved.definition.tools?.find((candidate) => candidate.name === "spawn_expert");
    if (tool === undefined) throw new Error("Expert lifecycle tool is missing.");
    const spawnExpert = vi.fn(
      async (input: { readonly expertId: string; readonly task: string }) => {
        expect(input).toEqual({
          expertId: STORE_REVISION_EXPERT_ID,
          task: "Revise the managed store.",
        });
        return {
          contextId: "revision-context",
          invocationId: "revision-invocation",
          status: "queued",
        };
      },
    );

    const result = await tool.call(
      { expertId: STORE_REVISION_EXPERT_ID, task: "Revise the managed store." },
      undefined,
      {
        execution: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          depth: 0,
          spawnExpert,
        },
      },
    );
    expect(result.isError, getToolResultText(result)).not.toBe(true);
    expect(result.details).toEqual(JSON.parse(getToolResultText(result)));
    expect(JSON.parse(getToolResultText(result))).toMatchObject({
      contextId: "revision-context",
      invocationId: "revision-invocation",
      status: "queued",
      message: expect.stringContaining("not a completion result"),
    });
    expect(spawnExpert).toHaveBeenCalledOnce();
    expect(tool.approval).toEqual({ mode: "none" });
    const continuation = resolved.definition.tools?.find(
      (candidate) => candidate.name === "continue_expert",
    );
    expect(continuation?.approval).toEqual({ mode: "none" });
  });
});

function managementAdapterHost(root: string): PragmaAdapterHost {
  const tools = PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(
    ({ name, description, inputSchema, approval }) => ({
      name,
      description,
      inputSchema,
      approval,
      async call(): Promise<ExpertAgentToolCallResult> {
        return createTextToolResult("Not exercised by this compilation test.");
      },
    }),
  );
  return {
    environmentId: "test-host",
    projectRoot: root,
    async resolveBinding(ref) {
      return ref === PRAGMA_MANAGEMENT_BINDING_REF
        ? {
            ref,
            revision: "1",
            fingerprint: "a".repeat(64),
            value: { contribution: { tools } },
          }
        : undefined;
    },
    async resolveArtifact(source) {
      throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function workspace(root: string): WorkspaceSelection {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: root,
    canonicalPath: root,
    displayName: "fixture",
    identityHash: `sha256:${"d".repeat(64)}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  };
}
