import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PragmaExpertResourceSchema } from "@pragma/interpreter/ast";
import { User } from "@phosphor-icons/react";

import type { Capability, ContextStore } from "../../../../shared/contracts/index.ts";
import { PragmaResourcePickerDialog } from "../../components/PragmaResourcePickerDialog.tsx";
import {
  ExpertCapabilityPicker,
  matchingToolNames,
  ToolResults,
  updateToolSelection,
} from "./ExpertCapabilityPicker.tsx";
import type { ExpertRecord } from "./studio-model.ts";

const toolCapability = {
  manifest: {
    schemaVersion: "pragma.capability/v4",
    id: "codewiki",
    runtimeKey: "codewiki",
    name: "CodeWiki",
    kind: "mcp_server",
    latestRevision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  health: {
    revision: 1,
    status: "ready",
    checkedAt: "2026-07-17T00:00:00.000Z",
  },
  definition: {
    kind: "mcp_server",
    name: "CodeWiki",
    description: "Search and read repository documentation.",
    connection: {
      transport: "streamable-http",
      url: "https://example.com/mcp",
    },
    timeoutMs: 30_000,
    tools: [
      {
        name: "searchCodeWiki",
        description: "Semantic repository search",
        schemaHash: "a".repeat(64),
      },
      { name: "getCodeWikiPageContent", description: "Read a page", schemaHash: "b".repeat(64) },
      {
        name: "getCodeWikiStructure",
        description: "Browse the repository tree",
        schemaHash: "c".repeat(64),
      },
      { name: "createWorkspaceDoc", description: "Create a document", schemaHash: "d".repeat(64) },
      { name: "updateWorkspaceDoc", description: "Update a document", schemaHash: "e".repeat(64) },
    ],
  },
} satisfies Capability;

const contextStore = {
  schemaVersion: "pragma.context-store/v4",
  id: "00000000-0000-4000-8000-000000000001",
  name: "Quality handbook",
  description: "Shared review guidance.",
  type: "file",
  status: "ready",
  source: { origin: "created" },
  contentRevision: 1,
  snapshotHash: "0".repeat(64),
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
} satisfies ContextStore;

const invocableResource = PragmaExpertResourceSchema.parse({
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "Expert",
  metadata: {
    id: "0000000000000001",
    name: "Architecture reviewer",
    description: "Reviews service boundaries.",
    tags: ["architecture"],
  },
  spec: { scope: "review", instructions: "Review architecture." },
});

const builtInExpert: ExpertRecord = {
  ref: "expert:0000000000st0rev",
  id: "0000000000st0rev",
  name: "Store Revision Agent",
  avatarId: "pragma.avatar.expert.22",
  description: "Revises managed knowledge.",
  tags: ["builtin", "revision"],
  scope: "Revise knowledge.",
  instructions: "Revise knowledge.",
  additionalInstructions: "",
  origin: "built-in",
  readOnly: true,
  customized: false,
  model: null,
  capabilities: [],
  toolApprovals: {},
  skills: 0,
  tools: 0,
  mcpServers: 0,
  contextStoreMounts: [],
  resourceTools: [],
  plugins: [],
  usesApproval: false,
  icon: User,
};

describe("ExpertCapabilityPicker", () => {
  it("keeps large capability collections behind compact category summaries", () => {
    const html = renderToStaticMarkup(
      <ExpertCapabilityPicker
        currentExpertId="current"
        experts={[]}
        resources={[]}
        contextStores={[]}
        capabilities={[toolCapability]}
        resourceTools={[]}
        contextStoreMounts={[]}
        capabilityReferences={[]}
        toolApprovals={{}}
        onResourceToolsChange={() => undefined}
        onContextStoreMountsChange={() => undefined}
        onCapabilityReferencesChange={() => undefined}
        onToolApprovalsChange={() => undefined}
      />,
    );

    expect(html).toContain("Capability library");
    expect(html).toContain("Experts, teams &amp; flows");
    expect(html).toContain("5 available");
    expect(html).not.toContain("searchCodeWiki");
    expect(html).not.toContain('role="dialog"');
  });

  it("uses the shared choose copy for the knowledge-base summary", () => {
    const html = renderToStaticMarkup(
      <ExpertCapabilityPicker
        currentExpertId="current"
        experts={[]}
        resources={[]}
        contextStores={[contextStore]}
        capabilities={[]}
        resourceTools={[]}
        contextStoreMounts={[{ storeId: contextStore.id, enabled: true, priority: 0 }]}
        capabilityReferences={[]}
        toolApprovals={{}}
        onResourceToolsChange={() => undefined}
        onContextStoreMountsChange={() => undefined}
        onCapabilityReferencesChange={() => undefined}
        onToolApprovalsChange={() => undefined}
      />,
    );

    expect(html).toContain("Quality handbook");
    expect(html).not.toContain("Edit selection");
  });

  it("includes built-in experts once in the callable resource summary", () => {
    const duplicateResource = PragmaExpertResourceSchema.parse({
      ...invocableResource,
      metadata: {
        ...invocableResource.metadata,
        id: builtInExpert.id,
        name: "Stale project copy",
      },
    });
    const html = renderToStaticMarkup(
      <ExpertCapabilityPicker
        currentExpertId="current"
        experts={[builtInExpert]}
        resources={[duplicateResource]}
        contextStores={[]}
        capabilities={[]}
        resourceTools={[
          {
            adapter: "pragma.tool.call@v1",
            target: { ref: builtInExpert.ref! },
            tool: {
              name: "call_store_revision_agent",
              description: "Call Store Revision Agent.",
              approval: "ask",
            },
          },
        ]}
        contextStoreMounts={[]}
        capabilityReferences={[]}
        toolApprovals={{}}
        onResourceToolsChange={() => undefined}
        onContextStoreMountsChange={() => undefined}
        onCapabilityReferencesChange={() => undefined}
        onToolApprovalsChange={() => undefined}
      />,
    );

    expect(html).toContain("Store Revision Agent");
    expect(html).not.toContain("Stale project copy");
    expect(html).toContain("1 available");
  });

  it("searches tool names, descriptions, and their parent service", () => {
    expect(matchingToolNames(toolCapability, "semantic")).toEqual(["searchCodeWiki"]);
    expect(matchingToolNames(toolCapability, "tree")).toEqual(["getCodeWikiStructure"]);
    expect(matchingToolNames(toolCapability, "CodeWiki")).toHaveLength(5);
    expect(matchingToolNames(toolCapability, "calendar")).toEqual([]);
  });

  it("makes each selected tool a whole-row checkbox label", () => {
    const html = renderToStaticMarkup(
      <ToolResults
        capabilities={[toolCapability]}
        query="CodeWiki"
        references={[
          {
            kind: "tools",
            capabilityId: toolCapability.manifest.id,
            toolNames: ["searchCodeWiki"],
          },
        ]}
        toolApprovals={{}}
        onUpdate={() => undefined}
        onApprovalChange={() => undefined}
      />,
    );

    expect(html).toContain("expert-picker-row expert-tool-row is-selected");
    expect(html).toContain('<label class="expert-tool-row-selection">');
    expect(html).toContain('data-ui-overlay-owner="expert-capability-picker"');
  });

  it("uses the shared resource dialog for filterable multi-selection", () => {
    const html = renderToStaticMarkup(
      <PragmaResourcePickerDialog
        title="Experts, teams & flows"
        description="Choose callable resources."
        items={[
          {
            ref: `expert:${invocableResource.metadata.id}`,
            name: invocableResource.metadata.name,
            description: invocableResource.metadata.description,
            kind: "expert",
          },
        ]}
        selectedRefs={[]}
        selectionMode="multiple"
        onSelectedRefsChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Experts, teams &amp; flows");
    expect(html).toContain("expert-resource-option");
    expect(html).toContain("Architecture reviewer");
    expect(html).toContain("Reviews service boundaries.");
    expect(html).toContain("Expert");
    expect(html).not.toContain('type="checkbox"');
  });

  it("removes a single tool and its approval without restoring the old selection", () => {
    const selection = updateToolSelection({
      capability: toolCapability,
      capabilityReferences: [
        {
          kind: "tools",
          capabilityId: toolCapability.manifest.id,
          toolNames: ["searchCodeWiki", "getCodeWikiStructure"],
        },
      ],
      toolApprovals: {
        mcp_codewiki_searchCodeWiki: "ask",
        mcp_codewiki_getCodeWikiStructure: "required",
      },
      toolNames: ["getCodeWikiStructure"],
    });

    expect(selection.capabilityReferences).toEqual([
      {
        kind: "tools",
        capabilityId: toolCapability.manifest.id,
        toolNames: ["getCodeWikiStructure"],
      },
    ]);
    expect(selection.toolApprovals).toEqual({ mcp_codewiki_getCodeWikiStructure: "required" });
  });

  it("clears a complete service selection", () => {
    const selection = updateToolSelection({
      capability: toolCapability,
      capabilityReferences: [
        {
          kind: "tools",
          capabilityId: toolCapability.manifest.id,
          toolNames: toolCapability.definition.tools.map((tool) => tool.name),
        },
      ],
      toolApprovals: { mcp_codewiki_searchCodeWiki: "ask" },
      toolNames: [],
    });

    expect(selection.capabilityReferences).toEqual([]);
    expect(selection.toolApprovals).toEqual({});
  });
});
