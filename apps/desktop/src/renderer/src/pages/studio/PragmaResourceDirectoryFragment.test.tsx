import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { User } from "@phosphor-icons/react";

import {
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  type PragmaFlowResource,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
} from "@pragma/interpreter/ast";
import type {
  ContextStore,
  DesktopRuntimeAvailability,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { filterPragmaResourcePickerItems } from "../../components/PragmaResourcePickerDialog.tsx";

import {
  deletePragmaResourceErrorMessage,
  matchesResourceDirectoryQuery,
  PragmaResourceDetailFragment,
  PragmaResourceDirectoryFragment,
  TeamEditor,
} from "./PragmaResourceDirectoryFragment.tsx";
import { createEmptyFlow } from "./flow-editor/flow-model.ts";
import type { ExpertRecord } from "./studio-model.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

function expert(index: number): PragmaExpertResource {
  const id = String(index).padStart(16, "0");
  return PragmaExpertResourceSchema.parse({
    apiVersion: "pragma/v4",
    kind: "Expert",
    metadata: {
      id,
      name: `Expert ${String(index).padStart(3, "0")}`,
      description: `Specialist description ${index}`,
      tags: index === 99 ? ["needle"] : [],
    },
    spec: { scope: "general", instructions: "General expert." },
  });
}

function studioExpert(index: number): ExpertRecord {
  const id = String(index).padStart(16, "0");
  return {
    id,
    ref: `expert:${id}`,
    avatarId: "pragma.avatar.expert.default",
    name: `Expert ${String(index).padStart(3, "0")}`,
    description: `Specialist description ${index}`,
    tags: [],
    scope: "general",
    instructions: "General expert.",
    additionalInstructions: "",
    origin: "project",
    readOnly: false,
    customized: false,
    model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-5" },
    capabilities: [],
    toolApprovals: {},
    skills: index,
    tools: index + 1,
    mcpServers: 0,
    contextStoreMounts: [],
    resourceTools: [],
    plugins: [],
    usesApproval: false,
    icon: User,
  };
}

describe("expert team editor", () => {
  it("keeps large expert and knowledge collections behind compact picker triggers", () => {
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: Array.from({ length: 100 }, (_, index) => expert(index)),
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(3);
    expect(html).not.toContain("Expert 099");
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('class="secondary-button"');
  });

  it("keeps unselected knowledge bases out of the team form until the picker opens", () => {
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;
    const contextStore: ContextStore = {
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
    };

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        contextStores={[contextStore]}
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Team knowledge bases");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Quality handbook");
    expect(html).not.toContain('placeholder="Search context stores"');
  });

  it("keeps team knowledge as one selector card", () => {
    const experts = [expert(1), expert(2)];
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000002" }],
        contextStores: [
          {
            ref: "context-store:01h8j2k3m4n5p6q7",
            namespace: "quality_docs",
            visibility: { mode: "blacklist", expertIds: ["0000000000000002"] },
          },
        ],
        delegation: {},
      },
    });
    const contextStore: ContextStore = {
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
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        initial={initial}
        mode="edit"
        contextStores={[contextStore]}
        contextStoreBindings={[
          {
            storeId: contextStore.id,
            resourceRef: "context-store:01h8j2k3m4n5p6q7",
          },
        ]}
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Quality handbook");
    expect(html).toContain("1 knowledge base selected");
    expect(html).toContain("team-knowledge-selector");
    expect(html).not.toContain("team-context-editor");
    expect(html).not.toContain("team-context-expert-checkbox");
  });

  it("searches team experts by name, id, description, and tags without losing later pages", () => {
    const experts = Array.from({ length: 100 }, (_, index) => expert(index));
    const items = experts.map((item) => ({
      ref: `expert:${item.metadata.id}`,
      name: item.metadata.name,
      description: item.metadata.description,
      searchTerms: [item.metadata.id, ...item.metadata.tags],
      kind: "expert" as const,
    }));

    expect(filterPragmaResourcePickerItems(items, "", "all")).toHaveLength(100);
    expect(
      filterPragmaResourcePickerItems(items, "0000000000000042", "expert").map((item) => item.ref),
    ).toEqual(["expert:0000000000000042"]);
    expect(
      filterPragmaResourcePickerItems(items, "description 42", "expert").map((item) => item.ref),
    ).toEqual(["expert:0000000000000042"]);
    expect(
      filterPragmaResourcePickerItems(items, "needle", "expert").map((item) => item.ref),
    ).toEqual(["expert:0000000000000099"]);
  });

  it("shows and preserves optional Team instructions", () => {
    const experts = [expert(1), expert(2)];
    const instructions = "Verify evidence before declaring work complete.";
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: ["quality"],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [
          { ref: "expert:0000000000000002" },
          { ref: "expert:0000000000000003" },
          { ref: "expert:0000000000000004" },
          { ref: "expert:0000000000000005" },
        ],
        instructions,
        delegation: {},
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        initial={initial}
        mode="edit"
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Team instructions (optional)");
    expect(html).toContain(instructions);
    expect(html).toContain("always-on TEAM.md");
    expect(html).not.toContain("Version");
    expect(html).toContain("pragma-resource-editor-header");
    expect(html).not.toContain("canonical Pragma YAML");
  });
});

