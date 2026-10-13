import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPragmaLogger, defineExpert, registerExpertToolsMcpSession } from "@pragma/core";
import {
  BUILT_IN_PRAGMA_REF,
  STORE_REVISION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  builtInAgentResource,
  compileBuiltInAgent,
} from "@pragma/built-in-agents";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilitySchema } from "../../../shared/contracts/index.ts";
import {
  clearCapabilityToolSelection,
  updateResourceToolSelection,
} from "../../../shared/expert-tool-selection.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["ask", "required", "migrated"] as const)(
  "keeps %s delegation approvals after clearing Tools, saving and reopening",
  async (scenario) => {
    const mode = scenario === "required" ? "required" : "ask";
    const root = await mkdtemp(join(tmpdir(), "pragma-delegation-approval-"));
    roots.push(root);
    const configPath = join(root, "system-experts.json");
    if (scenario === "migrated") {
      await copyFile(new URL("./__fixtures__/system-experts-v8.json", import.meta.url), configPath);
    }
    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();
    const original = registry.get(BUILT_IN_PRAGMA_REF)!;
    const selected =
      scenario === "migrated"
        ? { resourceTools: original.resourceTools, toolApprovals: original.toolApprovals }
        : updateResourceToolSelection(
            [],
            [STORE_REVISION_EXPERT_REF],
            [{ ref: STORE_REVISION_EXPERT_REF, name: "Store Revision Agent", kind: "expert" }],
            mode === "required" ? { spawn_expert: mode, continue_expert: mode } : {},
          );
    expect(selected.resourceTools).toEqual([
      expect.objectContaining({ adapter: "pragma.tool.delegate@v1" }),
    ]);
    const capability = CapabilitySchema.parse({
      manifest: {
        schemaVersion: "pragma.capability/v4",
        id: "11111111-1111-4111-8111-111111111111",
        runtimeKey: "docs",
        name: "Docs",
        kind: "mcp_server",
        latestRevision: 1,
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      },
      definition: {
        kind: "mcp_server",
        name: "Docs",
        description: "Search documentation.",
        connection: { transport: "streamable-http", url: "https://example.com/mcp" },
        timeoutMs: 30000,
        tools: [{ name: "search_docs", description: "Search", schemaHash: "a".repeat(64) }],
      },
      health: { revision: 1, status: "ready", checkedAt: "2026-10-13T00:00:00.000Z" },
    });
    const cleared = clearCapabilityToolSelection({
      capabilityReferences: [
        { kind: "tools", capabilityId: capability.manifest.id, toolNames: ["search_docs"] },
      ],
      toolApprovals: {
        ...selected.toolApprovals,
        mcp_docs_search_docs: "required",
        edit_expert_context: "required",
      },
      capabilities: [capability],
    });
    expect(cleared).toEqual({
      capabilityReferences: [],
      toolApprovals: { spawn_expert: mode, continue_expert: mode, edit_expert_context: "required" },
    });
    await registry.update(BUILT_IN_PRAGMA_REF, {
      name: original.name,
      description: original.description,
      tags: original.tags,
      additionalInstructions: "",
      capabilities: cleared.capabilityReferences,
      toolApprovals: cleared.toolApprovals,
      plugins: [],
      contextStoreMounts: [],
      resourceTools: selected.resourceTools,
    });
    const reopened = createDesktopSystemExpertRegistry({ configPath });
    await reopened.initialize();
    const compiled = await compileBuiltInAgent({
      ref: BUILT_IN_PRAGMA_REF,
      expertResource: reopened.getResource(BUILT_IN_PRAGMA_REF),
      environmentId: "approval-test",
      definitionStateRoot: join(root, "definitions"),
      workspace: root,
      pragmaHome: root,
      adapterHost: {
        environmentId: "approval-test",
        projectRoot: root,
        resolveBinding: async (ref) =>
          ref === "binding:pragma.management"
            ? {
                ref,
                revision: "1",
                fingerprint: "a".repeat(64),
                value: { contribution: { tools: [] } },
              }
            : undefined,
        resolveSecret: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("Unexpected artifact");
        },
      },
      resolveExternalInvocable: async (ref) => {
        if (ref !== STORE_REVISION_EXPERT_REF && ref !== SKILL_REVISION_EXPERT_REF)
          throw new Error(`Unexpected delegate ${ref}`);
        const resource = builtInAgentResource(ref);
        return {
          resource,
          value: await defineExpert({
            id: ref.slice("expert:".length),
            name: resource.metadata.name,
            description: "Revision",
            tags: [],
            scope: "Revision",
            workspace: root,
          }),
        };
      },
    });
    let approved = false;
    const approvalRequests: string[] = [];
    const spawnExpert = vi.fn(async () => ({
      contextId: "revision-context",
      invocationId: "first",
      status: "queued",
    }));
    const continueExpert = vi.fn(async () => ({
      contextId: "revision-context",
      invocationId: "next",
      status: "queued",
    }));
    const registration = await registerExpertToolsMcpSession({
      agent: compiled.value,
      getContext: () => undefined,
      state: {},
      logger: createPragmaLogger(undefined, { component: "approval-test" }),
      executionContext: {
        executionId: "execution",
        invocationId: "caller",
        depth: 0,
        spawnExpert,
        continueExpert,
      },
      humanInteractionHandler: async (request) => {
        if (request.kind !== "tool_approval") throw new Error("Unexpected interaction");
        approvalRequests.push(request.toolName);
        return { kind: "tool_approval", approved, updatedInput: request.input };
      },
    });
    const client = new Client(
      { name: "persisted-delegation-approval", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(registration.url)));
      for (const [name, args, execute] of [
        ["spawn_expert", { expertId: "0000000000st0rev", task: "Revise" }, spawnExpert],
        [
          "continue_expert",
          { contextId: "revision-context", task: "Apply feedback" },
          continueExpert,
        ],
      ] as const) {
        expect(compiled.value.tools?.find((tool) => tool.name === name)?.approval).toEqual({
          mode,
        });
        approved = false;
        expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true });
        expect(execute).not.toHaveBeenCalled();
        approved = true;
        expect(await client.callTool({ name, arguments: args })).not.toMatchObject({
          isError: true,
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(approvalRequests.filter((tool) => tool === name)).toHaveLength(2);
      }
    } finally {
      await client.close();
      await registration.dispose();
    }
  },
);
