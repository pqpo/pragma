import { ExpertDefinitionSchema } from "../../../../shared/contracts/index.ts";
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
  schemaVersion: "pragma.context-store/v5",
  writeApprovalMode: "required",
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
    schemaVersion: "pragma.capability/v4",
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
    schemaVersion: "pragma.capability/v4",
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
        experts={[]}
        resources={[]}
        runtimes={[runtime]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("Thinking depth");
    expect(html).toContain(">High</strong>");
  });

  it("shows required Pragma Skills in the expert detail", () => {
    const skill: Capability = {
      ...skillCapability,
      manifest: { ...skillCapability.manifest, id: "1h2j3k4m5n6p7q8r", name: "Manage Pragma" },
    };
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          persisted: ExpertDefinitionSchema.parse({
            ...expert,
            schemaVersion: "pragma.desktop-expert-view/v1",
            ref: "expert:0000000000pragma",
            id: "0000000000pragma",
            executionProfile: { mode: "system-default" },
            revision: 1,
            createdAt: "2026-10-10T00:00:00.000Z",
            updatedAt: "2026-10-10T00:00:00.000Z",
            opaqueCapabilities: [{ kind: "skill", ref: "capability:1h2j3k4m5n6p7q8r" }],
          }),
        }}
        contextStores={[]}
        capabilities={[skill]}
        experts={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );
    expect(html).toContain("Manage Pragma · required system skill");
    expect(html).not.toContain(skill.manifest.id);
  });

  it("renders selected capability titles as plain comma-separated text", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          contextStoreMounts: [{ storeId: contextStore.id, enabled: true, priority: 0 }],
          capabilities: [
            { kind: "skill", capabilityId: skillCapability.manifest.id },
            {
              kind: "tools",
              capabilityId: toolCapability.manifest.id,
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
        experts={[]}
        resources={resources}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("Research Expert、Release Expert");
    expect(html).toContain("Product Docs");
    expect(html).toContain("Writing Skill");
    expect(html).toContain("search_docs、save_note");
    expect(html).not.toContain("Research Plugin");
    expect(html.match(/expert-capability-detail-selection-text/g)).toHaveLength(3);
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
        experts={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
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
    expect(html.match(/class="studio-action-button"/g)).toHaveLength(3);
    expect(html.match(/role="tooltip"/g)).toHaveLength(3);
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
        experts={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).not.toContain("Delete expert");
    expect(html).toContain("Customize");
    expect(html).not.toContain("Use as template");
    expect(html).toContain("Reset to default");
    expect(html).not.toContain("Configure knowledge");
    expect(html).toContain("Use in session");
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
        experts={[]}
        resources={[]}
        runtimes={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onOpenContextStore={() => undefined}
        onUseInSession={() => undefined}
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
  it("shows loading instead of a false empty state while experts are unresolved", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[]}
        loading
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("loading");
    expect(html).not.toContain("No experts available");
  });

  it("does not report an empty catalog when loading failed", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[]}
        loadFailed
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).not.toContain("No experts available");
  });

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

  it("keeps Pragma first and Store Revision second", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[
          expert,
          {
            ...expert,
            ref: "expert:0000000000st0rev",
            id: "0000000000st0rev",
            name: "Store Revision Agent",
            origin: "built-in",
            readOnly: true,
            model: null,
          },
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
      html.indexOf("expert:0000000000st0rev"),
    );
    expect(html.indexOf("expert:0000000000st0rev")).toBeLessThan(
      html.indexOf("expert:test_expert"),
    );
  });
});

