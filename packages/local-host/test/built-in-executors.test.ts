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
  it("compiles default Pragma with its built-in dependencies and invokes a resource-call tool", async () => {
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
    const tool = resolved.definition.tools?.find(
      (candidate) => candidate.name === "call_store_revision_agent",
    );
    if (tool === undefined) throw new Error("Store Revision resource-call tool is missing.");
    const invokeResource = vi.fn(async ({ target }: { readonly target: unknown }) => {
      expect(target).toMatchObject({ id: STORE_REVISION_EXPERT_ID });
      return { status: "called" };
    });

    await expect(
      tool.call({ prompt: "Revise the managed store." }, undefined, {
        execution: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          depth: 0,
          invokeResource,
        },
      }),
    ).resolves.toMatchObject<ExpertAgentToolCallResult>({
      text: expect.stringContaining('"status": "called"'),
    });
    expect(invokeResource).toHaveBeenCalledOnce();
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
        return { text: "Not exercised by this compilation test." };
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
