import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { User } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PragmaExpertResourceSchema } from "@pragma/interpreter/ast";

import type {
  Capability,
  ContextStore,
  DesktopPlugin,
  DesktopRuntimeAvailability,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { ExpertDetailFragment, ExpertDirectoryFragment } from "./ExpertDirectoryFragment.tsx";
import { ExpertEditorFragment } from "./ExpertEditorFragment.tsx";
import type { ExpertRecord } from "./studio-model.ts";

const expert: ExpertRecord = {
  id: "test_expert",
  avatarId: "pragma.avatar.expert.default",
  name: "Test Expert",
  description: "d".repeat(240),
  tags: ["test"],
  scope: "Handles focused test work.",
  instructions: "i".repeat(500),
  additionalInstructions: "",
  origin: "project",
  readOnly: false,
  customized: false,
  model: { runtimeId: "test", providerId: "test", modelId: "test" },
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

const contextStore: ContextStore = {
  schemaVersion: "pragma.context-store/v4",
  contentRevision: 1,
  snapshotHash: "0".repeat(64),
  id: "00000000-0000-4000-8000-000000000001",
  name: "Product Docs",
  description: "Context store details should not be shown here.",
  type: "file",
  status: "ready",
  source: { origin: "created" },
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const skillCapability: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v2",
    id: "00000000-0000-4000-8000-000000000002",
    runtimeKey: "writing_skill",
    name: "Writing Skill",
    kind: "skill",
    latestRevision: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
  health: {
    revision: 1,
    status: "ready",
    checkedAt: "2026-07-27T00:00:00.000Z",
  },
  definition: {
    kind: "skill",
    name: "Writing Skill",
    description: "Skill instructions should not be shown here.",
    entryPath: "SKILL.md",
    contentHash: "a".repeat(64),
  },
};

const toolCapability: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v2",
    id: "00000000-0000-4000-8000-000000000003",
    runtimeKey: "research_tools",
    name: "Tools Service",
    kind: "mcp_server",
    latestRevision: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
  health: {
    revision: 1,
    status: "ready",
    checkedAt: "2026-07-27T00:00:00.000Z",
  },
  definition: {
    kind: "mcp_server",
    name: "Tools Service",
    description: "Tool service details should not be shown here.",
    connection: { transport: "streamable-http", url: "https://example.test/mcp" },
    timeoutMs: 30_000,
    tools: [
      { name: "search_docs", description: "Search documents", schemaHash: "b".repeat(64) },
      { name: "save_note", description: "Save a note", schemaHash: "c".repeat(64) },
    ],
  },
};

const plugin: DesktopPlugin = {
  ref: "plugin:research@1.0.0",
  origin: "user",
  manifest: {
    schemaVersion: "pragma.plugin/v2",
    id: "research",
    name: "Research Plugin",
    description: "Plugin details should not be shown here.",
    version: "1.0.0",
    tags: [],
    runtime: { type: "expert-agent-plugin", entry: "./index.js", trust: "trusted-host" },
    capabilities: [],
    configuration: {},
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  },
  contentHash: "d".repeat(64),
  status: "ready",
  defaultConfig: {},
  configuredSecrets: [],
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const resources = [
  PragmaExpertResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1h2j3k4m5n6p7q8r",
      name: "Research Expert",
      description: "Resource description one.",
      tags: [],
    },
    spec: { scope: "Research", instructions: "Research." },
  }),
  PragmaExpertResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "2h3j4k5m6n7p8q9r",
      name: "Release Expert",
      description: "Resource description two.",
      tags: [],
    },
    spec: { scope: "Release", instructions: "Release." },
  }),
];

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ExpertDetailFragment", () => {
  it("shows the configured thinking depth in the runtime summary", () => {
    const runtime: DesktopRuntimeAvailability = {
      id: "test",
      isDefault: true,
      kind: "test-runtime",
      displayName: "Test Runtime",
      status: "available",
      models: [
        {
          id: "test",
          displayName: "Test Model",
          provider: { kind: "runtime-managed", id: "test", displayName: "Test Provider" },
          thinking: {
            supportedLevels: [{ value: "high", label: "High" }],
            defaultLevel: "high",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{ ...expert, model: { ...expert.model!, thinkingLevel: "high" } }}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        runtimes={[runtime]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("Thinking depth");
    expect(html).toContain(">High</strong>");
  });

  it("renders selected capability titles as plain comma-separated text", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          contextStoreMounts: [{ storeId: contextStore.id, enabled: true, priority: 0 }],
          capabilities: [
            { kind: "skill", capabilityId: skillCapability.manifest.id, revision: 1 },
            {
              kind: "tools",
              capabilityId: toolCapability.manifest.id,
              revision: 1,
              toolNames: ["search_docs", "save_note"],
            },
          ],
          resourceTools: [
            { adapter: "pragma.tool.call@v1", target: { ref: "expert:1h2j3k4m5n6p7q8r" } },
            { adapter: "pragma.tool.call@v1", target: { ref: "expert:2h3j4k5m6n7p8q9r" } },
          ],
          plugins: [{ ref: plugin.ref }],
        }}
        contextStores={[contextStore]}
        capabilities={[skillCapability, toolCapability]}
        plugins={[plugin]}
        resources={resources}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("Research Expert、Release Expert");
    expect(html).toContain("Product Docs");
    expect(html).toContain("Writing Skill");
    expect(html).toContain("search_docs、save_note");
    expect(html).toContain("Research Plugin");
    expect(html.match(/expert-capability-detail-selection-text/g)).toHaveLength(4);
    expect(html).not.toContain("Context store details should not be shown here.");
    expect(html).not.toContain("Skill instructions should not be shown here.");
    expect(html).not.toContain("Tool service details should not be shown here.");
    expect(html).not.toContain("Context stores");
    expect(html).not.toContain("As tools");
    expect(html).not.toContain("Callable expert resources");
    expect(html).not.toContain("Guidance");
    expect(html).not.toContain("Enabled instructions");
    expect(html).not.toContain("Actions");
    expect(html).not.toContain("Enabled tools");
    expect(html).not.toContain("expert-capability-detail-list");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<li>");
  });

  it("uses compact metadata and renders full Markdown instructions last", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          instructions: "## Workflow\n\n- Inspect the input\n- **Verify** the result",
        }}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).not.toContain("ID: test_expert");
    expect(html).toContain("Scope");
    expect(html).not.toContain(
      "Let this expert call other Pragma resources when a task needs them.",
    );
    expect(html).not.toContain("Callable expert resources");
    expect(html).not.toContain("Availability");
    expect(html).not.toContain("d".repeat(201));
    expect(html).toContain('<div class="expert-instructions-markdown markdown-preview">');
    expect(html).toContain("<h2>Workflow</h2>");
    expect(html).toContain("<li>Inspect the input</li>");
    expect(html).toContain("<strong>Verify</strong>");
    expect(html.indexOf('id="expert-scope-heading"')).toBeLessThan(
      html.indexOf('id="expert-capabilities-heading"'),
    );
    expect(html.indexOf('id="expert-capabilities-heading"')).toBeLessThan(
      html.indexOf('id="expert-context-heading"'),
    );
    expect(html.indexOf('id="expert-context-heading"')).toBeLessThan(
      html.indexOf('id="expert-instructions-heading"'),
    );
    expect(html).toContain('<h2 id="expert-context-heading">Knowledge base</h2>');
    expect(html).toMatch(/studio-screen-header.*Back to Experts.*studio-screen-body.*Test Expert/s);
    expect(html).toContain("Delete expert");
    expect(html).not.toContain("Create new version");
  });

  it("offers edit and reset, but not deletion, for a built-in expert", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          origin: "built-in",
          readOnly: true,
          customized: true,
          model: null,
        }}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).not.toContain("Delete expert");
    expect(html).toContain("Customize");
    expect(html).not.toContain("Use as template");
    expect(html).toContain("Reset to default");
    expect(html).not.toContain("Configure knowledge");
    expect(html).toContain("Try in session");
  });

  it("renders localized metadata for the uncustomized built-in Pragma expert", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          ref: "expert:0000000000pragma",
          id: "0000000000pragma",
          name: "Pragma",
          description: "Canonical description",
          scope: "Canonical scope",
          origin: "built-in",
          readOnly: true,
          customized: false,
          model: null,
        }}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("内置通用 Agent，可直接处理日常工作并协调专业专家。");
    expect(html).toContain("使用当前 Runtime、授权工作区和可用能力完成你的工作。");
    expect(html).not.toContain("Canonical description");
    expect(html).not.toContain("Canonical scope");
  });
});