describe("ExpertEditorFragment", () => {
  const draft = { ...expert, tagInput: "" };

  it.each([
    ["test", "test", false],
    ["removed-model", "test", true],
    ["test", "removed-provider", true],
  ] as const)(
    "only labels a saved model unavailable when missing (%s / %s)",
    (modelId, providerId, missing) => {
      const html = renderToStaticMarkup(
        <ExpertEditorFragment
          mode="edit"
          initialStep="model"
          initialValue={{ ...draft, model: { runtimeId: "test", modelId, providerId } }}
          runtimes={[
            {
              id: "test",
              kind: "codex-local",
              displayName: "Codex",
              isDefault: true,
              status: "available",
              models: [
                {
                  id: "test",
                  displayName: "Test Model",
                  provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
                },
              ],
            },
          ]}
          contextStores={[]}
          capabilities={[]}
          experts={[]}
          resources={[]}
          memoryEnabled={true}
          onCancel={() => undefined}
          onCreated={async () => undefined}
        />,
      );
      expect(html.includes(`Unavailable: ${modelId}`)).toBe(missing);
      expect(html).toContain("Test Model");
      if (!missing) expect(html).toContain("Select a model");
    },
  );

  it.each([
    ["en", "1 model", "unavailable"],
    ["zh-Hans", "1 个模型", "不可用"],
    ["zh-Hant", "1 個模型", "無法使用"],
  ])(
    "shows runtime choices with logos, counts and availability in %s",
    async (locale, count, unavailable) => {
      await i18n.changeLanguage(locale);
      const runtime: DesktopRuntimeAvailability = {
        id: "test",
        kind: "codex-local",
        displayName: "My Codex",
        isDefault: true,
        status: "available",
        models: [
          {
            id: "test",
            displayName: "Test Model",
            provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
          },
        ],
      };
      const html = renderToStaticMarkup(
        <ExpertEditorFragment
          mode="edit"
          initialStep="model"
          initialValue={draft}
          runtimes={[
            runtime,
            { ...runtime, id: "offline", displayName: "Offline Runtime", status: "unavailable" },
          ]}
          contextStores={[]}
          capabilities={[]}
          experts={[]}
          resources={[]}
          memoryEnabled={true}
          onCancel={() => undefined}
          onCreated={async () => undefined}
        />,
      );
      expect(html).toContain('role="radiogroup"');
      expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="test"/);
      expect(html).toMatch(/type="radio"[^>]*disabled=""[^>]*value="offline"/);
      expect(html).toContain("My Codex");
      expect(html).toContain('class="runtime-logo"');
      expect(html).toContain(count);
      expect(html).toContain(`<small>${unavailable}</small>`);
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain('role="combobox"');
    },
  );

  it.each([
    [undefined, "Full access"],
    ["read-only", "Read only"],
  ] as const)(
    "shows the Harness default or saved mode (%s) next to the model",
    (permissionModeId, label) => {
      const html = renderToStaticMarkup(
        <ExpertEditorFragment
          mode="edit"
          initialStep="model"
          initialValue={{
            ...draft,
            model: {
              ...draft.model!,
              ...(permissionModeId === undefined ? {} : { permissionModeId }),
            },
          }}
          runtimes={[
            {
              id: "test",
              kind: "test",
              displayName: "Harness",
              isDefault: true,
              status: "available",
              models: [],
              permissionModes: {
                defaultModeId: "full-access",
                modes: [
                  {
                    id: "full-access",
                    label: "Full access",
                    description: "Native full access",
                    available: true,
                  },
                  {
                    id: "read-only",
                    label: "Read only",
                    description: "Native sandbox",
                    available: true,
                  },
                ],
              },
            },
          ]}
          contextStores={[]}
          capabilities={[]}
          experts={[]}
          resources={[]}
          memoryEnabled={true}
          onCancel={() => undefined}
          onCreated={async () => undefined}
        />,
      );
      expect(html).toContain("Configure model");
      expect(html).toContain('aria-label="Permission mode"');
      expect(html).toContain('aria-label="Thinking level"');
      expect(html).not.toContain("Experts, teams &amp; flows");
      expect(html).not.toContain("Memory policy");
      expect(html).toContain(label);
      expect(html).toContain("Managed tools, including MCP tools, use separate approval policies");
      expect(html).not.toContain("Plan mode");
    },
  );

  it.each([
    [
      "en",
      "auto-approve",
      "Edit and run commands",
      "For editing files and running commands without approval.",
      "Commands can still access the network and external files; this is not a sandbox.",
    ],
    [
      "zh-Hans",
      "auto-approve",
      "编辑与命令免审批",
      "适合直接修改文件、运行命令的任务，两者无需审批。",
      "命令仍可联网或访问外部文件，并非沙箱隔离",
    ],
    [
      "zh-Hant",
      "auto-approve",
      "編輯與命令免審批",
      "適合直接修改檔案、執行命令的任務，兩者無需審批。",
      "命令仍可連網或存取外部檔案，並非沙箱隔離",
    ],
    [
      "en",
      "request-approval",
      "Ask for approval",
      "For reviewing actions yourself.",
      "Approved commands can still access the network and external files; this is not a sandbox.",
    ],
    [
      "zh-Hans",
      "request-approval",
      "请求审批",
      "适合希望亲自确认操作的任务。",
      "获批的命令仍可联网或访问外部文件，并非沙箱隔离",
    ],
    [
      "zh-Hant",
      "request-approval",
      "請求審批",
      "適合希望親自確認操作的任務。",
      "獲批的命令仍可連網或存取外部檔案，並非沙箱隔離",
    ],
    [
      "en",
      "full-access",
      "Full access",
      "For tasks that need web tools or files outside the workspace.",
      "explicit deny rules still apply",
    ],
    [
      "zh-Hans",
      "full-access",
      "完全访问",
      "适合需要网页工具或工作区外文件的任务。",
      "显式禁止规则仍然生效",
    ],
    [
      "zh-Hant",
      "full-access",
      "完全存取",
      "適合需要網頁工具或工作區外檔案的任務。",
      "明確禁止規則仍然生效",
    ],
  ])(
    "explains OpenCode permissions in %s for %s",
    async (locale, permissionModeId, label, description, boundary) => {
      await i18n.changeLanguage(locale);
      const html = renderToStaticMarkup(
        <ExpertEditorFragment
          mode="edit"
          initialStep="model"
          initialValue={{ ...draft, model: { ...draft.model!, permissionModeId } }}
          runtimes={[
            {
              id: "test",
              kind: "opencode-local",
              displayName: "OpenCode",
              isDefault: true,
              status: "available",
              models: [],
              permissionModes: {
                defaultModeId: "full-access",
                modes: [
                  {
                    id: permissionModeId,
                    label: "Accept edits",
                    description: "Untranslated runtime description",
                    available: true,
                  },
                ],
              },
            },
          ]}
          contextStores={[]}
          capabilities={[]}
          experts={[]}
          resources={[]}
          memoryEnabled={true}
          onCancel={() => undefined}
          onCreated={async () => undefined}
        />,
      );
      expect(html).toContain(label);
      expect(html).toContain(boundary);
      expect(html).toContain(`<small class="field-hint">${description}`);
      expect(html).toContain("expert-permission-menu");
      expect(html).not.toContain("Untranslated runtime description");
      expect(html).not.toContain("禁用命令");
      expect(html).not.toContain("停用命令");
    },
  );

  describe.each(["en", "zh-Hans", "zh-Hant"])("runtime permission copy in %s", (locale) => {
    it.each([
      [
        "codex-local",
        "full-access",
        true,
        ["Full access without approval", "完全访问（免审批）", "完全存取（免審批）"],
      ],
      [
        "codex-local",
        "request-approval",
        true,
        [
          "Workspace sandbox; ask to expand",
          "工作区沙箱（越界时询问）",
          "工作區沙箱（越界時詢問）",
        ],
      ],
      [
        "codex-local",
        "read-only",
        true,
        ["Read only; no file changes", "只读（禁止写入）", "唯讀（禁止寫入）"],
      ],
      [
        "codex-local",
        "auto-review",
        false,
        ["Automatically review sandbox requests", "自动审核越界请求", "自動審核越界請求"],
      ],
      [
        "claude-code-local",
        "bypassPermissions",
        true,
        ["Run without approval", "免审批执行", "免審批執行"],
      ],
      [
        "claude-code-local",
        "default",
        true,
        ["Ask when permission is needed", "需要权限时询问", "需要權限時詢問"],
      ],
      [
        "claude-code-local",
        "auto",
        true,
        ["Automatic risk review", "自动风险审核", "自動風險審核"],
      ],
      [
        "qodercli-local",
        "bypassPermissions",
        true,
        ["Run without approval", "免审批执行", "免審批執行"],
      ],
      [
        "qodercli-local",
        "default",
        true,
        ["Ask when permission is needed", "需要权限时询问", "需要權限時詢問"],
      ],
      [
        "qodercli-local",
        "auto",
        true,
        ["Let Qoder decide permissions", "由 Qoder 判断权限", "由 Qoder 判斷權限"],
      ],
      [
        "cloud-pi-agent",
        "full-access",
        true,
        ["Run with host permissions", "使用宿主权限执行", "使用宿主權限執行"],
      ],
      [
        "antigravity-local",
        "full-access",
        true,
        ["Full access without approval", "完全访问（免审批）", "完全存取（免審批）"],
      ],
      [
        "antigravity-local",
        "request-approval",
        true,
        ["Ask before changes and commands", "修改与命令先询问", "修改與命令先詢問"],
      ],
      [
        "antigravity-local",
        "native-auto",
        false,
        ["Automatically review sandbox requests", "自动审核沙箱请求", "自動審核沙箱請求"],
      ],
    ] as const)(
      "explains %s / %s and retains availability",
      async (kind, permissionModeId, available, titles) => {
        await i18n.changeLanguage(locale);
        const html = renderToStaticMarkup(
          <ExpertEditorFragment
            mode="edit"
            initialStep="model"
            initialValue={{ ...draft, model: { ...draft.model!, permissionModeId } }}
            runtimes={[
              {
                id: "test",
                kind,
                displayName: kind,
                isDefault: true,
                status: "available",
                models: [],
                permissionModes: {
                  defaultModeId: permissionModeId,
                  modes: [
                    {
                      id: permissionModeId,
                      label: "Untranslated native title",
                      description: "Untranslated native explanation",
                      available,
                      ...(available
                        ? {}
                        : { reason: "Native approval reviewer integration is not connected." }),
                    },
                  ],
                },
              },
            ]}
            contextStores={[]}
            capabilities={[]}
            experts={[]}
            resources={[]}
            memoryEnabled={true}
            onCancel={() => undefined}
            onCreated={async () => undefined}
          />,
        );
        const title = titles[["en", "zh-Hans", "zh-Hant"].indexOf(locale)];
        expect(html).toContain(title);
        expect(html).not.toContain("Untranslated native");
        expect(html).not.toContain("Native approval reviewer integration is not connected.");
        const option = html
          .match(/<button[^>]*role="option"[^>]*>[\s\S]*?<\/button>/g)
          ?.find((markup) => markup.includes(title!));
        expect(option).toBeDefined();
        expect(option?.includes('disabled=""')).toBe(!available);
        if (!available)
          expect(html).toContain(
            locale === "en"
              ? "cannot currently be selected"
              : locale === "zh-Hans"
                ? "暂不可选"
                : "暫不可選",
          );
        if (kind === "codex-local" && permissionModeId === "request-approval")
          expect(html).toContain(
            locale === "en"
              ? "without asking each time"
              : locale === "zh-Hans"
                ? "无需逐次确认"
                : "無需逐次確認",
          );
        if (kind === "claude-code-local" && permissionModeId === "auto")
          expect(html).toContain(
            locale === "en"
              ? "fall back"
              : locale === "zh-Hans"
                ? "退回文件编辑免审批"
                : "退回檔案編輯免審批",
          );
        if (kind === "qodercli-local" && permissionModeId === "auto")
          expect(html).toContain(
            locale === "en"
              ? "still need your approval"
              : locale === "zh-Hans"
                ? "仍发起的审批请求"
                : "仍發起的審批請求",
          );
        if (kind === "cloud-pi-agent")
          expect(html).toContain(
            locale === "en"
              ? "only available mode"
              : locale === "zh-Hans"
                ? "仅支持此模式"
                : "僅支援此模式",
          );
        if (kind === "antigravity-local" && permissionModeId === "request-approval")
          expect(html).toContain(
            locale === "en"
              ? "approval does not remove"
              : locale === "zh-Hans"
                ? "批准操作也不会解除沙箱限制"
                : "批准操作也不會解除沙箱限制",
          );
      },
    );
  });

  it("does not expose semantic identity fields during an ordinary edit", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        experts={[]}
        resources={[]}
        memoryEnabled={true}
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
        experts={[]}
        resources={[]}
        memoryEnabled={true}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(5);
    expect(html).toContain("Build a reusable expert to power missions.");
    const navigation = html.match(/<ol class="creator-steps"[\s\S]*?<\/ol>/)?.[0] ?? "";
    const labels = [...navigation.matchAll(/<span>\d<\/span>([^<]+)<\/button>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["Identity", "Instructions", "Model", "Capabilities", "Review"]);
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
        experts={[]}
        resources={[]}
        memoryEnabled={true}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).toContain("Add capabilities");
    expect(html).not.toContain('aria-label="Runtime"');
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain('aria-label="Thinking level"');
    expect(html).not.toContain('aria-label="Permission mode"');
    expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*>[\s\S]*Capabilities<\/button>/);
  });

  it("exposes callable resources while customizing a built-in expert", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={{
          ...draft,
          ref: "expert:0000000000pragma",
          id: "0000000000pragma",
          origin: "built-in",
          readOnly: true,
          model: null,
        }}
        initialStep="capabilities"
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        experts={[]}
        resources={[]}
        memoryEnabled={true}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).toContain("Experts, teams &amp; flows");
    expect(html).toContain("Let this expert call other Pragma resources");
  });

  it("shows the memory policy on the capabilities step when global memory is enabled", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        initialStep="capabilities"
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        experts={[]}
        resources={[]}
        memoryEnabled={true}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).toContain("Memory policy");
  });

  it("hides the memory policy on the capabilities step when global memory is disabled", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        initialStep="capabilities"
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        experts={[]}
        resources={[]}
        memoryEnabled={false}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).not.toContain("Memory policy");
  });
});