describe("PragmaResourceDirectoryFragment", () => {
  it("opens Team resources through a detail-first directory row", () => {
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: ["quality"],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [
          { ref: "expert:0000000000000002" },
          { ref: "expert:0000000000000003" },
          { ref: "expert:0000000000000004" },
          { ref: "expert:0000000000000005" },
        ],
        delegation: {},
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDirectoryFragment
        kind="team"
        project={project}
        onOpen={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(html).toContain("Quality team");
    expect(html).toContain('class="expert-team-card"');
    expect(html).toContain("Expert members");
    expect(html).toContain("+2");
    expect(html).not.toContain("expert-team-card-stats");
    expect(html).not.toContain("Coordinator");
    expect(html).not.toContain("Max concurrency");
    expect(html).not.toContain(">Configured</em>");
    expect(html.indexOf('class="expert-team-card-members"')).toBeLessThan(
      html.indexOf('class="expert-team-card-tags"'),
    );
    expect(html).not.toContain("Edit expert team");
    expect(html).not.toContain("Validate &amp; publish");
    expect(html).toContain('placeholder="Search expert teams"');
    expect(html).toContain("1 expert team");
  });

  it("uses the same searchable directory structure for Flows", () => {
    const flow = createEmptyFlow("ffdfk2cczgqjda7q");
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [flow],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDirectoryFragment
        kind="flow"
        project={project}
        onOpen={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(html).toContain('placeholder="Search flows"');
    expect(html).toContain("1 flow");
  });

  it("matches resource names, ids, descriptions, tags, and canonical refs", () => {
    const flow = {
      ...createEmptyFlow("ffdfk2cczgqjda7q"),
      metadata: {
        id: "ffdfk2cczgqjda7q",
        name: "Approval flow",
        description: "Coordinates manual review",
        tags: ["governance"],
      },
    } satisfies PragmaFlowResource;

    expect(matchesResourceDirectoryQuery(flow, "approval")).toBe(true);
    expect(matchesResourceDirectoryQuery(flow, "manual review")).toBe(true);
    expect(matchesResourceDirectoryQuery(flow, "governance")).toBe(true);
    expect(matchesResourceDirectoryQuery(flow, "flow:ffdfk2cczgqjda7q")).toBe(true);
    expect(matchesResourceDirectoryQuery(flow, "missing")).toBe(false);
  });
});

describe("PragmaResourceDetailFragment", () => {
  it.each([
    ["en", "Expert “Code reviewer”", "Flow “Issue reporter”", "1 more resource"],
    ["zh-Hans", "专家“Code reviewer”", "流程“Issue reporter”", "另外1个资源"],
    ["zh-Hant", "專家「Code reviewer」", "流程「Issue reporter」", "另外1個資源"],
  ] as const)(
    "localizes and truncates referenced-resource deletion errors in %s",
    async (locale, first, second, remainder) => {
      await i18n.changeLanguage(locale);
      const message = deletePragmaResourceErrorMessage(
        {
          code: "resource_referenced",
          message: "Raw backend message",
          diagnostics: [],
          referencedBy: [
            { ref: "expert:0000000000000001", name: "Code reviewer" },
            { ref: "flow:ffdfk2cczgqjda7q", name: "Issue reporter" },
            { ref: "automation:hrxn3mv2e991j2rj", name: "Nightly cleanup" },
          ],
        },
        i18n.getFixedT(locale, "studio"),
      );

      expect(message).toContain(first);
      expect(message).toContain(second);
      expect(message).toContain(remainder);
      expect(message).not.toContain("Nightly cleanup");
      expect(message).not.toContain("Raw backend message");
    },
  );

  it("uses a localized fallback when reference details are unavailable", async () => {
    await i18n.changeLanguage("zh-Hans");
    expect(
      deletePragmaResourceErrorMessage(
        {
          code: "resource_referenced",
          message: "Raw backend message",
          diagnostics: [],
        },
        i18n.getFixedT("zh-Hans", "studio"),
      ),
    ).toBe("该资源仍被其他资源引用，无法删除。请先移除相关依赖关系。");
  });

  it("shows Team details with edit and delete actions", () => {
    const experts = [expert(1), expert(2)];
    const studioExperts = [
      {
        ...studioExpert(1),
        model: {
          runtimeId: "pi",
          providerId: "ad0aa84a-2057-4074-b138-408099ecac0a",
          modelId: "deepseek-v3",
        },
      },
      studioExpert(2),
    ];
    const runtimes = [
      {
        id: "pi",
        revision: 1,
        origin: "built-in",
        adapter: { id: "pi", version: "1.0.0" },
        isDefault: true,
        kind: "built-in",
        displayName: "Built-in Runtime",
        status: "available",
        models: [
          {
            id: "deepseek-v3",
            displayName: "DeepSeek V3",
            provider: {
              kind: "registered",
              id: "ad0aa84a-2057-4074-b138-408099ecac0a",
              displayName: "DeepSeek",
            },
          },
        ],
      },
    ] satisfies readonly DesktopRuntimeAvailability[];
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000002" }],
        instructions: `# Evidence review

**Verify** evidence before declaring work complete.

> *Important note:* keep evidence traceable.

- [x] Read evidence
- Summarize findings

Use \`team:quality\` for the handoff.

| Check | Status |
| --- | --- |
| Evidence | Complete |

[Open evidence](https://example.com)

![evidence diagram](https://example.com/evidence.png)

\`\`\`ts
const complete = true;
\`\`\`

<script>window.alert("unsafe")</script>
<img src=x onerror="window.alert('unsafe-image')">`,
        contextStores: [
          {
            ref: "context-store:01h8j2k3m4n5p6q7",
            namespace: "quality_docs",
            visibility: {
              mode: "blacklist",
              expertIds: ["0000000000000002"],
            },
          },
        ],
        delegation: { maxConcurrency: 2, maxDepth: 5 },
      },
    });
    const contextStore: ContextStore = {
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
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, team],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={team}
        project={project}
        experts={studioExperts}
        runtimes={runtimes}
        contextStores={[contextStore]}
        contextStoreBindings={[
          {
            storeId: contextStore.id,
            resourceRef: "context-store:01h8j2k3m4n5p6q7",
          },
        ]}
        onOpenExpert={() => undefined}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Back to teams");
    expect(html).toContain("Edit expert team");
    expect(html).toContain("Quality team");
    expect(html.match(/data-avatar-profile="pragma.avatar.expert.11"/g)).toHaveLength(3);
    expect(html).toContain("Expert 001");
    expect(html).toContain("Team experts");
    expect(html).toContain("Specialist description 1");
    expect(html).toContain("Runtime");
    expect(html).toContain("DeepSeek V3");
    expect(html).not.toContain("ad0aa84a-2057-4074-b138-408099ecac0a");
    expect(html).toContain("View expert details");
    expect(html.match(/class="team-expert-link"/g)).toHaveLength(2);
    expect(html).not.toContain("expert:0000000000000001");
    expect(html).not.toContain("expert:0000000000000002");
    expect(html).toContain("2 members");
    expect(html).toContain("Delete");
    expect(html).toContain("Quality handbook");
    expect(html).toContain("All experts");
    expect(html.indexOf("Quality handbook")).toBeLessThan(html.indexOf("Team instructions"));
    expect(html).toContain("<h1>Evidence review</h1>");
    expect(html).toContain("<strong>Verify</strong>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<em>Important note:</em>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<code>team:quality</code>");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<th>Check</th>");
    expect(html).toContain("<td>Complete</td>");
    expect(html).toContain('href="https://example.com" target="_blank" rel="noreferrer"');
    expect(html).toContain('class="markdown-image-placeholder"');
    expect(html).toContain("[Image: evidence diagram]");
    expect(html).toContain('<code class="language-ts">const complete = true;</code>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('src="https://example.com/evidence.png"');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('window.alert("unsafe")');
    expect(html).not.toContain("unsafe-image");

    const teamWithoutInstructions = PragmaExpertTeamResourceSchema.parse({
      ...team,
      spec: { ...team.spec, instructions: undefined },
    });
    const emptyInstructionsHtml = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={teamWithoutInstructions}
        project={{ ...project, resources: [...experts, teamWithoutInstructions] }}
        experts={studioExperts}
        runtimes={runtimes}
        onOpenExpert={() => undefined}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(emptyInstructionsHtml).toContain("No instructions provided.");
    expect(emptyInstructionsHtml).not.toContain("team-instructions-markdown");

    const whitespaceTeam = {
      ...team,
      spec: { ...team.spec, instructions: "   \n  " },
    } as unknown as PragmaExpertTeamResource;
    const whitespaceInstructionsHtml = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={whitespaceTeam}
        project={{ ...project, resources: [...experts, whitespaceTeam] }}
        experts={studioExperts}
        runtimes={runtimes}
        onOpenExpert={() => undefined}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(whitespaceInstructionsHtml).toContain("No instructions provided.");
    expect(whitespaceInstructionsHtml).not.toContain("team-instructions-markdown");
  });

  it("shows Flow details before opening the Flow editor", () => {
    const flow: PragmaFlowResource = {
      ...createEmptyFlow("ffdfk2cczgqjda7q"),
      metadata: {
        id: "ffdfk2cczgqjda7q",
        name: "Approval flow",
        description: "Coordinates approval.",
        tags: [],
      },
      spec: {
        limits: { maxNodeVisits: 20 },
        graph: {
          start: "approval",
          steps: {
            approval: { action: { ref: "action:approval@1.0.0" } },
          },
          loops: {},
          transitions: { approval: { end: true } },
        },
      },
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [flow],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={flow}
        project={project}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Back to flows");
    expect(html).toContain("Edit flow");
    expect(html).toContain("Approval flow");
    expect(html).toContain("approval");
    expect(html).toContain("1 step");
    expect(html).toContain("1 transition");
    expect(html).not.toContain("Flow editor");
  });

  it("renders linked Expert and Expert Team nodes with their names and avatars", () => {
    const assignedExpert = expert(1);
    const assignedTeam = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work.",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000001" }],
        contextStores: [],
        delegation: {},
      },
    });
    const flow: PragmaFlowResource = {
      ...createEmptyFlow("ffdfk2cczgqjda7q"),
      metadata: {
        id: "ffdfk2cczgqjda7q",
        name: "Review flow",
        description: "Routes work to the appropriate collaborator.",
        tags: [],
      },
      spec: {
        limits: { maxNodeVisits: 20 },
        graph: {
          start: "review",
          steps: {
            review: { expert: { ref: "expert:0000000000000001" } },
            coordinate: { team: { ref: "team:cccvf3nab91n2wja" } },
          },
          loops: {},
          transitions: { review: { goto: "coordinate" }, coordinate: { end: true } },
        },
      },
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [assignedExpert, assignedTeam, flow],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={flow}
        project={project}
        experts={[studioExpert(1)]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Expert 001");
    expect(html).toContain("Quality team");
    expect(html).toContain("pragma-avatar");
    expect(html).not.toContain("expert:0000000000000001");
    expect(html).not.toContain("team:cccvf3nab91n2wja");
  });
});