describe("ExpertDirectoryFragment", () => {
  it("uses a single search control without the inactive expert dropdown", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[expert]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="Search experts"');
    expect(html).not.toContain("All experts");
    expect(html).not.toContain("directory-filter");
    expect(html).toContain('data-avatar-profile="pragma.avatar.expert.11"');
    expect(html).not.toContain("expert-card-metrics");
    expect(html).not.toContain("Model");
    expect(html).not.toContain('class="expert-source-chip"');
    expect(html.indexOf('class="expert-card-scope"')).toBeLessThan(
      html.indexOf('class="expert-card-tags"'),
    );
  });

  it("keeps the built-in chip only for built-in experts", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[{ ...expert, origin: "built-in", readOnly: true, model: null }]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('class="expert-source-chip"');
    expect(html).toContain("Built-in");
  });

  it("keeps the built-in Pragma expert first", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[
          expert,
          {
            ...expert,
            ref: "expert:0000000000pragma",
            id: "0000000000pragma",
            name: "Pragma",
            origin: "built-in",
            readOnly: true,
            model: null,
          },
        ]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html.indexOf("expert:0000000000pragma")).toBeLessThan(
      html.indexOf("expert:test_expert"),
    );
  });
});

describe("ExpertEditorFragment", () => {
  const draft = { ...expert, tagInput: "", pluginSecretMutations: {} };

  it("does not expose semantic identity fields during an ordinary edit", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).not.toContain("<label>Version");
    expect(html).not.toContain("test_expert");
    expect(html).toContain("Back to expert details");
    expect(html).not.toContain("Update this reusable expert declaration.");
    expect(html).toContain('class="creator-avatar-button"');
    expect(html).toContain('aria-label="Choose avatar"');
    expect(html).toContain('data-avatar-profile="pragma.avatar.expert.11"');
    expect(html).not.toContain('class="expert-avatar-field"');
    expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-current="step"/);
  });

  it("keeps creation steps sequential", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="create"
        initialValue={draft}
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
    expect(html).toContain("Build a reusable expert to power missions.");
  });

  it("opens an edit directly on the capabilities step when requested", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        initialStep="capabilities"
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).toContain("Add capabilities");
    expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*>[\s\S]*Capabilities<\/button>/);
  });
});
